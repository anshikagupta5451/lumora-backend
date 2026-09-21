// Real AI skin analysis via the Gemini API's free tier — Google looks at
// the actual selfie and reasons about visible concerns, unlike the
// pixel-statistics fallback in faceAnalysis.ts. Returns null on any
// missing key / network / parsing / safety-block failure so the caller
// can fall back to the heuristic analyzer — the face-scan feature must
// keep working even without this configured or if Google's API is
// unavailable.
//
// Free-tier quotas turned out to be tighter than expected in practice —
// gemini-3.8-flash's free tier is only 20 requests/DAY, not per-minute.
// Check your own account's actual per-model limits at
// https://aistudio.google.com/rate-limit (they vary by account and
// change over time, so nothing here can hardcode them). A daily quota
// doesn't recover with a short retry, so this treats it differently from
// a transient 503/momentary rate limit: it gives up on that model
// immediately and, if GEMINI_FALLBACK_MODEL is set, tries a second model
// before dropping to the heuristic for the rest of the day.
//
// Requires env var GEMINI_API_KEY (get one free at aistudio.google.com).
// GEMINI_MODEL is optional (defaults to gemini-3.8-flash) and
// GEMINI_FALLBACK_MODEL is optional — set it to a model with separate
// quota (Google meters quota per model) once you've checked which ones
// your account can actually use.

import { CONCERN_DEFS, CONCERN_KEYS, ConcernKey, DETECTION_THRESHOLD, Detection } from "./skinConcerns";
import { ConcernScore } from "./faceAnalysis";

const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || null;
const REQUEST_TIMEOUT_MS = 20_000;

// Google's free-tier flash models return a transient 503 ("high demand")
// under load fairly often in practice — retrying a couple of times with a
// short backoff turns most of those into a success instead of silently
// dropping to the much less accurate heuristic fallback. 429 is only
// worth this short retry when it's a per-minute limit, not a daily one
// (see isDailyQuotaError below) — a daily quota is handled separately.
const MAX_ATTEMPTS_PER_MODEL = 3;
const RETRY_BACKOFF_MS = [800, 2000];
const RETRYABLE_STATUS = new Set([429, 500, 503]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Google's 429 body includes a QuotaFailure with a quotaId — daily quotas
// look like "...PerDay...FreeTier" and won't reset for hours, so retrying
// (even with backoff, even on a fresh model) within this request is
// pointless; per-minute/burst limits are worth the short retry above.
function isDailyQuotaError(bodyText: string): boolean {
  return /PerDay/i.test(bodyText);
}

if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "[gemini] GEMINI_API_KEY not set — face scans will use the offline heuristic analyzer instead of real AI analysis.",
  );
}

// Concerns that show up as visually localizable regions/spots — worth
// asking the model to draw boxes around. The other three (dryness,
// oiliness, dullness) are whole-face qualities with no single spot to
// point at, so we don't ask for boxes on those.
const LOCALIZABLE_KEYS: ConcernKey[] = ["darkCircles", "darkSpots", "acne"];
const MAX_DETECTIONS = 10;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", enum: CONCERN_KEYS },
          score: { type: "integer" },
          detected: { type: "boolean" },
          reasoning: { type: "string" },
        },
        required: ["key", "score", "detected", "reasoning"],
      },
    },
    detections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", enum: LOCALIZABLE_KEYS },
          box_2d: { type: "array", items: { type: "integer" }, minItems: 4, maxItems: 4 },
          note: { type: "string" },
        },
        required: ["key", "box_2d", "note"],
      },
    },
  },
  required: ["concerns", "detections"],
};

function buildPrompt(): string {
  const lines = CONCERN_KEYS.map(
    (key) => `- ${key}: ${CONCERN_DEFS[key].label}`,
  ).join("\n");
  const localizable = LOCALIZABLE_KEYS.join(", ");

  return `You are the skin-analysis step of a skincare app's face-scan feature. Look at the attached selfie and assess these visible skin concerns:
${lines}

For each concern, return a severity score from 0 (not visible at all) to 100 (very pronounced), a boolean "detected" (true when score >= ${DETECTION_THRESHOLD}), and one short sentence of reasoning grounded only in what you can actually see in the photo (lighting, discoloration, texture, shine) — never guess about the person's habits, age, or lifestyle.

Additionally, for concerns that appear as specific visible spots or regions (${localizable} only — never dryness, oiliness, or dullness, which are whole-face qualities with no single location), also return a "detections" array marking up to ${MAX_DETECTIONS} of the clearest individual instances you can actually see — e.g. each distinct dark spot, each visible blemish, the left and right under-eye region if dark circles are present. Each detection needs: "key" (one of ${localizable}), "box_2d" as [ymin, xmin, ymax, xmax] normalized 0-1000 relative to the full image, tightly framing just that spot/region, and a "note" of a few words. If none of those three concerns are visibly present, return an empty detections array — do not invent locations.

If the photo doesn't clearly show a face, or lighting/angle makes a concern impossible to judge, score it low, return no detections, and say so in the reasoning rather than guessing.

This is casual skincare guidance, not a medical or dermatological diagnosis — do not use clinical/diagnostic language.

Return exactly one "concerns" entry per concern key listed above.`;
}

interface GeminiConcernItem {
  key: string;
  score: number;
  detected: boolean;
  reasoning: string;
}

interface GeminiDetectionItem {
  key: string;
  box_2d: number[];
  note: string;
}

// A single attempt against one model. Returns the parsed scores, or a
// status (plus whether it's a non-recoverable-today daily quota) when the
// call reached Google but failed, or null for anything else (network
// error, bad parse).
async function attemptAnalysis(
  imageBuffer: Buffer,
  mimeType: string,
  apiKey: string,
  model: string,
): Promise<
  | { scores: ConcernScore[]; detections: Detection[] }
  | { status: number; isDailyQuota: boolean }
  | null
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inline_data: { mime_type: mimeType, data: imageBuffer.toString("base64") } },
                { text: buildPrompt() },
              ],
            },
          ],
          generationConfig: {
            response_mime_type: "application/json",
            response_schema: RESPONSE_SCHEMA,
          },
        }),
      },
    );

    if (!res.ok) {
      const bodyText = await res.text();
      console.error(`[gemini] ${model} request failed:`, res.status, bodyText);
      return { status: res.status, isDailyQuota: res.status === 429 && isDailyQuotaError(bodyText) };
    }

    const data: any = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error("[gemini] no text in response:", JSON.stringify(data).slice(0, 500));
      return null;
    }

    const parsed = JSON.parse(text) as {
      concerns?: GeminiConcernItem[];
      detections?: GeminiDetectionItem[];
    };
    const items = parsed.concerns;
    if (!Array.isArray(items)) return null;

    const scores = CONCERN_KEYS.map((key) => {
      const item = items.find((i) => i.key === key);
      const score = Math.max(0, Math.min(100, Math.round(item?.score ?? 0)));
      const result: ConcernScore = {
        key,
        label: CONCERN_DEFS[key as ConcernKey].label,
        score,
        detected: item?.detected ?? score >= DETECTION_THRESHOLD,
      };
      if (item?.reasoning) result.reasoning = item.reasoning;
      return result;
    });

    const rawDetections = Array.isArray(parsed.detections) ? parsed.detections : [];
    const detections: Detection[] = rawDetections
      .filter(
        (d): d is GeminiDetectionItem =>
          LOCALIZABLE_KEYS.includes(d?.key as ConcernKey) &&
          Array.isArray(d.box_2d) &&
          d.box_2d.length === 4,
      )
      .slice(0, MAX_DETECTIONS)
      .map((d) => ({
        key: d.key as ConcernKey,
        box: d.box_2d as [number, number, number, number],
        note: d.note || "",
      }));

    return { scores, detections };
  } catch (err) {
    console.error("[gemini] analysis failed:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Retries transient failures on one model; gives up immediately (no
// backoff) the moment a daily quota is hit, since waiting seconds can't
// fix that.
async function analyzeWithModel(
  imageBuffer: Buffer,
  mimeType: string,
  apiKey: string,
  model: string,
): Promise<{ scores: ConcernScore[]; detections: Detection[] } | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
    const result = await attemptAnalysis(imageBuffer, mimeType, apiKey, model);

    if (result && "scores" in result) return result;
    if (!result) return null;

    if (result.isDailyQuota) {
      console.error(`[gemini] ${model} has hit its free-tier daily quota — not retrying this model today`);
      return null;
    }

    const isLastAttempt = attempt === MAX_ATTEMPTS_PER_MODEL - 1;
    if (isLastAttempt || !RETRYABLE_STATUS.has(result.status)) return null;

    console.warn(
      `[gemini] ${model} retrying after status ${result.status} (attempt ${attempt + 2}/${MAX_ATTEMPTS_PER_MODEL})`,
    );
    await sleep(RETRY_BACKOFF_MS[attempt] ?? 2000);
  }

  return null;
}

export async function analyzeFaceWithGemini(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<{ scores: ConcernScore[]; detections: Detection[] } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const models = [PRIMARY_MODEL, FALLBACK_MODEL].filter((m): m is string => Boolean(m));

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    const result = await analyzeWithModel(imageBuffer, mimeType, apiKey, model);
    if (result) return result;

    const hasNext = i < models.length - 1;
    console.warn(
      hasNext
        ? `[gemini] ${model} unavailable — trying next option`
        : `[gemini] ${model} unavailable, falling back to heuristic`,
    );
  }

  return null;
}

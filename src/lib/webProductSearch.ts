// "From the web" product suggestions for a face scan, via Gemini.
//
// It first asks with Google Search grounding, so products and prices come
// from live web results and the source pages are returned. Grounding has
// no free-tier quota on most keys (it 429s immediately), so on any
// failure it falls back to an ungrounded call answered from the model's
// own product knowledge — the UI labels those prices as approximate. If
// billing is enabled on the key later, grounding starts working with no
// code change.
//
// Google meters free-tier quota per model (as low as 20 requests/day), so
// this uses its own models (GEMINI_SEARCH_MODEL, then a lite model) to
// avoid eating into face-scan analysis quota, and only falls back to the
// face-scan model if those fail. Individual models regularly 503 under
// load, which is why there's a chain rather than long retries. Callers must still cache the result
// — see webSuggestions on FaceScan in routes/recommendations.ts.

import { CONCERN_DEFS, ConcernKey } from "./skinConcerns";
import type { ConcernScore } from "./faceAnalysis";

const MODELS = [
  ...new Set([
    process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash",
    "gemini-3.5-flash-lite",
    process.env.GEMINI_MODEL || "gemini-3.8-flash",
  ]),
];
const REQUEST_TIMEOUT_MS = 40_000;
// A grounded call that hangs is usually an overloaded model; better to
// fall back than keep the user waiting.
const GROUNDED_TIMEOUT_MS = 25_000;
const RETRY_BACKOFF_MS = [1000];

export interface WebProduct {
  name: string;
  brand: string;
  approxPriceInr: number;
  keyIngredient: string;
  why: string;
}

export interface WebSearchResult {
  grounded: boolean;
  sources: { title: string; url: string }[];
  concerns: { key: string; products: WebProduct[] }[];
}

interface SearchInput {
  concerns: ConcernScore[];
  skinType: string | null;
  sensitivities: string[];
  budget: number | null;
  ownedNames: string[];
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    concerns: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          key: { type: "STRING" },
          products: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                brand: { type: "STRING" },
                approxPriceInr: { type: "NUMBER" },
                keyIngredient: { type: "STRING" },
                why: { type: "STRING" },
              },
              required: ["name", "brand", "approxPriceInr", "keyIngredient", "why"],
            },
          },
        },
        required: ["key", "products"],
      },
    },
  },
  required: ["concerns"],
};

function buildPrompt(input: SearchInput) {
  const concernLines = input.concerns
    .map((c) => `- key "${c.key}": ${CONCERN_DEFS[c.key as ConcernKey].label} (severity ${Math.round(c.score)}/100)`)
    .join("\n");
  const sensitivities = input.sensitivities.filter((s) => !/none/i.test(s));

  return `You are a skincare advisor for an app in India. Suggest real, currently sold skincare products for this person.

Skin concerns detected by a face scan:
${concernLines}

Skin type: ${input.skinType ?? "unknown"}
Sensitivities to avoid: ${sensitivities.length ? sensitivities.join(", ") : "none"}
Monthly skincare budget: ${input.budget != null ? `₹${input.budget} in total across all products` : "not set"}
Products they already own (do not suggest these): ${input.ownedNames.length ? input.ownedNames.join(", ") : "none"}

Rules:
- For each concern key above, give 3 products, from cheapest to more premium.
- Only products genuinely sold in India (e.g. on Nykaa, Amazon.in, brand sites), with a realistic current price in INR for the standard size.
${input.budget != null ? `- Every product must cost well under ₹${input.budget}; prefer options that let several products fit in that total.` : ""}
- Prefer well-known, dermatologist-trusted formulations with a clear active ingredient for that concern.
- "why" is one short sentence, specific to this concern and skin type.
- Never include products containing ingredients the person is sensitive to.

Respond ONLY with JSON in this exact shape, no markdown:
{"concerns":[{"key":"<concern key>","products":[{"name":"","brand":"","approxPriceInr":0,"keyIngredient":"","why":""}]}]}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Grounded replies can't use response_schema, so pull the first JSON
// object out of free text (it sometimes arrives wrapped in ```json).
function extractJson(text: string): any | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitize(parsed: any, validKeys: Set<string>): WebSearchResult["concerns"] | null {
  if (!Array.isArray(parsed?.concerns)) return null;
  const out = parsed.concerns
    .filter((c: any) => validKeys.has(c?.key) && Array.isArray(c.products))
    .map((c: any) => ({
      key: c.key as string,
      products: (c.products as any[])
        .filter(
          (p) =>
            typeof p?.name === "string" && p.name.trim() &&
            typeof p?.brand === "string" &&
            typeof p?.approxPriceInr === "number" && p.approxPriceInr > 0,
        )
        .slice(0, 4)
        .map((p) => ({
          name: p.name.trim(),
          brand: p.brand.trim(),
          approxPriceInr: Math.round(p.approxPriceInr),
          keyIngredient: typeof p.keyIngredient === "string" ? p.keyIngredient.trim() : "",
          why: typeof p.why === "string" ? p.why.trim() : "",
        })),
    }));
  return out.length ? out : null;
}

async function callGemini(
  model: string,
  apiKey: string,
  prompt: string,
  grounded: boolean,
): Promise<{ data: any } | { status: number }> {
  const body = grounded
    ? { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }
    : {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: "application/json", response_schema: RESPONSE_SCHEMA },
      };

  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(grounded ? GROUNDED_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
          body: JSON.stringify(body),
        },
      );
      if (res.ok) return { data: await res.json() };

      const text = await res.text();
      // Only a momentary overload is worth retrying; a 429 here is a
      // quota (daily, or grounding not allowed on this key).
      if (res.status === 503 || res.status === 500) {
        const wait = RETRY_BACKOFF_MS[attempt];
        if (wait != null) {
          await sleep(wait);
          continue;
        }
      }
      console.warn(`[web-search] ${model}${grounded ? " (grounded)" : ""} failed:`, res.status, text.slice(0, 200));
      return { status: res.status };
    } catch (err) {
      console.warn(`[web-search] ${model} request error:`, err);
      return { status: 0 };
    }
  }
  return { status: 0 };
}

export async function searchWebProducts(input: SearchInput): Promise<WebSearchResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || input.concerns.length === 0) return null;

  const prompt = buildPrompt(input);
  const validKeys = new Set(input.concerns.map((c) => c.key));
  // One grounded attempt on the first model (the one most likely to have
  // free grounding quota), then plain calls down the chain.
  const attempts = [
    { model: MODELS[0]!, grounded: true },
    ...MODELS.map((model) => ({ model, grounded: false })),
  ];

  for (const { model, grounded } of attempts) {
    const result = await callGemini(model, apiKey, prompt, grounded);
    if (!("data" in result)) continue;
    const candidate = result.data?.candidates?.[0];
    const text: string | undefined = candidate?.content?.parts
      ?.map((p: any) => p?.text ?? "")
      .join("");
    if (!text) continue;

    const concerns = sanitize(extractJson(text), validKeys);
    if (!concerns) {
      console.warn("[web-search] unparseable reply:", text.slice(0, 200));
      continue;
    }

    const sources = grounded
      ? ((candidate?.groundingMetadata?.groundingChunks ?? []) as any[])
          .map((c) => ({ title: String(c?.web?.title ?? ""), url: String(c?.web?.uri ?? "") }))
          .filter((s) => s.url)
          .slice(0, 5)
      : [];

    // Grounding is only real if Google actually returned web pages; the
    // model can answer a grounded request from memory without searching.
    return { grounded: sources.length > 0, sources, concerns };
  }
  return null;
}

// Last-resort product lookup via Gemini, for products that are neither in
// our catalog nor in Open Beauty Facts (common for Indian brands). The
// model only supplies data — which product it is and its ingredient list.
// Whether it suits the user is still decided by the rules in
// productVerdict.ts, so the verdict stays explainable.
//
// Same approach as webProductSearch.ts: one call with Google Search
// grounding (live web results), then ungrounded calls down a model chain
// answered from the model's own product knowledge. A barcode only gets
// the grounded call: without search the model can't know what a barcode
// is and would invent a product. Returns null without GEMINI_API_KEY or
// when nothing usable comes back, and the caller shows "not found".

const MODELS = [
  ...new Set([
    process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash",
    "gemini-3.5-flash-lite",
    process.env.GEMINI_MODEL || "gemini-3.8-flash",
  ]),
];
const GROUNDED_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 30_000;

const CATEGORIES = ["cleanser", "toner", "serum", "moisturizer", "sunscreen", "mask", "exfoliant", "eye cream", "lip care", "other"];
// Fewer than this and there's too little to judge the product on.
const MIN_INGREDIENTS = 3;

// Free-tier quota is tiny, so remember answers (including "not found")
// instead of asking again for the same product.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map<string, { at: number; value: AiProduct | null }>();

export interface AiProduct {
  name: string;
  brand: string;
  category: string | null;
  ingredients: string[];
  grounded: boolean;
  sources: { title: string; url: string }[];
}

export type AiLookupInput = { text: string } | { barcode: string };

export function aiLookupAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

function buildPrompt(input: AiLookupInput) {
  const what =
    "text" in input
      ? `Text read off the front of the pack by OCR (it may contain reading errors, and the biggest text comes first):\n"""\n${input.text}\n"""`
      : `Its barcode (EAN/UPC): ${input.barcode}`;
  return `You identify skincare products for a skincare app in India.

${what}

Find which real, currently sold skincare product this is, and its full ingredient list (INCI names, in label order).

Rules:
- Only answer if you can identify one specific product with reasonable confidence. Otherwise answer {"found": false}.
- Never guess or invent ingredients. If you don't know the actual ingredient list, answer {"found": false}.
- category is one of: ${CATEGORIES.join(", ")}.

Respond ONLY with JSON, no markdown:
{"found": true, "name": "", "brand": "", "category": "", "ingredients": [""]}`;
}

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

// Model output is untrusted: keep only well-formed fields, cap lengths,
// and reject answers too thin to judge a product on.
export function sanitizeAiProduct(parsed: any): Omit<AiProduct, "grounded" | "sources"> | null {
  if (parsed?.found !== true) return null;
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (name.length < 2 || name.length > 120) return null;
  const brand = typeof parsed.brand === "string" ? parsed.brand.trim().slice(0, 60) : "";
  const rawCategory = typeof parsed.category === "string" ? parsed.category.trim().toLowerCase() : "";
  const category = CATEGORIES.includes(rawCategory) && rawCategory !== "other" ? rawCategory : null;

  const ingredients = [
    ...new Set(
      (Array.isArray(parsed.ingredients) ? parsed.ingredients : [])
        .filter((i: unknown): i is string => typeof i === "string")
        .map((i: string) => i.trim().toLowerCase().replace(/[.*]+$/, ""))
        .filter((i: string) => i.length > 1 && i.length < 80 && !/unknown|not available|n\/a/.test(i)),
    ),
  ].slice(0, 60) as string[];
  if (ingredients.length < MIN_INGREDIENTS) return null;

  return { name, brand, category, ingredients };
}

async function callGemini(model: string, apiKey: string, prompt: string, grounded: boolean) {
  const body = grounded
    ? { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }
    : { contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: "application/json" } };
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
    if (!res.ok) {
      console.warn(`[ai-product] ${model}${grounded ? " (grounded)" : ""} failed:`, res.status, (await res.text()).slice(0, 200));
      return null;
    }
    return (await res.json()) as any;
  } catch (err) {
    console.warn(`[ai-product] ${model} request error:`, err);
    return null;
  }
}

function cacheKey(input: AiLookupInput) {
  return "barcode" in input
    ? `b:${input.barcode.trim()}`
    : `t:${input.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

export async function lookupProductWithAi(input: AiLookupInput): Promise<AiProduct | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if ("text" in input && input.text.trim().length < 3) return null;

  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value ? CACHE_TTL_MS : MISS_TTL_MS)) return hit.value;

  const prompt = buildPrompt(input);
  const attempts = [
    { model: MODELS[0]!, grounded: true },
    ...("text" in input ? MODELS.map((model) => ({ model, grounded: false })) : []),
  ];

  let value: AiProduct | null = null;
  // Only remember a miss when a model actually answered; a quota or
  // network failure should be retried on the next scan.
  let answered = false;
  for (const { model, grounded } of attempts) {
    const data = await callGemini(model, apiKey, prompt, grounded);
    const candidate = data?.candidates?.[0];
    const text: string | undefined = candidate?.content?.parts?.map((p: any) => p?.text ?? "").join("");
    if (!text) continue;
    answered = true;
    const parsed = extractJson(text);
    const product = sanitizeAiProduct(parsed);
    if (!product) {
      // A clear "not found" is an answer; asking another model just guesses.
      if (parsed?.found === false) break;
      console.warn("[ai-product] unusable reply:", text.slice(0, 200));
      continue;
    }
    const sources = grounded
      ? ((candidate?.groundingMetadata?.groundingChunks ?? []) as any[])
          .map((c) => ({ title: String(c?.web?.title ?? ""), url: String(c?.web?.uri ?? "") }))
          .filter((s) => s.url)
          .slice(0, 3)
      : [];
    value = { ...product, grounded: sources.length > 0, sources };
    break;
  }

  if (value || answered) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), value });
  }
  return value;
}

// For tests.
export function clearAiProductCache() {
  cache.clear();
}

// Product lookup in Open Beauty Facts (openbeautyfacts.org) — a free,
// open, crowd-sourced cosmetics database. No key, no AI. Used by the admin
// product form to prefill name, brand, ingredients, photo and barcode.
// It has no prices, and coverage of Indian brands is patchy, so results
// are a starting point the admin completes and corrects.

const BASE = "https://world.openbeautyfacts.org";
// OBF asks every client to identify itself.
const HEADERS = { "User-Agent": "Lumora/1.0 (admin product import)" };
const TIMEOUT_MS = 12_000;
const FIELDS =
  "code,product_name,product_name_en,brands,categories_tags,ingredients_text,ingredients_text_en,image_front_url,quantity";

export interface ProductDraft {
  barcode: string | null;
  name: string;
  brand: string;
  category: string | null; // best guess from OBF categories / name
  ingredients: string[];
  imageUrl: string | null;
  quantity: string | null;
}

const CATEGORY_HINTS: [string, RegExp][] = [
  ["sunscreen", /sun|spf|uv/],
  ["cleanser", /cleans|face.?wash|micellar/],
  ["toner", /toner|tonic/],
  ["serum", /serum|ampoule|essence/],
  ["moisturizer", /moistur|cream|lotion|gel|hydrat/],
];

function guessCategory(text: string) {
  const t = text.toLowerCase();
  return CATEGORY_HINTS.find(([, re]) => re.test(t))?.[0] ?? null;
}

// OBF ingredient text is one comma-separated string, sometimes with
// percentages, trailing periods or "Ingredients:" prefixes.
function splitIngredients(text: string | undefined) {
  if (!text) return [];
  return text
    .replace(/^\s*ingr[eé]dients?\s*:/i, "")
    .split(/,(?![^(]*\))/)
    .map((i) => i.replace(/[.*_]+$/g, "").replace(/_/g, "").trim().toLowerCase())
    .filter((i) => i.length > 1 && i.length < 80)
    .slice(0, 60);
}

function toDraft(p: any): ProductDraft | null {
  const name = String(p?.product_name_en || p?.product_name || "").trim();
  if (!name) return null;
  const brand = String(p?.brands || "").split(",")[0]!.trim();
  const tags: string[] = Array.isArray(p?.categories_tags) ? p.categories_tags : [];
  return {
    barcode: p?.code ? String(p.code) : null,
    name,
    brand,
    category: guessCategory(`${tags.join(" ")} ${name}`),
    ingredients: splitIngredients(p?.ingredients_text_en || p?.ingredients_text),
    imageUrl: p?.image_front_url || null,
    quantity: p?.quantity || null,
  };
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open Beauty Facts returned ${res.status}`);
  return res.json() as Promise<any>;
}

export async function lookupBarcode(code: string): Promise<ProductDraft | null> {
  const data = await getJson(`${BASE}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`);
  if (data?.status !== 1) return null;
  return toDraft({ ...data.product, code });
}

export async function searchProducts(query: string): Promise<ProductDraft[]> {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: "15",
    fields: FIELDS,
  });
  const data = await getJson(`${BASE}/cgi/search.pl?${params}`);
  const products: any[] = Array.isArray(data?.products) ? data.products : [];
  return products.map(toDraft).filter((d): d is ProductDraft => d != null);
}

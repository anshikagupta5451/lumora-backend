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
  "code,product_name,product_name_en,generic_name,generic_name_en,abbreviated_product_name,brands,categories_tags,ingredients_text,ingredients_text_en,ingredients_tags,image_front_url,quantity";

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

// UV filters only show up in sunscreens, so they identify one even when
// the OBF categories are just "non-food-products" and the name is useless.
const UV_FILTERS = /zinc oxide|titanium dioxide|avobenzone|octocrylene|homosalate|octinoxate|ethylhexyl methoxycinnamate|bis-ethylhexyloxyphenol|uvinul|tinosorb/;

function guessCategory(text: string, ingredients: string[]) {
  const t = text.toLowerCase();
  const fromText = CATEGORY_HINTS.find(([, re]) => re.test(t))?.[0];
  if (fromText) return fromText;
  return UV_FILTERS.test(ingredients.join(" ")) ? "sunscreen" : null;
}

// The same product scans as a 12-digit UPC-A on some phones and as a
// 13-digit EAN-13 (the UPC-A with a leading 0) on others, and either
// form may be the one stored in our catalog or in OBF.
export function barcodeVariants(code: string): string[] {
  const c = code.trim();
  if (/^\d{12}$/.test(c)) return [c, `0${c}`];
  if (/^0\d{12}$/.test(c)) return [c, c.slice(1)];
  return [c];
}

// OBF often files a name under the wrong language (e.g. Arabic script in
// product_name_en). Users read Latin script, so prefer any field that's
// mostly Latin letters.
function isMostlyLatin(s: string) {
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;
  const latin = letters.replace(/[^\p{Script=Latin}]/gu, "");
  return latin.length / letters.length >= 0.6;
}

function pickName(p: any, brand: string, category: string | null) {
  const candidates = [
    p?.product_name_en,
    p?.product_name,
    p?.abbreviated_product_name,
    p?.generic_name_en,
    p?.generic_name,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const latin = candidates.find(isMostlyLatin);
  if (latin) return latin;
  // No readable name: "Nivéa moisturizer" beats a name the user can't read.
  if (brand) return category ? `${brand} ${category}` : brand;
  return candidates[0] ?? "";
}

// Some products have a junk ingredients_text (e.g. just the brand name)
// next to a real list in ingredients_text_en, so take whichever splits
// into the most ingredients, then the structured tags as a last resort.
function pickIngredients(p: any) {
  const lists = [p?.ingredients_text_en, p?.ingredients_text].map(splitIngredients);
  const best = lists.reduce((a, b) => (b.length > a.length ? b : a), [] as string[]);
  if (best.length > 1) return best;
  const tags: string[] = Array.isArray(p?.ingredients_tags) ? p.ingredients_tags : [];
  const fromTags = tags
    .filter((t) => t.startsWith("en:"))
    .map((t) => t.slice(3).replace(/-/g, " ").trim())
    .filter((t) => t.length > 1);
  return fromTags.length > best.length ? fromTags.slice(0, 60) : best;
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
  const brand = String(p?.brands || "").split(",")[0]!.trim();
  const tags: string[] = Array.isArray(p?.categories_tags) ? p.categories_tags : [];
  const ingredients = pickIngredients(p);
  const rawNames = [p?.product_name_en, p?.product_name, p?.generic_name_en, p?.generic_name].join(" ");
  const category = guessCategory(`${tags.join(" ")} ${rawNames}`, ingredients);
  const name = pickName(p, brand, category);
  if (!name) return null;
  return {
    barcode: p?.code ? String(p.code) : null,
    name,
    brand,
    category,
    ingredients,
    imageUrl: p?.image_front_url || null,
    quantity: p?.quantity || null,
  };
}

async function getJson(url: string) {
  console.log(`[OBF] GET ${url}`);
  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.log(`[OBF] request failed:`, err);
    throw err;
  }
  console.log(`[OBF] status ${res.status}`);
  // An unknown barcode comes back as HTTP 404 with a normal JSON body
  // ({ status: 0, status_verbose: "product not found" }), so a 404 is an
  // answer, not a failure.
  if (!res.ok && res.status !== 404) throw new Error(`Open Beauty Facts returned ${res.status}`);
  return res.json() as Promise<any>;
}

export async function lookupBarcode(code: string): Promise<ProductDraft | null> {
  for (const variant of barcodeVariants(code)) {
    const data = await getJson(`${BASE}/api/v2/product/${encodeURIComponent(variant)}.json?fields=${FIELDS}`);
    console.log(`[OBF] raw response:`, JSON.stringify(data, null, 2));
    if (data?.status !== 1) {
      console.log(`[OBF] barcode ${variant} not found`);
      continue;
    }
    // Keep the barcode as scanned, so it matches what the phone reads next time.
    const draft = toDraft({ ...data.product, code });
    console.log(`[OBF] parsed draft:`, JSON.stringify(draft, null, 2));
    return draft;
  }
  return null;
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
  const drafts = products.map(toDraft).filter((d): d is ProductDraft => d != null);
  console.log(`[OBF] search "${query}": ${products.length} results, ${drafts.length} usable`);
  return drafts;
}

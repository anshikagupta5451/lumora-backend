// Tests for the AI product lookup used when a product is in neither our
// catalog nor Open Beauty Facts. globalThis.fetch is replaced by a stub, so
// no request leaves the process and no real API key is used or read.

import { test, describe, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  clearAiProductCache,
  lookupProductWithAi,
  sanitizeAiProduct,
} from "../src/lib/aiProductLookup";

const realFetch = globalThis.fetch;
const savedKey = process.env.GEMINI_API_KEY;
let calls: { url: string; body: any }[] = [];

function stubFetch(...responders: (() => Response | Promise<Response>)[]) {
  calls = [];
  let i = 0;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
    const r = responders[Math.min(i++, responders.length - 1)];
    if (!r) throw new Error("no stub response");
    return r();
  }) as typeof fetch;
}

function modelReply(payload: unknown, sources: string[] = []) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const candidate: any = { content: { parts: [{ text }] } };
  if (sources.length) {
    candidate.groundingMetadata = { groundingChunks: sources.map((uri) => ({ web: { uri, title: "Shop" } })) };
  }
  return () => new Response(JSON.stringify({ candidates: [candidate] }), { status: 200 });
}

const quota = () => new Response("quota", { status: 429 });

const FOUND = {
  found: true,
  name: "Oil Free Moisturiser",
  brand: "Minimalist",
  category: "Moisturizer",
  ingredients: ["Aqua", "Niacinamide", "Salicylic Acid", "Glycerin."],
};

before(() => {
  mock.method(console, "warn", () => {});
});

after(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
  mock.restoreAll();
});

describe("sanitizeAiProduct", () => {
  test("keeps a well-formed answer, lowercasing and de-duplicating ingredients", () => {
    const p = sanitizeAiProduct({ ...FOUND, ingredients: [...FOUND.ingredients, "niacinamide"] });
    assert.deepEqual(p, {
      name: "Oil Free Moisturiser",
      brand: "Minimalist",
      category: "moisturizer",
      ingredients: ["aqua", "niacinamide", "salicylic acid", "glycerin"],
    });
  });

  test("rejects 'not found', missing names and lists too short to judge", () => {
    assert.equal(sanitizeAiProduct({ found: false }), null);
    assert.equal(sanitizeAiProduct({ ...FOUND, found: "yes" }), null);
    assert.equal(sanitizeAiProduct({ ...FOUND, name: "" }), null);
    assert.equal(sanitizeAiProduct({ ...FOUND, ingredients: ["aqua", "glycerin"] }), null);
    assert.equal(sanitizeAiProduct({ ...FOUND, ingredients: "aqua, glycerin, niacinamide" }), null);
    assert.equal(sanitizeAiProduct(null), null);
  });

  test("drops placeholder and non-string ingredients, and unknown categories", () => {
    const p = sanitizeAiProduct({
      ...FOUND,
      category: "magic potion",
      ingredients: ["Aqua", 42, "Unknown", "N/A", "Niacinamide", "Zinc PCA", null],
    });
    assert.equal(p?.category, null);
    assert.deepEqual(p?.ingredients, ["aqua", "niacinamide", "zinc pca"]);
  });
});

describe("lookupProductWithAi", () => {
  beforeEach(() => {
    clearAiProductCache();
    process.env.GEMINI_API_KEY = "test-key-not-real";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("without GEMINI_API_KEY returns null and never calls fetch", async () => {
    delete process.env.GEMINI_API_KEY;
    stubFetch(modelReply(FOUND));
    assert.equal(await lookupProductWithAi({ text: "Minimalist moisturiser" }), null);
    assert.equal(calls.length, 0);
  });

  test("a grounded answer returns the product with its web sources", async () => {
    stubFetch(modelReply(FOUND, ["https://example.com/p"]));
    const p = await lookupProductWithAi({ text: "MINIMALIST\nOil Free Moisturiser" });
    assert.equal(p?.name, "Oil Free Moisturiser");
    assert.equal(p?.grounded, true);
    assert.deepEqual(p?.sources, [{ title: "Shop", url: "https://example.com/p" }]);
    assert.ok(calls[0]!.body.tools, "first call uses Google Search grounding");
    assert.ok(calls[0]!.body.contents[0].parts[0].text.includes("Oil Free Moisturiser"));
  });

  test("falls back to an ungrounded call when grounding has no quota", async () => {
    stubFetch(quota, modelReply(FOUND));
    const p = await lookupProductWithAi({ text: "Minimalist moisturiser" });
    assert.equal(p?.brand, "Minimalist");
    assert.equal(p?.grounded, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.body.tools, undefined);
  });

  test("a barcode only gets the grounded call, so the model can't invent a product from digits", async () => {
    stubFetch(quota, modelReply(FOUND));
    assert.equal(await lookupProductWithAi({ barcode: "8901234567890" }), null);
    assert.equal(calls.length, 1);
  });

  test("a clear 'not found' stops there instead of asking another model to guess", async () => {
    stubFetch(modelReply({ found: false }), modelReply(FOUND));
    assert.equal(await lookupProductWithAi({ text: "blurry text" }), null);
    assert.equal(calls.length, 1);
  });

  test("caches answers, so scanning the same product again costs no quota", async () => {
    stubFetch(modelReply(FOUND));
    await lookupProductWithAi({ text: "Minimalist  Moisturiser!" });
    await lookupProductWithAi({ text: "minimalist moisturiser" });
    assert.equal(calls.length, 1);
  });

  test("doesn't cache a miss caused by quota errors, so the next scan retries", async () => {
    stubFetch(quota);
    assert.equal(await lookupProductWithAi({ text: "Minimalist moisturiser" }), null);
    stubFetch(modelReply(FOUND));
    assert.equal((await lookupProductWithAi({ text: "Minimalist moisturiser" }))?.name, "Oil Free Moisturiser");
  });
});

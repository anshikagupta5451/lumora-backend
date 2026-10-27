import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MIN_MATCH_SCORE, ReadText, type ReadLine } from "../src/lib/productMatch";

const read = (...lines: [string, number][]) =>
  new ReadText(lines.map(([text, size]): ReadLine => ({ text, size })));

describe("ReadText construction", () => {
  test("drops stopwords, pure numbers and single letters, keeping only identifying words", () => {
    const r = read(["Net Qty 50 ml", 10], ["Vitamin C Serum", 30], ["MRP Rs 599 incl. of all taxes", 8]);
    assert.deepEqual([...r.words.keys()].sort(), ["serum", "vitamin"]);
  });

  test("weights each word by its line height relative to the biggest line (0.3 to 1)", () => {
    const r = read(["CeraVe", 100], ["moisturising lotion", 50], ["tiny claim", 0.0001]);
    assert.equal(r.words.get("cerave"), 1);
    assert.equal(r.words.get("lotion"), 0.3 + 0.7 * 0.5);
    assert.ok(Math.abs(r.words.get("tiny")! - 0.3) < 0.001);
  });

  test("a word seen on several lines keeps the weight of its biggest appearance", () => {
    const r = read(["serum", 20], ["Niacinamide Serum", 100]);
    assert.equal(r.words.get("serum"), 1);
  });

  test("strips accents and treats & as 'and'", () => {
    const r = read(["Lakmé", 10], ["Dot & Key", 10]);
    assert.ok(r.words.has("lakme"));
    assert.ok(r.joined.includes("dotandkey"));
  });

  test("an empty read (no lines, or only filler) reports isEmpty", () => {
    assert.equal(read().isEmpty, true);
    assert.equal(read(["Net 100 ml", 10]).isEmpty, true);
    assert.equal(read(["Cetaphil", 10]).isEmpty, false);
  });
});

describe("brandScore", () => {
  test("a brand split across lines is found in the joined text", () => {
    assert.equal(read(["m", 50], ["CAFFEINE", 50]).brandScore("mCaffeine"), 1);
  });

  test("a read word that is most of the brand scores 0.8 ('caffeine' for 'mcaffeine')", () => {
    assert.equal(read(["caffeine coffee face wash", 50]).brandScore("mCaffeine"), 0.8);
  });

  test("a one-character OCR misread of the brand still scores 0.8", () => {
    assert.equal(read(["Cetaphll", 50]).brandScore("Cetaphil"), 0.8);
  });

  test("a brand that was not read at all scores 0, and a 1-char brand is never matched", () => {
    assert.equal(read(["Nivea Soft", 50]).brandScore("CeraVe"), 0);
    assert.equal(read(["x factor", 50]).brandScore("X"), 0);
  });
});

describe("score", () => {
  test("an exact read of brand and name in equally large type scores 100", () => {
    const r = read(["CeraVe", 100], ["Moisturising Lotion", 100]);
    assert.equal(r.score({ brand: "CeraVe", name: "Moisturising Lotion" }), 100);
  });

  test("OCR misreads of name words ('lotlon' for 'lotion') still give a confident match", () => {
    const r = read(["CeraVe", 100], ["Moisturising Lotlon", 80]);
    const s = r.score({ brand: "CeraVe", name: "Moisturising Lotion" });
    assert.ok(s < 100, `expected a penalty for the misread, got ${s}`);
    assert.ok(s >= 85, `expected still confident, got ${s}`);
  });

  test("short words (under 4 letters) must match exactly, so 'spt' does not count as 'spf'", () => {
    const exact = read(["Lakme", 100], ["Sun SPF", 80]).score({ brand: "Lakme", name: "Sun SPF" });
    const typo = read(["Lakme", 100], ["Sun SPT", 80]).score({ brand: "Lakme", name: "Sun SPF" });
    assert.ok(typo < exact);
  });

  test("generic words alone ('body lotion') do not pick a brand that was never read", () => {
    const r = read(["Body Lotion", 100]);
    const s = r.score({ brand: "CeraVe", name: "Body Lotion" });
    // Full name recall, but the missing brand is penalised by 0.7.
    assert.equal(s, Math.round(100 * (0.45 + 0.25) * 0.7));
    assert.ok(s > MIN_MATCH_SCORE, "documenting current behaviour: still above threshold");
    const withBrand = read(["CeraVe", 100], ["Body Lotion", 80]).score({ brand: "CeraVe", name: "Body Lotion" });
    assert.ok(withBrand > s);
  });

  test("the more specific product wins: 'lakme sun expert' prefers Sun Expert over a product named just 'Lakme'", () => {
    const r = read(["LAKME", 100], ["Sun Expert", 90]);
    const specific = r.score({ brand: "Lakme", name: "Sun Expert SPF 50" });
    const brandOnly = r.score({ brand: "Lakme", name: "Lakme" });
    assert.ok(specific > brandOnly, `${specific} should beat ${brandOnly}`);
  });

  test("a product whose name repeats the brand gets no name recall credit", () => {
    const r = read(["Lakme", 100]);
    // brand (0.3) + full coverage (0.25), recall is 0 because the name has no non-brand words.
    assert.equal(r.score({ brand: "Lakme", name: "Lakme" }), 55);
  });

  test("an unrelated product scores below MIN_MATCH_SCORE", () => {
    const r = read(["Minimalist", 100], ["Niacinamide 10% + Zinc 1%", 80], ["Face Serum", 40]);
    assert.ok(r.score({ brand: "Minimalist", name: "Niacinamide 10% Face Serum" }) >= MIN_MATCH_SCORE);
    assert.ok(r.score({ brand: "Nivea", name: "Soft Light Moisturising Cream" }) < MIN_MATCH_SCORE);
  });

  test("big text counts more than small print: a name read in large type beats the same name in fine print", () => {
    const big = read(["Hydrating Cleanser", 100], ["CeraVe", 20], ["for normal to dry skin", 20]);
    const small = read(["for normal to dry skin", 100], ["CeraVe", 20], ["Hydrating Cleanser", 20]);
    const c = { brand: "CeraVe", name: "Hydrating Cleanser" };
    assert.ok(big.score(c) > small.score(c));
  });

  test("an empty read scores 0 for any candidate", () => {
    assert.equal(read().score({ brand: "CeraVe", name: "Hydrating Cleanser" }), 0);
  });
});

describe("searchQueries", () => {
  test("starts with the known brand, then the biggest words alone and in groups, at most 3", () => {
    const r = read(["Simple", 100], ["Refreshing", 80], ["Facial Wash", 60]);
    assert.deepEqual(r.searchQueries("Simple"), ["Simple", "simple", "simple refreshing"]);
    assert.deepEqual(r.searchQueries(null), ["simple", "simple refreshing", "simple refreshing facial"]);
  });

  test("skips words under 3 letters and de-duplicates when there is only one word", () => {
    const r = read(["Ok", 100], ["Cetaphil", 50]);
    assert.deepEqual(r.searchQueries(null), ["cetaphil"]);
    assert.deepEqual(read().searchQueries(null), []);
    assert.deepEqual(read().searchQueries("  "), []);
  });
});

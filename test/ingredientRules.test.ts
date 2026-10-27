import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_CLASHES,
  ACTIVES,
  SENSITIVITY_INGREDIENTS,
  activesIn,
  findAny,
  ingredientText,
  sensitivityHits,
} from "../src/lib/ingredientRules";

describe("ingredientText", () => {
  test("joins name and ingredients into one lowercased string so the name is searchable too", () => {
    const text = ingredientText(["Aqua", "Niacinamide", "Zinc PCA"], "Clear Skin RETINOL Serum");
    assert.equal(text, "clear skin retinol serum aqua, niacinamide, zinc pca");
  });

  test("works with no name and no ingredients", () => {
    assert.equal(ingredientText([]), " ");
    assert.equal(findAny(ingredientText([]), ["fragrance"]), null);
  });
});

describe("findAny", () => {
  test("returns the first needle (in list order) that appears, not the first in the text", () => {
    const text = "aqua, limonene, parfum";
    assert.equal(findAny(text, ["parfum", "limonene"]), "parfum");
    assert.equal(findAny(text, ["limonene", "parfum"]), "limonene");
  });

  test("returns null when nothing matches or the needle list is empty", () => {
    assert.equal(findAny("aqua, glycerin", ["parfum"]), null);
    assert.equal(findAny("aqua, glycerin", []), null);
  });

  test("is case-sensitive, so callers must lowercase via ingredientText first", () => {
    assert.equal(findAny("Parfum", ["parfum"]), null);
    assert.equal(findAny(ingredientText(["Parfum"]), ["parfum"]), "parfum");
  });
});

describe("sensitivityHits", () => {
  test("flags each sensitivity group with the exact ingredient that triggered it", () => {
    const text = ingredientText(["Aqua", "Alcohol Denat.", "Linalool", "Sodium Lauryl Sulfate"]);
    const hits = sensitivityHits(text, ["Fragrance", "alcohol", "Sulfates"]);
    assert.deepEqual(hits, [
      { label: "fragrance", found: "linalool" },
      { label: "alcohol", found: "alcohol denat" },
      { label: "sulfates", found: "sodium lauryl sulfate" },
    ]);
  });

  test("fatty alcohols (cetyl, cetearyl, stearyl) do not count as an alcohol sensitivity", () => {
    const text = ingredientText(["Cetyl Alcohol", "Cetearyl Alcohol", "Stearyl Alcohol", "Glycerin"]);
    assert.deepEqual(sensitivityHits(text, ["alcohol"]), []);
  });

  test("essential oils are caught by their botanical names (melaleuca, lavandula)", () => {
    assert.deepEqual(sensitivityHits(ingredientText(["Melaleuca Alternifolia Leaf Oil"]), ["essential oils"]), [
      { label: "essential oils", found: "melaleuca" },
    ]);
    assert.deepEqual(sensitivityHits(ingredientText(["Lavandula Angustifolia Oil"]), ["Essential Oils"]), [
      { label: "essential oils", found: "lavandula" },
    ]);
  });

  test("an unknown sensitivity label yields no hit instead of throwing", () => {
    assert.deepEqual(sensitivityHits(ingredientText(["Peanut Oil"]), ["nuts", "none that i know of"]), []);
  });

  test("a clean ingredient list produces no hits for any known group", () => {
    const text = ingredientText(["Aqua", "Glycerin", "Niacinamide", "Panthenol"]);
    assert.deepEqual(sensitivityHits(text, Object.keys(SENSITIVITY_INGREDIENTS)), []);
  });

  test(
    "triethanolamine (a pH adjuster, not a drying alcohol) should not trigger the alcohol sensitivity",
    () => {
      const text = ingredientText(["Aqua", "Carbomer", "Triethanolamine"]);
      assert.deepEqual(sensitivityHits(text, ["alcohol"]), []);
    },
  );
});

describe("activesIn", () => {
  test("detects each active class from any of its synonyms", () => {
    const text = ingredientText([
      "Retinyl Palmitate",
      "Lactic Acid",
      "Salicylic Acid",
      "Ethyl Ascorbic Acid",
      "Niacinamide",
      "Sodium Hyaluronate",
      "Ceramide NP",
      "Zinc Oxide",
    ]);
    assert.deepEqual(
      [...activesIn(text)].sort(),
      ["aha", "bha", "ceramides", "hyaluronic acid", "niacinamide", "retinoid", "sunscreen filters", "vitamin c"],
    );
  });

  test("benzyl salicylate (a fragrance) is not mistaken for salicylic acid (BHA)", () => {
    assert.equal(activesIn(ingredientText(["Benzyl Salicylate"])).has("bha"), false);
  });

  test("returns an empty set for a plain moisturiser base", () => {
    assert.equal(activesIn(ingredientText(["Aqua", "Glycerin", "Dimethicone"])).size, 0);
  });

  test("every clash pair references actives that exist in ACTIVES and has an explanation", () => {
    for (const [a, b, why] of ACTIVE_CLASHES) {
      assert.ok(ACTIVES[a], `unknown active ${a}`);
      assert.ok(ACTIVES[b], `unknown active ${b}`);
      assert.notEqual(a, b);
      assert.ok(why.length > 20);
    }
  });
});

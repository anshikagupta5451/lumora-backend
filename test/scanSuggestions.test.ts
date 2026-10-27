// Tests for the rule-based product suggestions shown under a face scan.
// Plain objects in the Prisma shapes; no database.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Product, SkinProfile } from "@prisma/client";
import {
  detectedConcerns,
  ownedSuggestions,
  planWithinBudget,
  promotedSuggestions,
  type OwnedProduct,
  type SuggestedItem,
} from "../src/lib/scanSuggestions";
import type { ConcernScore } from "../src/lib/faceAnalysis";
import { CONCERN_DEFS, type ConcernKey } from "../src/lib/skinConcerns";

const NOW = new Date("2026-06-15T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function concern(key: ConcernKey, score: number, detected = score >= 40): ConcernScore {
  return { key, label: CONCERN_DEFS[key].label, score, detected };
}

function product(o: Partial<Product> & { id: string; name: string }): Product {
  return {
    brand: "Brand",
    category: "serum",
    ingredients: [],
    price: 500,
    imageUrl: null,
    barcode: null,
    isPromoted: false,
    createdAt: NOW,
    ...o,
  };
}

function owned(o: Partial<OwnedProduct> & { id: string }): OwnedProduct {
  return {
    userId: "u1",
    productId: null,
    product: null,
    customName: null,
    customBrand: null,
    openedAt: null,
    expiresAt: null,
    quantityTotal: null,
    quantityUnit: null,
    quantityLeft: null,
    isFinished: false,
    createdAt: NOW,
    ...o,
  };
}

function profile(o: Partial<SkinProfile> = {}): SkinProfile {
  return {
    id: "sp1",
    userId: "u1",
    skinType: "normal",
    concerns: [],
    sensitivities: [],
    goals: [],
    climateZone: null,
    monthlyBudget: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

function item(id: string, price: number | null, o: Partial<SuggestedItem> = {}): SuggestedItem {
  return {
    productId: id,
    userProductId: null,
    name: `Product ${id}`,
    brand: "Brand",
    price,
    category: "serum",
    keyIngredient: null,
    why: "",
    tag: "catalog",
    url: null,
    alsoFor: [],
    ...o,
  };
}

describe("detectedConcerns", () => {
  test("keeps only detected concerns, sorted worst first", () => {
    const out = detectedConcerns([concern("acne", 50), concern("dryness", 90), concern("dullness", 20), concern("darkSpots", 70)]);
    assert.deepEqual(out.map((c) => c.key), ["dryness", "darkSpots", "acne"]);
  });

  test("drops unknown concern keys even if marked detected (e.g. stale or AI-invented keys)", () => {
    const bogus = { key: "wrinkles", label: "Wrinkles", score: 99, detected: true } as unknown as ConcernScore;
    assert.deepEqual(detectedConcerns([bogus, concern("acne", 60)]).map((c) => c.key), ["acne"]);
  });

  test("returns an empty list for no input and doesn't reorder the caller's array", () => {
    assert.deepEqual(detectedConcerns([]), []);
    const input = [concern("acne", 50), concern("dryness", 90)];
    detectedConcerns(input);
    assert.deepEqual(input.map((c) => c.key), ["acne", "dryness"]);
  });
});

describe("ownedSuggestions", () => {
  const salicylic = product({ id: "p1", name: "Clear Gel", ingredients: ["Salicylic Acid", "Niacinamide"] });

  test("matches owned products by ingredient and cites the first keyword in the concern's priority order", () => {
    const { concerns, plan } = ownedSuggestions(
      [concern("acne", 80)],
      [owned({ id: "up1", productId: "p1", product: salicylic })],
      NOW,
    );
    const [acne] = concerns;
    assert.ok(acne);
    assert.equal(acne.items.length, 1);
    const it = acne.items[0]!;
    assert.equal(it.keyIngredient, "salicylic acid"); // listed before niacinamide in CONCERN_DEFS.acne
    assert.equal(it.tag, "owned");
    assert.equal(it.price, null, "owned products cost nothing extra");
    assert.equal(it.userProductId, "up1");
    assert.match(it.why, /salicylic acid.*acne & breakouts/);
    assert.equal(acne.emptyReason, null);
    assert.deepEqual(plan, { total: 0, budget: null, productCount: 0 });
  });

  test("matches custom (non-catalog) products by their name", () => {
    const { concerns } = ownedSuggestions(
      [concern("dryness", 70)],
      [owned({ id: "up9", customName: "Ceramide Night Cream", customBrand: "Local" })],
      NOW,
    );
    const it = concerns[0]!.items[0]!;
    assert.equal(it.name, "Ceramide Night Cream");
    assert.equal(it.brand, "Local");
    assert.equal(it.productId, null);
    assert.equal(it.keyIngredient, "ceramide");
  });

  test("skips finished and expired products, but keeps ones expiring later", () => {
    const { concerns } = ownedSuggestions(
      [concern("acne", 80)],
      [
        owned({ id: "finished", productId: "p1", product: salicylic, isFinished: true }),
        owned({ id: "expired", productId: "p1", product: salicylic, expiresAt: new Date(NOW.getTime() - DAY) }),
        owned({ id: "fresh", productId: "p1", product: salicylic, expiresAt: new Date(NOW.getTime() + DAY) }),
      ],
      NOW,
    );
    assert.deepEqual(concerns[0]!.items.map((i) => i.userProductId), ["fresh"]);
  });

  test("caps suggestions at 2 per concern", () => {
    const many = [1, 2, 3, 4].map((n) => owned({ id: `up${n}`, productId: "p1", product: salicylic }));
    const { concerns } = ownedSuggestions([concern("acne", 80)], many, NOW);
    assert.equal(concerns[0]!.items.length, 2);
  });

  test("explains an empty result differently for 'nothing owned' vs 'nothing relevant owned'", () => {
    const none = ownedSuggestions([concern("darkCircles", 80)], [], NOW).concerns[0]!;
    assert.match(none.emptyReason ?? "", /haven't added any products/);
    const irrelevant = ownedSuggestions(
      [concern("darkCircles", 80)],
      [owned({ id: "up1", customName: "Plain lip balm" })],
      NOW,
    ).concerns[0]!;
    assert.equal(irrelevant.emptyReason, "Nothing you own targets this yet.");
    // Only finished/expired products counts as having nothing usable.
    const onlyFinished = ownedSuggestions(
      [concern("darkCircles", 80)],
      [owned({ id: "up1", customName: "Caffeine eye cream", isFinished: true })],
      NOW,
    ).concerns[0]!;
    assert.match(onlyFinished.emptyReason ?? "", /haven't added any products/);
  });
});

describe("planWithinBudget", () => {
  test("with no budget, every concern gets its two best-ranked options", () => {
    const { concerns, plan } = planWithinBudget(
      [concern("acne", 80)],
      () => [
        { rank: 1, item: item("low", 100) },
        { rank: 3, item: item("best", 900) },
        { rank: 2, item: item("mid", 500) },
      ],
      null,
    );
    assert.deepEqual(concerns[0]!.items.map((i) => i.productId), ["best", "mid"]);
    assert.deepEqual(plan, { total: 1400, budget: null, productCount: 2 });
  });

  test("treats the budget as a total: worst concern picks first, others take what still fits", () => {
    const pools: Record<string, { rank: number; item: SuggestedItem }[]> = {
      acne: [
        { rank: 3, item: item("A", 700) },
        { rank: 2, item: item("B", 200) },
      ],
      dryness: [
        { rank: 3, item: item("C", 500) },
        { rank: 1, item: item("D", 250) },
      ],
    };
    const { concerns, plan } = planWithinBudget(
      [concern("acne", 80), concern("dryness", 60)],
      (c) => pools[c.key]!,
      1000,
    );
    assert.deepEqual(concerns[0]!.items.map((i) => i.productId), ["A"]);
    assert.deepEqual(concerns[1]!.items.map((i) => i.productId), ["D"]);
    assert.equal(plan.total, 950);
    assert.ok(plan.total <= 1000);
    assert.equal(plan.productCount, 2);
  });

  test("a product picked for two concerns is paid for once and lists both concerns", () => {
    const shared = () => [{ rank: 5, item: item("X", 300) }];
    const { concerns, plan } = planWithinBudget([concern("acne", 80), concern("oiliness", 60)], shared, null);
    const a = concerns[0]!.items[0]!;
    const o = concerns[1]!.items[0]!;
    assert.equal(a, o, "the same item object is shared");
    assert.deepEqual(a.alsoFor, ["Acne & breakouts", "Oiliness & shine"]);
    assert.equal(plan.total, 300);
    assert.equal(plan.productCount, 1);
  });

  test("items without a productId are de-duplicated by brand + name (case-insensitive)", () => {
    const web1 = item("", 400, { productId: null, brand: "Acme", name: "Glow Serum", tag: "web" });
    const web2 = item("", 400, { productId: null, brand: "ACME", name: "glow serum", tag: "web" });
    const { plan } = planWithinBudget(
      [concern("dullness", 80), concern("darkSpots", 60)],
      (c) => [{ rank: 1, item: c.key === "dullness" ? web1 : web2 }],
      null,
    );
    assert.equal(plan.productCount, 1);
    assert.equal(plan.total, 400);
  });

  test("unknown prices count as 0 against the budget", () => {
    const { concerns, plan } = planWithinBudget([concern("acne", 80)], () => [{ rank: 1, item: item("free", null) }], 10);
    assert.equal(concerns[0]!.items.length, 1);
    assert.equal(plan.total, 0);
  });

  test("explains empty concerns: over budget vs no candidates at all", () => {
    const { concerns } = planWithinBudget(
      [concern("acne", 80), concern("dryness", 60)],
      (c) => (c.key === "acne" ? [{ rank: 1, item: item("pricey", 5000) }] : []),
      1000,
    );
    assert.equal(concerns[0]!.emptyReason, "Nothing for this fits in what's left of your ₹1000 budget.");
    assert.equal(concerns[1]!.emptyReason, "No matching products found for this concern.");
  });
});

describe("promotedSuggestions", () => {
  const catalog = [
    product({ id: "plain", name: "Basic Niacinamide Serum", ingredients: ["niacinamide"], price: 300 }),
    product({ id: "featured", name: "Star Serum", ingredients: ["niacinamide"], price: 900, isPromoted: true }),
    product({ id: "strong", name: "Clear Duo", ingredients: ["salicylic acid", "zinc"], price: 600 }),
    product({ id: "scented", name: "Scented Clear", ingredients: ["salicylic acid", "parfum"], price: 100, isPromoted: true }),
    product({ id: "owned", name: "Owned Zinc", ingredients: ["zinc"], price: 50, isPromoted: true }),
    product({ id: "unrelated", name: "Lip Balm", ingredients: ["beeswax"], price: 10 }),
  ];
  const mine = [owned({ id: "up1", productId: "owned" })];

  test("ranks featured first, then stronger ingredient match; excludes owned, unrelated and sensitivity conflicts", () => {
    const { concerns } = promotedSuggestions([concern("acne", 80)], catalog, mine, profile({ sensitivities: ["Fragrance"] }));
    const ids = concerns[0]!.items.map((i) => i.productId);
    assert.deepEqual(ids, ["featured", "strong"]);
    assert.equal(concerns[0]!.items[0]!.tag, "featured");
    assert.equal(concerns[0]!.items[1]!.tag, "catalog");
  });

  test("without a profile there are no sensitivity filters and no budget", () => {
    const { concerns, plan } = promotedSuggestions([concern("acne", 80)], catalog, mine, null);
    assert.deepEqual(concerns[0]!.items.map((i) => i.productId), ["scented", "featured"]);
    assert.equal(plan.budget, null);
  });

  test("uses the profile's monthly budget as a cap on the total", () => {
    const { concerns, plan } = promotedSuggestions([concern("acne", 80)], catalog, mine, profile({ monthlyBudget: 400 }));
    // featured (900) and strong (600) don't fit; scented (100) then plain (300) do.
    assert.deepEqual(concerns[0]!.items.map((i) => i.productId), ["scented", "plain"]);
    assert.equal(plan.total, 400);
    assert.equal(plan.budget, 400);
  });

  test("explains the pick with the matched ingredients, singular vs plural", () => {
    const { concerns } = promotedSuggestions([concern("acne", 80)], [catalog[2]!, catalog[0]!], [], null);
    const [two, one] = concerns[0]!.items;
    assert.equal(two!.why, "Its salicylic acid and zinc target acne & breakouts.");
    assert.equal(one!.why, "Its niacinamide targets acne & breakouts.");
    assert.equal(two!.keyIngredient, "salicylic acid");
  });

  test("a catalog price of 0 (unknown, e.g. barcode-added) is shown as null", () => {
    const unknown = product({ id: "u", name: "Mystery Clay Mask", ingredients: ["kaolin clay"], price: 0 });
    const { concerns } = promotedSuggestions([concern("oiliness", 80)], [unknown], [], profile({ monthlyBudget: 1 }));
    assert.equal(concerns[0]!.items[0]!.price, null);
  });
});

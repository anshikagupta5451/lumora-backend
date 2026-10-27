import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Product, SkinProfile, UserProduct } from "@prisma/client";
import { buildVerdict, type VerdictInput, type VerdictProduct } from "../src/lib/productVerdict";

// Plain objects shaped like the Prisma rows (see prisma/schema.prisma); no DB.
const NOW = new Date("2026-01-01T00:00:00Z");

function profile(over: Partial<SkinProfile> = {}): SkinProfile {
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
    ...over,
  };
}

function catalogProduct(over: Partial<Product> = {}): Product {
  return {
    id: "p-owned",
    name: "Owned Product",
    brand: "Brand",
    category: "serum",
    ingredients: ["Aqua"],
    price: 500,
    imageUrl: null,
    barcode: null,
    isPromoted: false,
    createdAt: NOW,
    ...over,
  };
}

function owned(product: Product | null, over: Partial<UserProduct> = {}): VerdictInput["owned"][number] {
  return {
    id: `up-${product?.id ?? "custom"}`,
    userId: "u1",
    productId: product?.id ?? null,
    customName: null,
    customBrand: null,
    openedAt: null,
    expiresAt: null,
    quantityTotal: null,
    quantityUnit: null,
    quantityLeft: null,
    isFinished: false,
    createdAt: NOW,
    ...over,
    product,
  };
}

function input(over: {
  product?: Partial<VerdictProduct>;
  profile?: SkinProfile | null;
  scanConcerns?: VerdictInput["scanConcerns"];
  owned?: VerdictInput["owned"];
  community?: Partial<VerdictInput["community"]>;
} = {}): VerdictInput {
  return {
    product: { id: "p1", name: "Test Product", category: "serum", ingredients: ["Aqua", "Glycerin"], price: 400, ...over.product },
    profile: over.profile === undefined ? profile() : over.profile,
    scanConcerns: over.scanConcerns ?? [],
    owned: over.owned ?? [],
    community: { count: 0, avg: null, sameSkinCount: 0, sameSkinAvg: null, ...over.community },
  };
}

const find = (v: ReturnType<typeof buildVerdict>, kind: string) => v.checks.filter((c) => c.kind === kind);

describe("sensitivities", () => {
  test("an ingredient the user is sensitive to is a 'bad' check and makes the verdict 'avoid'", () => {
    const v = buildVerdict(
      input({
        profile: profile({ sensitivities: ["fragrance"] }),
        product: { ingredients: ["Aqua", "Parfum", "Niacinamide"] },
      }),
    );
    const [s] = find(v, "sensitivity");
    assert.equal(s?.status, "bad");
    assert.equal(s?.title, "Contains parfum");
    assert.match(s!.detail, /sensitive to fragrance/);
    assert.equal(v.overall, "avoid");
    assert.equal(v.headline, "Probably not for you");
    assert.equal(v.checks[0], s, "bad checks are sorted first");
  });

  test("a clean list gets a 'Free of …' good check; 'None that I know of' is ignored", () => {
    const v = buildVerdict(
      input({ profile: profile({ sensitivities: ["Fragrance", "Alcohol", "None that I know of"] }) }),
    );
    const s = find(v, "sensitivity");
    assert.equal(s.length, 1);
    assert.equal(s[0]!.status, "good");
    assert.equal(s[0]!.title, "Free of fragrance, alcohol");
  });

  test("with no ingredient list, it never claims a product is free of a sensitivity", () => {
    const v = buildVerdict(
      input({ profile: profile({ sensitivities: ["fragrance"] }), product: { ingredients: [] } }),
    );
    assert.equal(find(v, "sensitivity").length, 0);
    assert.equal(find(v, "ingredients")[0]?.title, "No ingredient list on file");
  });
});

describe("skin type", () => {
  test("oily/combo skin gets a pore-clogging caution, labelled 'combination' for 'combo'", () => {
    const v = buildVerdict(
      input({ profile: profile({ skinType: "Combo" }), product: { ingredients: ["Cocos Nucifera Oil", "Niacinamide"] } }),
    );
    const [s] = find(v, "skinType");
    assert.equal(s?.status, "caution");
    assert.equal(s?.title, "Contains cocos nucifera oil");
    assert.match(s!.detail, /combination skin/);
  });

  test("sensitive skin is warned about glycolic acid even when no sensitivity was ticked", () => {
    const v = buildVerdict(input({ profile: profile({ skinType: "Sensitive" }), product: { ingredients: ["Glycolic Acid", "Centella Asiatica"] } }));
    const [s] = find(v, "skinType");
    assert.equal(s?.status, "caution");
    assert.equal(s?.title, "Contains glycolic acid");
  });

  test("dry skin with ceramides and no drying ingredients gets a 'Suits dry skin' good check", () => {
    const v = buildVerdict(input({ profile: profile({ skinType: "dry" }), product: { ingredients: ["Ceramide NP", "Glycerin"] } }));
    const [s] = find(v, "skinType");
    assert.equal(s?.status, "good");
    assert.equal(s?.title, "Suits dry skin");
  });
});

describe("concerns", () => {
  test("face-scan and profile concerns are merged without repeating the same concern", () => {
    const v = buildVerdict(
      input({
        profile: profile({ concerns: ["Acne", "Fine lines"] }),
        scanConcerns: ["acne"],
        product: { ingredients: ["Salicylic Acid", "Retinol"] },
      }),
    );
    const [c] = find(v, "concerns");
    assert.equal(c?.status, "good");
    assert.equal(c?.title, "Targets acne & breakouts and fine lines");
    assert.match(c!.detail, /salicylic acid for acne & breakouts \(from your face scan\)/);
    assert.match(c!.detail, /retinol for fine lines\.$/);
  });

  test("a product that addresses none of the user's concerns gets an informational note", () => {
    const v = buildVerdict(
      input({ profile: profile({ concerns: ["dryness"] }), scanConcerns: ["darkCircles"], product: { ingredients: ["Aqua", "Zinc PCA"] } }),
    );
    const [c] = find(v, "concerns");
    assert.equal(c?.status, "info");
    assert.equal(c?.title, "Doesn't target your main concerns");
    assert.match(c!.detail, /dark circles or dryness/);
  });
});

describe("owned products", () => {
  test("owning the same catalog product short-circuits to 'You already own this' (no clash noise)", () => {
    const same = catalogProduct({ id: "p1", ingredients: ["Retinol"] });
    const v = buildVerdict(input({ product: { ingredients: ["Glycolic Acid"] }, owned: [owned(same)] }));
    assert.deepEqual(
      find(v, "owned").map((c) => c.title),
      ["You already own this"],
    );
    assert.equal(find(v, "clash").length, 0);
  });

  test("finished products on the shelf are ignored for ownership and clashes", () => {
    const retinol = catalogProduct({ id: "p1", name: "Night Retinol", ingredients: ["Retinol"] });
    const v = buildVerdict(
      input({ product: { ingredients: ["Glycolic Acid"] }, owned: [owned(retinol, { isFinished: true })] }),
    );
    assert.equal(find(v, "owned").length, 0);
    assert.equal(find(v, "clash").length, 0);
  });

  test("an AHA product clashes with an owned retinoid, naming the owned product", () => {
    const retinol = catalogProduct({ name: "Night Retinol", ingredients: ["Retinyl Palmitate"] });
    const v = buildVerdict(input({ product: { ingredients: ["Glycolic Acid"] }, owned: [owned(retinol)] }));
    const clashes = find(v, "clash");
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0]!.status, "caution");
    assert.equal(clashes[0]!.title, "Clashes with your Night Retinol");
    assert.match(clashes[0]!.detail, /alternate nights/);
  });

  test("at most two clash checks are shown even when many owned products clash", () => {
    const shelf = ["A", "B", "C"].map((n) =>
      owned(catalogProduct({ id: `p-${n}`, name: `Peel ${n}`, ingredients: ["Glycolic Acid", "Salicylic Acid"] })),
    );
    const v = buildVerdict(input({ product: { ingredients: ["Retinol"] }, owned: shelf }));
    assert.equal(find(v, "clash").length, 2);
  });

  test("a second moisturizer is flagged, and duplicate actives are noted except hydrators", () => {
    const moist = catalogProduct({ name: "Daily Moisturizer", category: "Moisturizer", ingredients: ["Niacinamide", "Hyaluronic Acid", "Ceramide NP"] });
    const v = buildVerdict(
      input({
        product: { id: "p-new", category: "moisturizer", ingredients: ["Niacinamide", "Sodium Hyaluronate", "Ceramide AP"] },
        owned: [owned(moist), owned(null, { customName: "Grandma's cream" })],
      }),
    );
    const titles = find(v, "owned").map((c) => c.title);
    assert.deepEqual(titles, ["You already have a moisturizer", "Doubles up on actives you already use"]);
    const dup = find(v, "owned")[1]!;
    assert.match(dup.detail, /niacinamide \(Daily Moisturizer\)/);
    assert.doesNotMatch(dup.detail, /hyaluronic|ceramides/);
  });
});

describe("budget", () => {
  test("price at or under 60% of budget fits; above 60% is a caution; unknown price is info", () => {
    const fits = find(buildVerdict(input({ profile: profile({ monthlyBudget: 1000 }), product: { price: 600 } })), "budget")[0];
    assert.equal(fits?.status, "good");
    assert.equal(fits?.detail, "₹600 is 60% of your ₹1000 monthly budget.");

    const most = find(buildVerdict(input({ profile: profile({ monthlyBudget: 1000 }), product: { price: 1000 } })), "budget")[0];
    assert.equal(most?.title, "Uses most of your budget");
    assert.equal(most?.status, "caution");

    const unknown = find(buildVerdict(input({ profile: profile({ monthlyBudget: 1000 }), product: { price: null } })), "budget")[0];
    assert.equal(unknown?.title, "Price not known");

    assert.equal(find(buildVerdict(input({ profile: profile({ monthlyBudget: null }) })), "budget").length, 0);
  });

  test("over budget never makes a product 'avoid': a great skin match becomes 'caution' with a budget headline", () => {
    const v = buildVerdict(
      input({
        profile: profile({ skinType: "dry", concerns: ["dryness"], monthlyBudget: 500 }),
        product: { ingredients: ["Ceramide NP", "Squalane"], price: 2000 },
      }),
    );
    const b = find(v, "budget")[0]!;
    assert.equal(b.status, "caution");
    assert.equal(b.title, "Over your monthly budget");
    assert.equal(v.overall, "caution");
    assert.equal(v.headline, "Good for your skin, but over budget");
  });

  test("a 'uses most of your budget' caution does not downgrade a great skin match", () => {
    const v = buildVerdict(
      input({
        profile: profile({ skinType: "dry", concerns: ["dryness"], monthlyBudget: 1000 }),
        product: { ingredients: ["Ceramide NP"], price: 900 },
      }),
    );
    assert.equal(v.overall, "great");
  });
});

describe("community reviews", () => {
  test("uses same-skin-type reviews when there are at least two of them", () => {
    const v = buildVerdict(
      input({ profile: profile({ skinType: "Oily" }), community: { count: 10, avg: 3.2, sameSkinCount: 3, sameSkinAvg: 4.5 } }),
    );
    const c = find(v, "community")[0]!;
    assert.equal(c.title, "4.5★ from 3 reviewers with oily skin");
    assert.equal(c.status, "good");
  });

  test("a poor average from 2+ reviewers is a caution; a single review is only info and singular", () => {
    const poor = find(buildVerdict(input({ community: { count: 4, avg: 2.5, sameSkinCount: 1, sameSkinAvg: 5 } })), "community")[0]!;
    assert.equal(poor.status, "caution");
    assert.equal(poor.title, "2.5★ from 4 reviewers");

    const single = find(buildVerdict(input({ community: { count: 1, avg: 5, sameSkinCount: 1, sameSkinAvg: 5 } })), "community")[0]!;
    assert.equal(single.status, "info");
    assert.equal(single.title, "5.0★ from 1 reviewer");

    const none = find(buildVerdict(input()), "community")[0]!;
    assert.equal(none.title, "No reviews yet");
  });
});

describe("overall verdict", () => {
  test("without a skin profile the verdict is 'unknown' even when checks look good", () => {
    const v = buildVerdict(input({ profile: null, community: { count: 5, avg: 4.8 } }));
    assert.equal(v.overall, "unknown");
    assert.equal(v.headline, "Finish your skin quiz for a personal verdict");
  });

  test("retinoid or AHA products get a 'Use it at night' usage tip", () => {
    const v = buildVerdict(input({ product: { ingredients: ["Lactic Acid"] } }));
    assert.equal(find(v, "usage")[0]?.title, "Use it at night");
    assert.equal(find(buildVerdict(input()), "usage").length, 0);
  });

  test("checks are ordered bad → caution → good → info", () => {
    const v = buildVerdict(
      input({
        profile: profile({ skinType: "oily", sensitivities: ["fragrance"], monthlyBudget: 1000 }),
        product: { ingredients: ["Parfum", "Coconut Oil", "Niacinamide"], price: 100 },
      }),
    );
    const rank = { bad: 0, caution: 1, good: 2, info: 3 } as const;
    const ranks = v.checks.map((c) => rank[c.status]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.equal(v.checks[0]!.status, "bad");
  });

  test(
    "with no ingredient list and no reviews there is no evidence, so it should not say 'Good fit'",
    () => {
      const v = buildVerdict(input({ profile: profile({ sensitivities: ["fragrance"] }), product: { ingredients: [], price: null } }));
      assert.notEqual(v.headline, "Good fit");
    },
  );
});

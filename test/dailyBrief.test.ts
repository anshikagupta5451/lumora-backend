// Tests for the rule-based "Today's brief". Every input is passed
// explicitly (including `now`), so results don't depend on the real date.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Product, SkinProfile } from "@prisma/client";
import { buildDailyBrief, conflictsWithSensitivities, type BriefInput } from "../src/lib/dailyBrief";
import type { SkinConditions } from "../src/lib/environment";
import type { ConcernScore } from "../src/lib/faceAnalysis";
import { CONCERN_DEFS, type ConcernKey } from "../src/lib/skinConcerns";

const NOW = new Date(2026, 5, 15, 9, 0, 0); // local time, fixed
const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * DAY);

type Owned = BriefInput["owned"][number];

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

function owned(o: Partial<Owned> & { id: string }): Owned {
  return {
    userId: "u1",
    productId: o.product?.id ?? null,
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
    skinType: "Normal",
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

function conditions(o: Partial<SkinConditions> = {}): SkinConditions {
  return { temp: 22, humidity: 50, uvNow: null, uvMax: 1, aqi: 20, pm25: null, condition: "Clear", ...o };
}

function scan(key: ConcernKey, score: number, createdAt = NOW): BriefInput["latestScan"] {
  const item: ConcernScore = { key, label: CONCERN_DEFS[key].label, score, detected: score >= 40 };
  return { items: [item], createdAt };
}

function input(o: Partial<BriefInput> = {}): BriefInput {
  return {
    now: NOW,
    conditions: null,
    skinProfile: profile(),
    latestScan: null,
    recentMoods: [],
    owned: [],
    hasMorningRoutine: false,
    morningRoutineHasSunscreen: false,
    catalog: [],
    dislikedProductIds: new Set(),
    ...o,
  };
}

const sunscreen = product({ id: "sun", name: "Daily Sunscreen SPF 50", category: "sunscreen", ingredients: ["zinc oxide"], price: 600 });
const vitC = product({ id: "vitc", name: "Bright Serum", category: "serum", ingredients: ["vitamin c", "ferulic acid"], price: 800 });
const hydrator = product({ id: "hya", name: "Hydra Serum", category: "serum", ingredients: ["hyaluronic acid", "glycerin"], price: 450 });
const ceramideCream = product({ id: "cer", name: "Barrier Cream", category: "moisturizer", ingredients: ["ceramide np", "squalane"], price: 700 });
const retinol = product({ id: "ret", name: "Night Retinol", category: "serum", ingredients: ["retinol"], price: 900 });
const CATALOG = [sunscreen, vitC, hydrator, ceramideCream, retinol];

describe("buildDailyBrief: no data", () => {
  test("without location or scan, gives a calm headline, asks for location and suggests a scan", () => {
    const b = buildDailyBrief(input());
    assert.equal(b.headline, "Calm conditions — keep your routine steady");
    assert.match(b.summary, /normal skin profile — allow location/);
    assert.deepEqual(b.tips.map((t) => t.title), ["Try a face scan"]);
    assert.equal(b.pick, null, "nothing to pick from an empty catalog");
    assert.equal(b.conditions, null);
  });

  test("the summary cites every available condition reading", () => {
    const b = buildDailyBrief(input({ conditions: conditions({ temp: 24, humidity: 55, uvMax: 4, aqi: 30 }) }));
    assert.match(b.summary, /\(24°C · 55% humidity · UV 4 · AQI 30\)/);
  });

  test("same input always produces the same brief", () => {
    const i = input({ conditions: conditions({ uvMax: 7, aqi: 120 }), latestScan: scan("acne", 70), catalog: CATALOG });
    assert.deepEqual(buildDailyBrief(i), buildDailyBrief(i));
  });
});

describe("buildDailyBrief: UV", () => {
  test("UV tiers set the headline and cite the UV number", () => {
    const cases: [number, RegExp][] = [
      [9, /^Very high UV/],
      [6, /^High UV today/],
      [3, /^Moderate UV/],
    ];
    for (const [uv, headline] of cases) {
      const b = buildDailyBrief(input({ conditions: conditions({ uvMax: uv }) }));
      assert.match(b.headline, headline, `uv ${uv}`);
      assert.equal(b.tips[0]!.source, "uv");
      assert.match(b.tips[0]!.title, new RegExp(`UV index peaks at ${uv}`));
    }
  });

  test("low UV gives no UV tip unless the user owns a photosensitizing product", () => {
    const none = buildDailyBrief(input({ conditions: conditions({ uvMax: 2 }) }));
    assert.ok(!none.tips.some((t) => t.source === "uv"));

    const withRetinol = buildDailyBrief(
      input({ conditions: conditions({ uvMax: 2 }), owned: [owned({ id: "up1", product: retinol })] }),
    );
    assert.equal(withRetinol.headline, "Low UV today");
    const uvTip = withRetinol.tips.find((t) => t.source === "uv");
    assert.ok(uvTip);
    assert.match(uvTip.detail, /Night Retinol makes skin more sun-sensitive/);
  });

  test("an expired photosensitizer doesn't trigger the low-UV warning", () => {
    const b = buildDailyBrief(
      input({ conditions: conditions({ uvMax: 1 }), owned: [owned({ id: "up1", product: retinol, expiresAt: daysFromNow(-3) })] }),
    );
    assert.ok(!b.tips.some((t) => t.source === "uv"));
    assert.ok(b.tips.some((t) => t.title === "Your Night Retinol has expired"));
  });

  test("high UV + retinol: moves the retinol to the evening and flags a routine with no SPF step", () => {
    const b = buildDailyBrief(
      input({
        conditions: conditions({ uvMax: 8 }),
        owned: [owned({ id: "up1", product: retinol })],
        hasMorningRoutine: true,
        morningRoutineHasSunscreen: false,
      }),
    );
    const titles = b.tips.map((t) => t.title);
    assert.ok(titles.includes("Save your Night Retinol for tonight"));
    assert.ok(titles.includes("Your morning routine has no sunscreen step"));
  });

  test("no 'missing sunscreen' nag when the morning routine already has SPF, or there's no routine", () => {
    for (const [hasRoutine, hasSpf] of [[true, true], [false, false]] as const) {
      const b = buildDailyBrief(
        input({ conditions: conditions({ uvMax: 7 }), hasMorningRoutine: hasRoutine, morningRoutineHasSunscreen: hasSpf }),
      );
      assert.ok(!b.tips.some((t) => t.source === "routine"));
    }
  });

  test("high UV picks a sunscreen and cites the UV reading and key ingredient", () => {
    const b = buildDailyBrief(input({ conditions: conditions({ uvMax: 9 }), catalog: CATALOG }));
    assert.equal(b.pick?.productId, "sun");
    assert.equal(b.pick?.owned, false);
    assert.equal(b.pick?.reason, "Worth considering because UV peaks at 9 today. Key ingredient: zinc oxide.");
  });
});

describe("buildDailyBrief: air, humidity, temperature", () => {
  test("AQI thresholds: <60 silent, 60-99 moderate tip only, 100+ polluted, 150+ unhealthy", () => {
    assert.ok(!buildDailyBrief(input({ conditions: conditions({ aqi: 59 }) })).tips.some((t) => t.source === "air"));

    const moderate = buildDailyBrief(input({ conditions: conditions({ aqi: 80 }) }));
    assert.equal(moderate.tips.find((t) => t.source === "air")?.title, "Moderate air quality (AQI 80)");
    assert.equal(moderate.headline, "Calm conditions — keep your routine steady");

    assert.equal(buildDailyBrief(input({ conditions: conditions({ aqi: 120 }) })).headline, "Polluted air today — give your skin a defence layer");

    const bad = buildDailyBrief(input({ conditions: conditions({ aqi: 160, pm25: 75 }), catalog: CATALOG }));
    assert.equal(bad.headline, "Unhealthy air — cleanse well tonight");
    assert.equal(bad.tips[0]!.title, "Air quality is unhealthy (AQI 160, PM2.5 75 µg/m³)");
    assert.equal(bad.pick?.productId, "vitc", "antioxidant serum for pollution");
  });

  test("dry air for dry skin: hydration headline, cites humidity, picks a hydrating product", () => {
    const b = buildDailyBrief(input({ skinProfile: profile({ skinType: "Dry" }), conditions: conditions({ humidity: 20 }), catalog: CATALOG }));
    assert.equal(b.headline, "Dry air — focus on hydration");
    assert.ok(b.tips.some((t) => t.title === "Humidity is only 20%"));
    assert.equal(b.pick?.productId, "hya");
    assert.match(b.pick!.reason, /humidity is down to 20%/);
  });

  test("high humidity only sets a headline for oil-prone skin", () => {
    const oily = buildDailyBrief(input({ skinProfile: profile({ skinType: "Oily" }), conditions: conditions({ humidity: 85 }) }));
    assert.equal(oily.headline, "Humid day — keep layers light");
    const normal = buildDailyBrief(input({ conditions: conditions({ humidity: 85 }) }));
    assert.notEqual(normal.headline, "Humid day — keep layers light");
    assert.ok(normal.tips.some((t) => t.title === "Humidity is 85%"));
  });

  test("cold weather sets a barrier headline and picks a ceramide moisturizer", () => {
    const b = buildDailyBrief(input({ conditions: conditions({ temp: 8 }), catalog: CATALOG }));
    assert.equal(b.headline, "Cold day — protect your skin barrier");
    assert.equal(b.pick?.productId, "cer");
  });
});

describe("buildDailyBrief: scan, check-ins, inventory", () => {
  test("a fresh scan focuses the brief on the top detected concern, with a tip from that concern", () => {
    const b = buildDailyBrief(input({ latestScan: scan("acne", 80) }));
    assert.equal(b.headline, "Focus on acne & breakouts today");
    const tip = b.tips.find((t) => t.source === "scan");
    assert.equal(tip?.title, "Acne & breakouts scored 80/100 on your scan today");
    assert.ok(CONCERN_DEFS.acne.freeTips.includes(tip!.detail));
  });

  test("describes scan age as today / yesterday / N days ago, and asks for a rescan after 45 days", () => {
    assert.match(buildDailyBrief(input({ latestScan: scan("dryness", 70, daysFromNow(-1)) })).tips.find((t) => t.source === "scan")!.title, /yesterday$/);
    assert.match(buildDailyBrief(input({ latestScan: scan("dryness", 70, daysFromNow(-10)) })).tips.find((t) => t.source === "scan")!.title, /10 days ago$/);
    const stale = buildDailyBrief(input({ latestScan: scan("dryness", 70, daysFromNow(-50)) }));
    assert.equal(stale.tips.find((t) => t.source === "scan")?.title, "Your last scan was 50 days ago");
  });

  test("a scan with nothing detected adds no scan tip", () => {
    const b = buildDailyBrief(input({ latestScan: scan("acne", 10) }));
    assert.ok(!b.tips.some((t) => t.source === "scan"));
  });

  test("check-ins: low recent average means 'keep it gentle'; only the newest 3 count; one check-in is ignored", () => {
    const rough = buildDailyBrief(input({ recentMoods: [1, 2, 2, 5, 5] }));
    assert.equal(rough.headline, "Rough few days — keep things gentle");
    assert.ok(rough.tips.some((t) => t.title === "Your last 3 check-ins averaged 1.7/5"));

    const good = buildDailyBrief(input({ recentMoods: [5, 5, 4, 1, 1] }));
    assert.ok(good.tips.some((t) => t.title === "Your last 3 check-ins averaged 4.7/5"));

    const single = buildDailyBrief(input({ recentMoods: [1] }));
    assert.ok(!single.tips.some((t) => t.source === "checkins"));
  });

  test("inventory: expired, expiring soon (singular/plural) and running low, at most 2 product tips", () => {
    const one = buildDailyBrief(input({ owned: [owned({ id: "a", customName: "Toner", expiresAt: daysFromNow(1) })] }));
    assert.ok(one.tips.some((t) => t.title === "Toner expires in 1 day"));
    const five = buildDailyBrief(input({ owned: [owned({ id: "a", customName: "Toner", expiresAt: daysFromNow(5) })] }));
    assert.ok(five.tips.some((t) => t.title === "Toner expires in 5 days"));
    const later = buildDailyBrief(input({ owned: [owned({ id: "a", customName: "Toner", expiresAt: daysFromNow(30) })] }));
    assert.ok(!later.tips.some((t) => t.source === "products"));

    const low = buildDailyBrief(input({ owned: [owned({ id: "a", customName: "Cleanser", quantityTotal: 100, quantityLeft: 10 })] }));
    assert.ok(low.tips.some((t) => t.title === "Running low on Cleanser"));

    const many = buildDailyBrief(
      input({
        owned: [
          owned({ id: "a", customName: "A", expiresAt: daysFromNow(-1) }),
          owned({ id: "b", customName: "B", expiresAt: daysFromNow(-2) }),
          owned({ id: "c", customName: "C", expiresAt: daysFromNow(3) }),
        ],
      }),
    );
    assert.equal(many.tips.filter((t) => t.source === "products").length, 2);
  });

  test("never more than 4 tips, ordered by signal priority (strongest first)", () => {
    const b = buildDailyBrief(
      input({
        conditions: conditions({ uvMax: 9, aqi: 160, humidity: 20, temp: 34 }),
        latestScan: scan("acne", 90),
        recentMoods: [1, 1, 1],
        owned: [owned({ id: "a", customName: "Old cream", expiresAt: daysFromNow(-1) })],
      }),
    );
    assert.equal(b.tips.length, 4);
    assert.equal(b.headline, "Very high UV — sun protection comes first today");
    // UV 90 > unhealthy air 85 > expired product 60 > dry air (normal skin) 55 > ... scan/check-ins/heat are cut.
    assert.deepEqual(b.tips.map((t) => t.source), ["uv", "air", "products", "humidity"]);
  });
});

describe("buildDailyBrief: product pick", () => {
  test("prefers a matching product the user already owns over the catalog", () => {
    const b = buildDailyBrief(
      input({ conditions: conditions({ uvMax: 9 }), owned: [owned({ id: "up1", customName: "My SPF stick", customBrand: "Indie" })], catalog: CATALOG }),
    );
    assert.deepEqual(b.pick, {
      productId: null,
      userProductId: "up1",
      name: "My SPF stick",
      brand: "Indie",
      category: null,
      price: null,
      owned: true,
      reason: "You already own this — reach for it today because UV peaks at 9 today.",
    });
  });

  test("catalog pick skips 'Not for me', over-budget, sensitivity conflicts and owned items; ties go to the cheaper one", () => {
    const disliked = product({ id: "d", name: "Liked-not Sunscreen SPF 50", category: "sunscreen", ingredients: ["zinc oxide"], price: 100 });
    const pricey = product({ id: "p", name: "Luxe Sunscreen SPF 50", category: "sunscreen", ingredients: ["zinc oxide"], price: 5000 });
    const scented = product({ id: "s", name: "Scented Sunscreen SPF 50", category: "sunscreen", ingredients: ["zinc oxide", "parfum"], price: 150 });
    const ownedExpired = product({ id: "o", name: "Old Sunscreen SPF 50", category: "sunscreen", ingredients: ["zinc oxide"], price: 120 });
    const cheap = product({ id: "c", name: "Basic Sunscreen SPF 30", category: "sunscreen", ingredients: ["zinc oxide"], price: 300 });
    const dearer = product({ id: "e", name: "Basic Sunscreen SPF 30", category: "sunscreen", ingredients: ["zinc oxide"], price: 400 });
    const b = buildDailyBrief(
      input({
        conditions: conditions({ uvMax: 9 }),
        skinProfile: profile({ monthlyBudget: 1000, sensitivities: ["Fragrance"] }),
        owned: [owned({ id: "up1", product: ownedExpired, expiresAt: daysFromNow(-1) })],
        catalog: [dearer, disliked, pricey, scented, ownedExpired, cheap],
        dislikedProductIds: new Set(["d"]),
      }),
    );
    assert.equal(b.pick?.productId, "c");
    assert.equal(b.pick?.price, 300);
  });

  test("returns no pick when every candidate is filtered out", () => {
    const b = buildDailyBrief(
      input({ conditions: conditions({ uvMax: 9 }), catalog: [sunscreen], dislikedProductIds: new Set(["sun"]) }),
    );
    assert.equal(b.pick, null);
  });

  test("with nothing pressing, the pick works toward the user's onboarding concerns", () => {
    const acneProduct = product({ id: "bha", name: "Clear Tonic", category: "toner", ingredients: ["salicylic acid"], price: 350 });
    const acne = buildDailyBrief(input({ skinProfile: profile({ concerns: ["Acne"] }), catalog: [...CATALOG, acneProduct] }));
    assert.equal(acne.pick?.productId, "bha");
    assert.match(acne.pick!.reason, /targets acne & breakouts, one of your goals/);

    const lines = buildDailyBrief(input({ skinProfile: profile({ concerns: ["Fine lines"] }), catalog: CATALOG }));
    // Retinol and vitamin C serums score equally for fine lines; the cheaper one wins the tie.
    assert.equal(lines.pick?.productId, "vitc");
    assert.match(lines.pick!.reason, /targets fine lines, one of your goals/);

    const generic = buildDailyBrief(input({ skinProfile: profile({ skinType: "Dry" }), catalog: CATALOG }));
    assert.match(generic.pick!.reason, /it suits dry skin/);
  });

  test(
    "never picks an owned product the user marked 'Not for me'",
    () => {
      const b = buildDailyBrief(
        input({
          conditions: conditions({ uvMax: 9 }),
          owned: [owned({ id: "up1", product: sunscreen })],
          dislikedProductIds: new Set(["sun"]),
        }),
      );
      assert.notEqual(b.pick?.productId, "sun");
    },
  );
});

describe("conflictsWithSensitivities", () => {
  test("matches ingredient aliases for a sensitivity, case-insensitively on the label", () => {
    assert.equal(conflictsWithSensitivities("aqua, glycerin, parfum", ["Fragrance"]), true);
    assert.equal(conflictsWithSensitivities("aqua, alcohol denat.", ["alcohol"]), true);
  });

  test("fatty alcohols, unknown sensitivity labels and empty lists don't conflict", () => {
    assert.equal(conflictsWithSensitivities("cetearyl alcohol, glycerin", ["Alcohol"]), false);
    assert.equal(conflictsWithSensitivities("parfum", ["gluten"]), false);
    assert.equal(conflictsWithSensitivities("parfum", []), false);
  });
});

// Builds the home screen's "Today's brief": a headline, a few tips that
// each cite the real data point behind them, and one product pick. It's
// deliberately rule-based rather than LLM-written so every sentence can be
// traced back to a number (UV, AQI, humidity, a scan score, a check-in,
// an expiry date) and the same inputs always give the same brief.
//
// Signals compete on priority; the strongest one sets the headline and
// decides what the product pick should do. The pick prefers something the
// user already owns over the catalog, and skips products they've marked
// "Not for me", products over budget, and products containing an
// ingredient they said they're sensitive to.

import type { Product, SkinProfile, UserProduct } from "@prisma/client";
import { CONCERN_DEFS, ConcernKey } from "./skinConcerns";
import type { ConcernScore } from "./faceAnalysis";
import type { SkinConditions } from "./environment";
import { sensitivityHits } from "./ingredientRules";

export type TipSource =
  | "uv"
  | "air"
  | "humidity"
  | "temperature"
  | "scan"
  | "checkins"
  | "products"
  | "routine";

export interface BriefTip {
  source: TipSource;
  title: string;
  detail: string;
}

export interface BriefPick {
  productId: string | null; // catalog id; null for a custom owned product
  userProductId: string | null; // set when the pick is something they own
  name: string;
  brand: string;
  category: string | null;
  price: number | null;
  owned: boolean;
  reason: string;
}

export interface DailyBrief {
  headline: string;
  summary: string;
  tips: BriefTip[];
  pick: BriefPick | null;
  conditions: SkinConditions | null;
}

export interface BriefInput {
  now: Date;
  conditions: SkinConditions | null;
  skinProfile: SkinProfile;
  latestScan: { items: ConcernScore[]; createdAt: Date } | null;
  recentMoods: number[]; // last 7 days, newest first, 1-5
  owned: (UserProduct & { product: Product | null })[]; // not finished
  hasMorningRoutine: boolean;
  morningRoutineHasSunscreen: boolean;
  catalog: Product[];
  dislikedProductIds: Set<string>;
}

// What the pick should address — matched against product name,
// category and ingredients text.
interface Need {
  categories: string[];
  keywords: string[];
  why: string; // finishes "…because <why>"
}

interface Signal {
  priority: number;
  headline?: string | undefined;
  tips: BriefTip[];
  need?: Need | undefined;
}

const MAX_TIPS = 4;
const SCAN_FRESH_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

// Onboarding concern labels → the face-scan concern vocabulary, so both
// sources can share CONCERN_DEFS keywords and tips.
const PROFILE_CONCERN_MAP: Record<string, ConcernKey> = {
  acne: "acne",
  pigmentation: "darkSpots",
  dryness: "dryness",
  dullness: "dullness",
  "large pores": "oiliness",
};

const PHOTOSENSITIZING = ["retinol", "retinal", "tretinoin", "glycolic", "lactic acid", "alpha hydroxy"];

function productText(p: { name: string; category?: string | null; ingredients?: string[] }) {
  return `${p.name} ${p.category ?? ""} ${(p.ingredients ?? []).join(" ")}`.toLowerCase();
}

function ownedName(up: BriefInput["owned"][number]) {
  return up.product?.name ?? up.customName ?? "a product you own";
}

function ownedText(up: BriefInput["owned"][number]) {
  return up.product ? productText(up.product) : `${up.customName ?? ""}`.toLowerCase();
}

function isExpired(up: BriefInput["owned"][number], now: Date) {
  return up.expiresAt != null && up.expiresAt.getTime() < now.getTime();
}

function dayOfYear(d: Date) {
  return Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / DAY_MS);
}

function uvSignal(input: BriefInput): Signal | null {
  const uv = input.conditions?.uvMax;
  if (uv == null) return null;

  const photosensitizer = input.owned.find(
    (up) => !isExpired(up, input.now) && PHOTOSENSITIZING.some((k) => ownedText(up).includes(k)),
  );
  const sunscreenNeed: Need = {
    categories: ["sunscreen"],
    keywords: ["spf", "sunscreen", "zinc oxide"],
    why: `UV peaks at ${uv} today`,
  };

  const tips: BriefTip[] = [];
  let priority: number;
  let headline: string;

  if (uv >= 8) {
    priority = 90;
    headline = "Very high UV — sun protection comes first today";
    tips.push({
      source: "uv",
      title: `UV index peaks at ${uv} (very high)`,
      detail:
        "Unprotected skin can burn in under 15 minutes. Use SPF 50, reapply every 2 hours outdoors, and stay in shade between 11am and 3pm.",
    });
  } else if (uv >= 6) {
    priority = 75;
    headline = "High UV today — don't skip sunscreen";
    tips.push({
      source: "uv",
      title: `UV index peaks at ${uv} (high)`,
      detail:
        "Apply SPF 30+ as the last morning step — about two finger-lengths for face and neck — and reapply if you're out past midday.",
    });
  } else if (uv >= 3) {
    priority = 45;
    headline = "Moderate UV — a daily SPF is enough";
    tips.push({
      source: "uv",
      title: `UV index peaks at ${uv} (moderate)`,
      detail:
        "Most UVA still passes through clouds and windows, which drives dark spots and early lines. SPF 30 in the morning covers it.",
    });
  } else if (photosensitizer) {
    priority = 25;
    headline = "Low UV today";
    tips.push({
      source: "uv",
      title: `UV is low (peak ${uv})`,
      detail: `Your ${ownedName(photosensitizer)} makes skin more sun-sensitive, so a light SPF is still worth it if you'll be outside.`,
    });
  } else {
    return null;
  }

  if (uv >= 6 && photosensitizer) {
    tips.push({
      source: "products",
      title: `Save your ${ownedName(photosensitizer)} for tonight`,
      detail: "Retinoids and AHAs thin the outer skin layer and raise burn risk — they belong in your evening routine on high-UV days.",
    });
  }

  if (uv >= 3 && input.hasMorningRoutine && !input.morningRoutineHasSunscreen) {
    tips.push({
      source: "routine",
      title: "Your morning routine has no sunscreen step",
      detail: "Add one as the final step so it's never the thing you forget.",
    });
  }

  return { priority, headline, tips, need: sunscreenNeed };
}

function airSignal(input: BriefInput): Signal | null {
  const aqi = input.conditions?.aqi;
  if (aqi == null || aqi < 60) return null;
  const pm = input.conditions?.pm25;
  const pmText = pm != null ? `, PM2.5 ${pm} µg/m³` : "";

  const need: Need = {
    categories: ["serum", "cleanser"],
    keywords: ["vitamin c", "ferulic", "niacinamide", "vitamin e"],
    why: `air quality is poor today (AQI ${aqi})`,
  };

  if (aqi >= 100) {
    return {
      priority: aqi >= 150 ? 85 : 70,
      headline: aqi >= 150 ? "Unhealthy air — cleanse well tonight" : "Polluted air today — give your skin a defence layer",
      tips: [
        {
          source: "air",
          title: `Air quality is ${aqi >= 150 ? "unhealthy" : "poor"} (AQI ${aqi}${pmText})`,
          detail:
            "Fine particles sit on skin and generate free radicals that dull it and clog pores. Double-cleanse tonight (oil or micellar first, then your cleanser), and use an antioxidant serum like vitamin C in the morning.",
        },
      ],
      need,
    };
  }

  return {
    priority: 35,
    tips: [
      {
        source: "air",
        title: `Moderate air quality (AQI ${aqi}${pmText})`,
        detail: "Nothing drastic — just cleanse thoroughly tonight rather than a quick rinse.",
      },
    ],
    need,
  };
}

function climateSignals(input: BriefInput): Signal[] {
  const c = input.conditions;
  const skin = input.skinProfile.skinType.toLowerCase();
  const oilProne = skin === "oily" || skin === "combination";
  const signals: Signal[] = [];

  if (c?.humidity != null && c.humidity < 35) {
    signals.push({
      priority: skin === "dry" ? 65 : 55,
      headline: "Dry air — focus on hydration",
      tips: [
        {
          source: "humidity",
          title: `Humidity is only ${c.humidity}%`,
          detail:
            "Dry air pulls water out of skin. Apply your hydrating serum and moisturizer on still-damp skin, and use a richer layer at night.",
        },
      ],
      need: {
        categories: ["serum", "moisturizer"],
        keywords: ["hyaluronic", "ceramide", "glycerin", "squalane"],
        why: `humidity is down to ${c.humidity}%`,
      },
    });
  } else if (c?.humidity != null && c.humidity >= 75) {
    signals.push({
      priority: oilProne ? 55 : 30,
      headline: oilProne ? "Humid day — keep layers light" : undefined,
      tips: [
        {
          source: "humidity",
          title: `Humidity is ${c.humidity}%`,
          detail: oilProne
            ? "Your skin barely needs occlusion today. Swap heavy creams for a gel moisturizer and keep blotting papers handy for midday shine."
            : "Skin holds water easily in this weather — a lighter moisturizer than usual will do.",
        },
      ],
      need: oilProne
        ? {
            categories: ["serum", "moisturizer"],
            keywords: ["niacinamide", "zinc", "gel", "oil-free", "salicylic"],
            why: `it's ${c.humidity}% humid and your skin is ${skin}`,
          }
        : undefined,
    });
  }

  if (c?.temp != null && c.temp >= 32) {
    signals.push({
      priority: 45,
      tips: [
        {
          source: "temperature",
          title: `It's ${c.temp}°C`,
          detail:
            "Sweat mixed with sunscreen and oil is a common breakout trigger. Rinse your face after heavy sweating, then reapply SPF.",
        },
      ],
    });
  } else if (c?.temp != null && c.temp <= 12) {
    signals.push({
      priority: skin === "dry" || skin === "sensitive" ? 55 : 40,
      headline: "Cold day — protect your skin barrier",
      tips: [
        {
          source: "temperature",
          title: `It's a cold ${c.temp}°C`,
          detail: "Cold wind strips the barrier. Wash with lukewarm (not hot) water and seal in moisture with a ceramide cream.",
        },
      ],
      need: {
        categories: ["moisturizer"],
        keywords: ["ceramide", "squalane", "shea"],
        why: `it's ${c.temp}°C and cold air weakens the skin barrier`,
      },
    });
  }

  return signals;
}

function scanSignal(input: BriefInput): Signal | null {
  const scan = input.latestScan;
  if (!scan) {
    return {
      priority: 15,
      tips: [
        {
          source: "scan",
          title: "Try a face scan",
          detail: "A quick selfie scan lets tomorrow's brief target what's actually showing on your skin.",
        },
      ],
    };
  }

  const ageDays = Math.floor((input.now.getTime() - scan.createdAt.getTime()) / DAY_MS);
  if (ageDays > SCAN_FRESH_DAYS) {
    return {
      priority: 20,
      tips: [
        {
          source: "scan",
          title: `Your last scan was ${ageDays} days ago`,
          detail: "Rescan to see what's changed — tips and picks will update to match.",
        },
      ],
    };
  }

  const top = scan.items.filter((c) => c.detected).sort((a, b) => b.score - a.score)[0];
  if (!top) return null;
  const def = CONCERN_DEFS[top.key as ConcernKey];
  if (!def) return null;

  // Rotate through the concern's tips day by day so the brief doesn't
  // repeat itself every morning.
  const tip = def.freeTips[dayOfYear(input.now) % def.freeTips.length] ?? def.freeTips[0] ?? "";
  const when = ageDays === 0 ? "today" : ageDays === 1 ? "yesterday" : `${ageDays} days ago`;

  return {
    priority: Math.min(60, Math.round(top.score * 0.6)),
    headline: `Focus on ${def.label.toLowerCase()} today`,
    tips: [
      {
        source: "scan",
        title: `${def.label} scored ${Math.round(top.score)}/100 on your scan ${when}`,
        detail: tip,
      },
    ],
    need: {
      categories: [],
      keywords: def.keywords,
      why: `${def.label.toLowerCase()} was the top concern on your latest scan`,
    },
  };
}

function checkInSignal(input: BriefInput): Signal | null {
  const moods = input.recentMoods.slice(0, 3);
  if (moods.length < 2) return null;
  const avg = moods.reduce((a, b) => a + b, 0) / moods.length;

  if (avg <= 2.3) {
    return {
      priority: 50,
      headline: "Rough few days — keep things gentle",
      tips: [
        {
          source: "checkins",
          title: `Your last ${moods.length} check-ins averaged ${avg.toFixed(1)}/5`,
          detail: "When skin's struggling, less is more: cleanse, moisturize, SPF. Skip exfoliants and retinol until it settles.",
        },
      ],
      need: {
        categories: ["moisturizer", "cleanser"],
        keywords: ["ceramide", "hyaluronic", "gentle", "squalane"],
        why: "your recent check-ins suggest your skin needs calm, not actives",
      },
    };
  }

  if (avg >= 4 && moods.length >= 3) {
    return {
      priority: 10,
      tips: [
        {
          source: "checkins",
          title: `Your last ${moods.length} check-ins averaged ${avg.toFixed(1)}/5`,
          detail: "What you're doing is working — stay consistent and avoid adding new products this week.",
        },
      ],
    };
  }

  return null;
}

function inventorySignal(input: BriefInput): Signal | null {
  const tips: BriefTip[] = [];
  let priority = 0;

  for (const up of input.owned) {
    if (up.expiresAt == null) continue;
    const daysLeft = Math.ceil((up.expiresAt.getTime() - input.now.getTime()) / DAY_MS);
    if (daysLeft < 0) {
      priority = Math.max(priority, 60);
      tips.push({
        source: "products",
        title: `Your ${ownedName(up)} has expired`,
        detail: "Expired actives lose strength and preservatives weaken, which can irritate skin. Time to replace it.",
      });
    } else if (daysLeft <= 14) {
      priority = Math.max(priority, 30);
      tips.push({
        source: "products",
        title: `${ownedName(up)} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        detail: "Use it generously while it's still good.",
      });
    }
  }

  for (const up of input.owned) {
    if (up.quantityLeft == null || !up.quantityTotal) continue;
    if (up.quantityLeft / up.quantityTotal <= 0.15 && !isExpired(up, input.now)) {
      priority = Math.max(priority, 20);
      tips.push({
        source: "products",
        title: `Running low on ${ownedName(up)}`,
        detail: "Worth restocking now so there's no gap in your routine.",
      });
    }
  }

  return tips.length ? { priority, tips: tips.slice(0, 2) } : null;
}

// Fallback when nothing today is pressing: work toward what they told us
// in onboarding.
function profileNeed(profile: SkinProfile): Need {
  for (const concern of profile.concerns) {
    const key = PROFILE_CONCERN_MAP[concern.toLowerCase()];
    if (key) {
      return {
        categories: [],
        keywords: CONCERN_DEFS[key].keywords,
        why: `it targets ${CONCERN_DEFS[key].label.toLowerCase()}, one of your goals`,
      };
    }
  }
  if (profile.concerns.some((c) => c.toLowerCase() === "fine lines")) {
    return { categories: ["serum"], keywords: ["retinol", "peptide", "vitamin c"], why: "it targets fine lines, one of your goals" };
  }
  return {
    categories: ["moisturizer"],
    keywords: ["ceramide", "hyaluronic"],
    why: `it suits ${profile.skinType.toLowerCase()} skin`,
  };
}

function matchScore(text: string, category: string | null, need: Need) {
  let score = 0;
  if (category && need.categories.includes(category.toLowerCase())) score += 2;
  for (const k of need.keywords) if (text.includes(k)) score += 3;
  return score;
}

export function conflictsWithSensitivities(text: string, sensitivities: string[]) {
  return sensitivityHits(text, sensitivities).length > 0;
}

function pickProduct(input: BriefInput, need: Need): BriefPick | null {
  const { skinProfile } = input;

  const ownedBest = input.owned
    .filter((up) => !isExpired(up, input.now))
    .map((up) => ({ up, score: matchScore(ownedText(up), up.product?.category ?? null, need) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  if (ownedBest) {
    const { up } = ownedBest;
    return {
      productId: up.productId,
      userProductId: up.id,
      name: ownedName(up),
      brand: up.product?.brand ?? up.customBrand ?? "",
      category: up.product?.category ?? null,
      price: null,
      owned: true,
      reason: `You already own this — reach for it today because ${need.why}.`,
    };
  }

  const ownedIds = new Set(input.owned.map((up) => up.productId).filter(Boolean));
  const budget = skinProfile.monthlyBudget;

  const catalogBest = input.catalog
    .filter((p) => !ownedIds.has(p.id))
    .filter((p) => !input.dislikedProductIds.has(p.id))
    .filter((p) => (budget ? p.price <= budget : true))
    .filter((p) => !conflictsWithSensitivities(productText(p), skinProfile.sensitivities))
    .map((p) => ({ p, score: matchScore(productText(p), p.category, need) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.price - b.p.price)[0];

  if (!catalogBest) return null;
  const { p } = catalogBest;
  const ingredients = p.ingredients.join(" ").toLowerCase();
  const matched = need.keywords.filter((k) => ingredients.includes(k)).slice(0, 2);
  const via = matched.length
    ? ` Key ingredient${matched.length > 1 ? "s" : ""}: ${matched.join(" and ")}.`
    : "";

  return {
    productId: p.id,
    userProductId: null,
    name: p.name,
    brand: p.brand,
    category: p.category,
    price: p.price,
    owned: false,
    reason: `Worth considering because ${need.why}.${via}`,
  };
}

export function buildDailyBrief(input: BriefInput): DailyBrief {
  const signals = [
    uvSignal(input),
    airSignal(input),
    ...climateSignals(input),
    scanSignal(input),
    checkInSignal(input),
    inventorySignal(input),
  ]
    .filter((s): s is Signal => s != null)
    .sort((a, b) => b.priority - a.priority);

  const tips = signals.flatMap((s) => s.tips).slice(0, MAX_TIPS);
  const lead = signals.find((s) => s.headline);
  const needSignal = signals.find((s) => s.need);
  const need = needSignal?.need ?? profileNeed(input.skinProfile);

  const headline = lead?.headline ?? "Calm conditions — keep your routine steady";
  const c = input.conditions;
  const summaryParts = [
    c?.temp != null ? `${c.temp}°C` : null,
    c?.humidity != null ? `${c.humidity}% humidity` : null,
    c?.uvMax != null ? `UV ${c.uvMax}` : null,
    c?.aqi != null ? `AQI ${c.aqi}` : null,
  ].filter(Boolean);
  const summary = summaryParts.length
    ? `Built from today's local conditions (${summaryParts.join(" · ")}) and your ${input.skinProfile.skinType.toLowerCase()} skin profile.`
    : `Built from your ${input.skinProfile.skinType.toLowerCase()} skin profile — allow location for weather, UV and air quality.`;

  return {
    headline,
    summary,
    tips,
    pick: pickProduct(input, need),
    conditions: c,
  };
}

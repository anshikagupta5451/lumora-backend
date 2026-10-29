// "Is this right for me?" — a rule-based verdict on one product for one
// user, for someone standing in a shop with the product in hand. Every
// check cites the concrete reason (an ingredient, a product they own, a
// number), and nothing here calls an AI model. The match percentage and
// per-concern bars are computed from the same checks.

import type { Product, SkinProfile, UserProduct } from "@prisma/client";
import { CONCERN_DEFS, ConcernKey } from "./skinConcerns";
import {
  ACTIVE_CLASHES,
  PORE_CLOGGING,
  SKIN_TYPE_GOOD,
  SENSITIVITY_INGREDIENTS,
  activesIn,
  findAny,
  ingredientText,
  sensitivityHits,
} from "./ingredientRules";

export type CheckStatus = "good" | "caution" | "bad" | "info";

export interface VerdictCheck {
  kind: "sensitivity" | "skinType" | "concerns" | "owned" | "clash" | "budget" | "community" | "usage" | "ingredients";
  status: CheckStatus;
  title: string;
  detail: string;
}

// How well the product addresses one of the user's concerns.
export interface ConcernFit {
  label: string;
  percent: number | null; // null when the ingredient list is unknown
  fromScan: boolean;
  reason: string;
}

// "78% match for you": a number that sums up the checks below it. Null
// without a skin profile or an ingredient list, since there's nothing to
// score then. Budget is left out, like in the overall verdict.
export interface MatchScore {
  percent: number | null;
  concerns: ConcernFit[];
}

export interface Verdict {
  overall: "great" | "good" | "caution" | "avoid" | "unknown";
  headline: string;
  checks: VerdictCheck[];
  match: MatchScore;
}

export interface VerdictProduct {
  id: string | null;
  name: string;
  category: string | null;
  ingredients: string[];
  price: number | null;
}

export interface CommunityStats {
  count: number;
  avg: number | null;
  sameSkinCount: number;
  sameSkinAvg: number | null;
}

export interface VerdictInput {
  product: VerdictProduct;
  profile: SkinProfile | null;
  scanConcerns: ConcernKey[];
  owned: (UserProduct & { product: Product | null })[];
  community: CommunityStats;
}

// Onboarding concern labels → what targets them.
const PROFILE_CONCERNS: Record<string, { label: string; keywords: string[] }> = {
  acne: { label: "acne", keywords: CONCERN_DEFS.acne.keywords },
  pigmentation: { label: "pigmentation", keywords: CONCERN_DEFS.darkSpots.keywords },
  dryness: { label: "dryness", keywords: CONCERN_DEFS.dryness.keywords },
  dullness: { label: "dullness", keywords: CONCERN_DEFS.dullness.keywords },
  "large pores": { label: "large pores", keywords: ["niacinamide", "salicylic acid", "clay", "zinc"] },
  "fine lines": { label: "fine lines", keywords: ["retinol", "retinal", "peptide", "bakuchiol", "vitamin c", "ascorbic"] },
};

const SINGLE_USE_CATEGORIES = ["sunscreen", "moisturizer", "cleanser", "toner"];

function ownedName(up: VerdictInput["owned"][number]) {
  return up.product?.name ?? up.customName ?? "a product you own";
}

function skinCheck(text: string, skinType: string): VerdictCheck | null {
  const skin = skinType.toLowerCase();
  const pretty = skin === "combo" ? "combination" : skin;

  if (skin === "oily" || skin === "combo" || skin === "combination") {
    const clogger = findAny(text, PORE_CLOGGING);
    if (clogger) {
      return {
        kind: "skinType",
        status: "caution",
        title: `Contains ${clogger}`,
        detail: `Often reported to clog pores on ${pretty} skin. Patch-test on your jawline first.`,
      };
    }
  }
  if (skin === "sensitive") {
    const irritant = findAny(text, [
      ...SENSITIVITY_INGREDIENTS.fragrance!,
      ...SENSITIVITY_INGREDIENTS["essential oils"]!,
      "glycolic acid",
      "alcohol denat",
    ]);
    if (irritant) {
      return {
        kind: "skinType",
        status: "caution",
        title: `Contains ${irritant}`,
        detail: "A common trigger for sensitive skin — patch-test behind your ear for 24 hours first.",
      };
    }
  }
  if (skin === "dry") {
    const drying = findAny(text, ["alcohol denat", "sodium lauryl sulfate", "denatured alcohol"]);
    if (drying) {
      return {
        kind: "skinType",
        status: "caution",
        title: `Contains ${drying}`,
        detail: "Can strip moisture from dry skin. Follow with a rich moisturizer if you use it.",
      };
    }
  }

  const good = findAny(text, SKIN_TYPE_GOOD[skin === "combo" ? "combination" : skin] ?? []);
  if (good) {
    return {
      kind: "skinType",
      status: "good",
      title: `Suits ${pretty} skin`,
      detail: `Has ${good}, which works well for ${pretty} skin.`,
    };
  }
  return null;
}

function concernCheck(text: string, input: VerdictInput): VerdictCheck | null {
  const targets: { label: string; via: string; fromScan: boolean }[] = [];

  for (const key of input.scanConcerns) {
    const def = CONCERN_DEFS[key];
    const via = findAny(text, def.keywords);
    if (via) targets.push({ label: def.label.toLowerCase(), via, fromScan: true });
  }
  for (const c of input.profile?.concerns ?? []) {
    const def = PROFILE_CONCERNS[c.toLowerCase()];
    if (!def || targets.some((t) => t.label.includes(def.label))) continue;
    const via = findAny(text, def.keywords);
    if (via) targets.push({ label: def.label, via, fromScan: false });
  }

  if (targets.length) {
    const t = targets.slice(0, 2);
    return {
      kind: "concerns",
      status: "good",
      title: `Targets ${t.map((x) => x.label).join(" and ")}`,
      detail: `${t
        .map((x) => `${x.via} for ${x.label}${x.fromScan ? " (from your face scan)" : ""}`)
        .join("; ")}.`,
    };
  }

  const wanted = [
    ...input.scanConcerns.map((k) => CONCERN_DEFS[k].label.toLowerCase()),
    ...(input.profile?.concerns ?? []),
  ];
  if (!wanted.length) return null;
  return {
    kind: "concerns",
    status: "info",
    title: "Doesn't target your main concerns",
    detail: `Nothing in it specifically addresses ${[...new Set(wanted)].slice(0, 2).join(" or ")}. Fine as a basic, but not a fix.`,
  };
}

function ownedChecks(text: string, input: VerdictInput): VerdictCheck[] {
  const checks: VerdictCheck[] = [];
  const { product } = input;
  const usable = input.owned.filter((up) => !up.isFinished);

  if (product.id && usable.some((up) => up.productId === product.id)) {
    checks.push({
      kind: "owned",
      status: "info",
      title: "You already own this",
      detail: "It's on your shelf in My Products — finish that one first.",
    });
    return checks;
  }

  const category = product.category?.toLowerCase() ?? null;
  if (category && SINGLE_USE_CATEGORIES.includes(category)) {
    const same = usable.filter((up) => up.product?.category?.toLowerCase() === category);
    if (same.length) {
      checks.push({
        kind: "owned",
        status: "info",
        title: `You already have a ${category}`,
        detail: `${same.map(ownedName).slice(0, 2).join(" and ")}. Most routines only need one — buy this as a replacement, not an extra.`,
      });
    }
  }

  const mine = activesIn(text);
  const clashes: VerdictCheck[] = [];
  const duplicates: string[] = [];
  for (const up of usable) {
    if (!up.product) continue;
    const theirs = activesIn(ingredientText(up.product.ingredients, up.product.name));
    for (const [a, b, why] of ACTIVE_CLASHES) {
      if ((mine.has(a) && theirs.has(b)) || (mine.has(b) && theirs.has(a))) {
        if (clashes.length < 2) {
          clashes.push({
            kind: "clash",
            status: "caution",
            title: `Clashes with your ${ownedName(up)}`,
            detail: why,
          });
        }
      }
    }
    for (const active of mine) {
      if (theirs.has(active) && !["hyaluronic acid", "ceramides"].includes(active)) {
        duplicates.push(`${active} (${ownedName(up)})`);
      }
    }
  }

  checks.push(...clashes);
  if (duplicates.length) {
    checks.push({
      kind: "owned",
      status: "info",
      title: "Doubles up on actives you already use",
      detail: `You already get ${[...new Set(duplicates)].slice(0, 2).join(" and ")}. Using both is usually fine, but you may not need this.`,
    });
  }
  return checks;
}

function budgetCheck(input: VerdictInput): VerdictCheck | null {
  const price = input.product.price;
  const budget = input.profile?.monthlyBudget ?? null;
  if (!price) {
    return {
      kind: "budget",
      status: "info",
      title: "Price not known",
      detail: "Compare the shelf price with your monthly budget.",
    };
  }
  if (!budget) return null;
  const pct = Math.round((price / budget) * 100);
  if (price > budget) {
    return {
      kind: "budget",
      // Money, not suitability — so a caution, never a "bad".
      status: "caution",
      title: "Over your monthly budget",
      detail: `₹${price} is more than your ₹${budget} a month.`,
    };
  }
  return {
    kind: "budget",
    status: pct > 60 ? "caution" : "good",
    title: pct > 60 ? "Uses most of your budget" : "Fits your budget",
    detail: `₹${price} is ${pct}% of your ₹${budget} monthly budget.`,
  };
}

function communityCheck(input: VerdictInput): VerdictCheck {
  const c = input.community;
  const skin = input.profile?.skinType?.toLowerCase();
  if (!c.count || c.avg == null) {
    return {
      kind: "community",
      status: "info",
      title: "No reviews yet",
      detail: "Be the first to review it once you've tried it.",
    };
  }
  const useSkin = c.sameSkinCount >= 2 && c.sameSkinAvg != null;
  const avg = useSkin ? c.sameSkinAvg! : c.avg;
  const count = useSkin ? c.sameSkinCount : c.count;
  const who = useSkin ? `reviewers with ${skin} skin` : "reviewers";
  return {
    kind: "community",
    status: count >= 2 && avg >= 4 ? "good" : count >= 2 && avg <= 2.5 ? "caution" : "info",
    title: `${avg.toFixed(1)}★ from ${count} ${count === 1 ? who.replace("reviewers", "reviewer") : who}`,
    detail:
      count >= 2 && avg <= 2.5
        ? "People like you haven't loved it — read their reviews first."
        : "Read what they said in the reviews below.",
  };
}

// Onboarding concerns that are the same thing as a face-scan concern, so
// "acne" from the quiz and "Acne & breakouts" from a scan show one bar.
const PROFILE_TO_SCAN: Record<string, ConcernKey> = {
  acne: "acne",
  pigmentation: "darkSpots",
  dryness: "dryness",
  dullness: "dullness",
};

// More of the ingredients known to target a concern means a better fit.
// Ingredient amounts aren't on labels, so this counts, it doesn't weigh.
const FIT_BY_HITS = [10, 70, 85, 95];

function concernFits(text: string, hasIngredients: boolean, input: VerdictInput): ConcernFit[] {
  const wanted: { label: string; keywords: string[]; fromScan: boolean; key: string }[] = [];
  for (const key of input.scanConcerns) {
    const def = CONCERN_DEFS[key];
    wanted.push({ key, label: def.label, keywords: def.keywords, fromScan: true });
  }
  for (const c of input.profile?.concerns ?? []) {
    const name = c.toLowerCase();
    const def = PROFILE_CONCERNS[name];
    const key = PROFILE_TO_SCAN[name] ?? name;
    if (!def || wanted.some((w) => w.key === key)) continue;
    const label = def.label.charAt(0).toUpperCase() + def.label.slice(1);
    wanted.push({ key, label, keywords: def.keywords, fromScan: false });
  }

  return wanted.map(({ label, keywords, fromScan }) => {
    if (!hasIngredients) {
      return { label, percent: null, fromScan, reason: "Ingredient list unknown" };
    }
    const hits = keywords.filter((k) => findAny(text, [k]));
    return {
      label,
      percent: FIT_BY_HITS[Math.min(hits.length, FIT_BY_HITS.length - 1)]!,
      fromScan,
      reason: hits.length
        ? `Has ${hits.slice(0, 3).join(", ")}`
        : `Nothing in it targets ${label.toLowerCase()}`,
    };
  });
}

// Starts from how well it targets your concerns (45–88), or 70 when you
// have none, then moves with the other checks. A sensitivity hit caps it
// low whatever else is good about the product.
function matchPercent(checks: VerdictCheck[], concerns: ConcernFit[]): number {
  const fits = concerns.map((c) => c.percent).filter((p): p is number => p != null);
  let score = fits.length ? 40 + fits.reduce((s, p) => s + p, 0) / fits.length / 2 : 70;

  for (const c of checks) {
    if (c.kind === "skinType") score += c.status === "good" ? 10 : -15;
    if (c.kind === "sensitivity" && c.status === "good") score += 5;
    if (c.kind === "clash") score -= 10;
    if (c.kind === "community") score += c.status === "good" ? 5 : c.status === "caution" ? -10 : 0;
  }
  if (checks.some((c) => c.kind === "sensitivity" && c.status === "bad")) score = Math.min(score, 15);
  return Math.round(Math.max(0, Math.min(100, score)));
}

const ORDER: Record<CheckStatus, number> = { bad: 0, caution: 1, good: 2, info: 3 };

export function buildVerdict(input: VerdictInput): Verdict {
  const { product, profile } = input;
  const text = ingredientText(product.ingredients, product.name);
  const hasIngredients = product.ingredients.length > 0;
  const checks: VerdictCheck[] = [];

  if (!hasIngredients) {
    checks.push({
      kind: "ingredients",
      status: "info",
      title: "No ingredient list on file",
      detail: "Ingredient checks are limited — read the label on the back for anything you avoid.",
    });
  }

  const sensitivities = (profile?.sensitivities ?? []).filter((s) => !/none/i.test(s));
  const hits = sensitivityHits(text, sensitivities);
  if (hits.length) {
    for (const h of hits) {
      checks.push({
        kind: "sensitivity",
        status: "bad",
        title: `Contains ${h.found}`,
        detail: `You said you're sensitive to ${h.label}.`,
      });
    }
  } else if (sensitivities.length && hasIngredients) {
    checks.push({
      kind: "sensitivity",
      status: "good",
      title: `Free of ${sensitivities.join(", ").toLowerCase()}`,
      detail: "Nothing on the ingredient list matches what you said you're sensitive to.",
    });
  }

  if (profile && hasIngredients) {
    const s = skinCheck(text, profile.skinType);
    if (s) checks.push(s);
  }
  if (hasIngredients) {
    const c = concernCheck(text, input);
    if (c) checks.push(c);
  }
  checks.push(...ownedChecks(text, input));

  const b = budgetCheck(input);
  if (b) checks.push(b);
  checks.push(communityCheck(input));

  const actives = activesIn(text);
  if (actives.has("retinoid") || actives.has("aha")) {
    checks.push({
      kind: "usage",
      status: "info",
      title: "Use it at night",
      detail: "It makes skin more sun-sensitive — wear SPF the next morning, and start 2–3 nights a week.",
    });
  }

  checks.sort((a, b) => ORDER[a.status] - ORDER[b.status]);

  // Suitability is judged without the budget; being over budget is then
  // called out in the headline instead of turning a good match into "avoid".
  const overBudget = checks.some((c) => c.kind === "budget" && c.title === "Over your monthly budget");
  const skinChecks = checks.filter((c) => c.kind !== "budget");
  const count = (s: CheckStatus) => skinChecks.filter((c) => c.status === s).length;
  const bad = count("bad");
  const caution = count("caution");
  const good = count("good");

  let overall: Verdict["overall"];
  let headline: string;
  if (!profile) {
    overall = "unknown";
    headline = "Finish your skin quiz for a personal verdict";
  } else if (bad) {
    overall = "avoid";
    headline = "Probably not for you";
  } else if (good >= 2 && caution === 0) {
    overall = "great";
    headline = "Great match for you";
  } else if (caution >= 2 || (caution >= 1 && good === 0)) {
    overall = "caution";
    headline = "Check before you buy";
  } else if (good === 0) {
    // Only info notes (no ingredient list, price or reviews): nothing to judge.
    overall = "unknown";
    headline = "Not enough info to judge this one yet";
  } else {
    overall = "good";
    headline = "Good fit";
  }

  if (overBudget && (overall === "great" || overall === "good")) {
    overall = "caution";
    headline = "Good for your skin, but over budget";
  }

  const concerns = concernFits(text, hasIngredients, input);
  const match: MatchScore = {
    percent: profile && hasIngredients ? matchPercent(checks, concerns) : null,
    concerns,
  };

  return { overall, headline, checks, match };
}

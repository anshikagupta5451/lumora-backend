// Product suggestions for a face scan, from one of three sources the user
// picks on the results screen:
//
//   owned    — products they've logged in My Products that target each
//              concern. Costs nothing extra, so budget doesn't apply.
//   promoted — Lumora's catalog, with products we're promoting
//              (Product.isPromoted) ranked first and labelled "Featured".
//   web      — products found by Gemini (see webProductSearch.ts), not
//              limited to our catalog.
//
// For promoted and web, the monthly budget is treated as a total across
// every concern, not a per-product cap: products are added
// highest-scoring concern first until the budget runs out, and a product
// that covers several concerns is only counted once.

import type { Product, SkinProfile, UserProduct } from "@prisma/client";
import { CONCERN_DEFS, ConcernKey } from "./skinConcerns";
import type { ConcernScore } from "./faceAnalysis";
import { conflictsWithSensitivities } from "./dailyBrief";

export type SuggestionSource = "owned" | "promoted" | "web";

export interface SuggestedItem {
  productId: string | null; // catalog product, when there is one
  userProductId: string | null; // set for owned products
  name: string;
  brand: string;
  price: number | null; // ₹; null for owned products
  category: string | null;
  keyIngredient: string | null;
  why: string;
  tag: "owned" | "featured" | "catalog" | "web";
  url: string | null; // external link for web results
  alsoFor: string[]; // every concern label this product was picked for (UI hides the current one)
}

export interface ConcernSuggestions {
  key: string;
  label: string;
  score: number;
  freeTips: string[];
  items: SuggestedItem[];
  emptyReason: string | null;
}

export interface SuggestionPlan {
  total: number;
  budget: number | null;
  productCount: number;
}

export type OwnedProduct = UserProduct & { product: Product | null };

const PER_CONCERN = 2;

export function detectedConcerns(items: ConcernScore[]) {
  return items
    .filter((c) => c.detected && CONCERN_DEFS[c.key as ConcernKey])
    .sort((a, b) => b.score - a.score);
}

function catalogText(p: Product) {
  return `${p.name} ${p.ingredients.join(" ")}`.toLowerCase();
}

function ownedLabel(up: OwnedProduct) {
  return up.product?.name ?? up.customName ?? "Your product";
}

// First keyword the text contains, in the concern's priority order.
function matchedKeyword(text: string, keywords: string[]) {
  return keywords.find((k) => text.includes(k)) ?? null;
}

function baseConcern(c: ConcernScore): Omit<ConcernSuggestions, "items" | "emptyReason"> {
  const def = CONCERN_DEFS[c.key as ConcernKey];
  return { key: c.key, label: def.label, score: c.score, freeTips: def.freeTips };
}

export function ownedSuggestions(concerns: ConcernScore[], owned: OwnedProduct[], now: Date) {
  const usable = owned.filter(
    (up) => !up.isFinished && !(up.expiresAt && up.expiresAt.getTime() < now.getTime()),
  );

  const result: ConcernSuggestions[] = concerns.map((c) => {
    const def = CONCERN_DEFS[c.key as ConcernKey];
    const items: SuggestedItem[] = [];
    for (const up of usable) {
      const text = up.product ? catalogText(up.product) : (up.customName ?? "").toLowerCase();
      const kw = matchedKeyword(text, def.keywords);
      if (!kw) continue;
      items.push({
        productId: up.productId,
        userProductId: up.id,
        name: ownedLabel(up),
        brand: up.product?.brand ?? up.customBrand ?? "",
        price: null,
        category: up.product?.category ?? null,
        keyIngredient: kw,
        why: `Contains ${kw}, which targets ${def.label.toLowerCase()}. Use it consistently for 6–8 weeks before judging.`,
        tag: "owned",
        url: null,
        alsoFor: [],
      });
    }
    return {
      ...baseConcern(c),
      items: items.slice(0, PER_CONCERN),
      emptyReason: items.length
        ? null
        : usable.length
          ? "Nothing you own targets this yet."
          : "You haven't added any products yet — add them in My Products.",
    };
  });

  return { concerns: result, plan: { total: 0, budget: null, productCount: 0 } as SuggestionPlan };
}

interface Candidate {
  item: SuggestedItem;
  rank: number;
}

// Greedy fill: round 1 gives every concern (worst first) its best
// affordable option, round 2 adds a second option where budget remains.
// The same product chosen for two concerns costs once and is noted.
export function planWithinBudget(
  concerns: ConcernScore[],
  candidatesFor: (c: ConcernScore) => Candidate[],
  budget: number | null,
) {
  const chosen = new Map<string, SuggestedItem[]>(concerns.map((c) => [c.key, []]));
  const bought = new Map<string, SuggestedItem>(); // identity → item
  const identity = (i: SuggestedItem) => i.productId ?? `${i.brand}|${i.name}`.toLowerCase();
  let total = 0;
  const pools = new Map(
    concerns.map((c) => [c.key, candidatesFor(c).sort((a, b) => b.rank - a.rank)]),
  );

  for (let round = 0; round < PER_CONCERN; round++) {
    for (const c of concerns) {
      const pool = pools.get(c.key)!;
      const picks = chosen.get(c.key)!;
      if (picks.length > round) continue;
      for (const cand of pool) {
        const id = identity(cand.item);
        if (picks.some((p) => identity(p) === id)) continue;
        const already = bought.get(id);
        if (already) {
          already.alsoFor.push(CONCERN_DEFS[c.key as ConcernKey].label);
          picks.push(already);
          break;
        }
        const price = cand.item.price ?? 0;
        if (budget != null && total + price > budget) continue;
        total += price;
        const item = { ...cand.item, alsoFor: [CONCERN_DEFS[c.key as ConcernKey].label] };
        bought.set(id, item);
        picks.push(item);
        break;
      }
    }
  }

  const result: ConcernSuggestions[] = concerns.map((c) => {
    const items = chosen.get(c.key)!;
    const hadCandidates = (pools.get(c.key)?.length ?? 0) > 0;
    return {
      ...baseConcern(c),
      items,
      emptyReason: items.length
        ? null
        : hadCandidates && budget != null
          ? `Nothing for this fits in what's left of your ₹${budget} budget.`
          : "No matching products found for this concern.",
    };
  });

  return {
    concerns: result,
    plan: { total, budget, productCount: bought.size } as SuggestionPlan,
  };
}

export function promotedSuggestions(
  concerns: ConcernScore[],
  catalog: Product[],
  owned: OwnedProduct[],
  profile: SkinProfile | null,
) {
  const ownedIds = new Set(owned.map((up) => up.productId).filter(Boolean));
  const sensitivities = profile?.sensitivities ?? [];
  const usable = catalog.filter(
    (p) => !ownedIds.has(p.id) && !conflictsWithSensitivities(catalogText(p), sensitivities),
  );

  return planWithinBudget(
    concerns,
    (c) => {
      const def = CONCERN_DEFS[c.key as ConcernKey];
      return usable.flatMap((p) => {
        const text = catalogText(p);
        const hits = def.keywords.filter((k) => text.includes(k));
        if (!hits.length) return [];
        return [
          {
            // Featured first, then stronger ingredient match, then cheaper.
            rank: (p.isPromoted ? 1000 : 0) + hits.length * 100 - p.price / 100,
            item: {
              productId: p.id,
              userProductId: null,
              name: p.name,
              brand: p.brand,
              price: p.price > 0 ? p.price : null, // 0 = unknown (e.g. added via barcode scan)
              category: p.category,
              keyIngredient: hits[0]!,
              why: `Its ${hits.slice(0, 2).join(" and ")} target${hits.length > 1 ? "" : "s"} ${def.label.toLowerCase()}.`,
              tag: p.isPromoted ? "featured" : "catalog",
              url: null,
              alsoFor: [],
            } satisfies SuggestedItem,
          },
        ];
      });
    },
    profile?.monthlyBudget ?? null,
  );
}

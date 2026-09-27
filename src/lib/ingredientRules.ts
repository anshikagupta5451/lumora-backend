// Plain ingredient knowledge used by the product verdict (and the daily
// brief's sensitivity filter). Substring matching against lowercased
// ingredient text, same approach as skinConcerns.ts — no AI.

export interface IngredientHit {
  label: string; // human-friendly name for the group
  found: string; // the exact ingredient text that matched
}

// Onboarding sensitivity labels → ingredient names that trigger them.
// Fatty alcohols (cetyl, cetearyl, stearyl) are deliberately absent: they
// are moisturising and don't irritate like drying alcohols do.
export const SENSITIVITY_INGREDIENTS: Record<string, string[]> = {
  fragrance: ["fragrance", "parfum", "perfume", "linalool", "limonene", "citronellol", "geraniol", "eugenol", "coumarin", "hexyl cinnamal", "benzyl salicylate"],
  alcohol: ["alcohol denat", "denatured alcohol", "sd alcohol", "ethanol", "isopropyl alcohol", "ethyl alcohol"],
  sulfates: ["sodium lauryl sulfate", "sodium laureth sulfate", "ammonium lauryl sulfate", "ammonium laureth sulfate", "sodium coco sulfate", "sulphate"],
  "essential oils": ["essential oil", "tea tree", "melaleuca", "lavender oil", "lavandula", "eucalyptus", "peppermint", "mentha", "citrus", "lemon peel oil", "orange peel oil", "bergamot", "rosemary leaf oil"],
};

// Ingredients commonly reported to clog pores for oily/acne-prone skin.
export const PORE_CLOGGING = ["coconut oil", "cocos nucifera oil", "cocoa butter", "theobroma cacao", "isopropyl myristate", "isopropyl palmitate", "lanolin", "wheat germ oil", "algae extract", "laureth-4", "myristyl myristate"];

// Actives worth knowing about, for duplicate and clash checks.
export const ACTIVES: Record<string, string[]> = {
  retinoid: ["retinol", "retinal", "retinaldehyde", "retinyl", "tretinoin", "adapalene", "bakuchiol"],
  aha: ["glycolic acid", "lactic acid", "mandelic acid", "alpha hydroxy"],
  bha: ["salicylic acid", "beta hydroxy"],
  "benzoyl peroxide": ["benzoyl peroxide"],
  "vitamin c": ["ascorbic acid", "vitamin c", "ascorbyl", "ethyl ascorbic"],
  niacinamide: ["niacinamide"],
  "hyaluronic acid": ["hyaluronic", "sodium hyaluronate"],
  ceramides: ["ceramide"],
  "sunscreen filters": ["zinc oxide", "titanium dioxide", "avobenzone", "butyl methoxydibenzoylmethane", "octocrylene", "ethylhexyl methoxycinnamate", "octinoxate", "bemotrizinol", "bis-ethylhexyloxyphenol", "uvinul", "tinosorb"],
};

// Pairs that irritate when layered in the same routine.
export const ACTIVE_CLASHES: [string, string, string][] = [
  ["retinoid", "aha", "Retinoids and AHAs together often cause redness and peeling — use them on alternate nights."],
  ["retinoid", "bha", "Retinoids and salicylic acid together can over-dry skin — alternate nights."],
  ["retinoid", "benzoyl peroxide", "Benzoyl peroxide can deactivate retinoids — use one in the morning and one at night."],
  ["vitamin c", "benzoyl peroxide", "Benzoyl peroxide oxidises vitamin C — keep them in separate routines."],
  ["aha", "bha", "Two exfoliating acids together can over-exfoliate — alternate days."],
];

// Ingredients that suit (or are worth watching for) each skin type.
export const SKIN_TYPE_GOOD: Record<string, string[]> = {
  oily: ["niacinamide", "salicylic acid", "zinc", "clay", "kaolin", "green tea"],
  combination: ["niacinamide", "hyaluronic", "sodium hyaluronate", "green tea"],
  dry: ["ceramide", "hyaluronic", "sodium hyaluronate", "glycerin", "squalane", "shea", "panthenol"],
  sensitive: ["centella", "cica", "panthenol", "allantoin", "ceramide", "oat", "madecassoside"],
  normal: [],
};

export function ingredientText(ingredients: string[], name = "") {
  return `${name} ${ingredients.join(", ")}`.toLowerCase();
}

export function findAny(text: string, needles: string[]): string | null {
  return needles.find((n) => text.includes(n)) ?? null;
}

export function sensitivityHits(text: string, sensitivities: string[]): IngredientHit[] {
  return sensitivities.flatMap((s) => {
    const found = findAny(text, SENSITIVITY_INGREDIENTS[s.toLowerCase()] ?? []);
    return found ? [{ label: s.toLowerCase(), found }] : [];
  });
}

export function activesIn(text: string): Set<string> {
  return new Set(
    Object.entries(ACTIVES)
      .filter(([, needles]) => findAny(text, needles))
      .map(([active]) => active),
  );
}

// Shared vocabulary for the face-scan feature: what each detected
// concern is called, which product ingredients address it (matched
// against Product.ingredients / Product.name text, same substring
// approach as recommendations.ts), and a set of free tips to show
// regardless of the catalog — the app isn't selling anything yet, so
// every concern always has a zero-cost suggestion attached.

export type ConcernKey =
  | "darkCircles"
  | "darkSpots"
  | "acne"
  | "dryness"
  | "oiliness"
  | "dullness";

export const CONCERN_DEFS: Record<
  ConcernKey,
  { label: string; keywords: string[]; freeTips: string[] }
> = {
  darkCircles: {
    label: "Dark circles",
    keywords: ["caffeine", "vitamin k", "retinol", "peptide", "vitamin c"],
    freeTips: [
      "Sleep 7-8 hours consistently — the single biggest lever for under-eye circles.",
      "Chill two spoons in the fridge and press them under your eyes for 2 minutes each morning.",
      "Sleep slightly elevated to reduce fluid pooling under the eyes overnight.",
      "Cut back on evening salt intake — it drives the puffiness that makes circles look darker.",
    ],
  },
  darkSpots: {
    label: "Dark spots & pigmentation",
    keywords: ["vitamin c", "niacinamide", "alpha arbutin", "ferulic acid"],
    freeTips: [
      "Wear SPF every day, even indoors — sun exposure is the top reason spots get darker.",
      "Avoid picking at pimples; the mark it leaves behind lasts far longer than the pimple did.",
      "Stay consistent with one routine for 6-8 weeks — pigmentation fades slowly and switching products resets the clock.",
    ],
  },
  acne: {
    label: "Acne & breakouts",
    keywords: ["salicylic acid", "niacinamide", "tea tree", "zinc"],
    freeTips: [
      "Change your pillowcase twice a week — it collects oil and bacteria that transfer back to your skin.",
      "Avoid touching your face during the day; hands carry oil and bacteria.",
      "Wash twice a day, not more — over-washing can trigger extra oil production and worsen breakouts.",
    ],
  },
  dryness: {
    label: "Dryness",
    keywords: ["hyaluronic acid", "ceramide", "glycerin", "squalane"],
    freeTips: [
      "Apply moisturizer on damp skin right after washing to lock in more water.",
      "Run a humidifier at night if you sleep in a dry or air-conditioned room.",
      "Use lukewarm rather than hot water when washing your face — heat strips natural oils.",
    ],
  },
  oiliness: {
    label: "Oiliness & shine",
    keywords: ["niacinamide", "clay", "zinc", "salicylic acid"],
    freeTips: [
      "Blotting paper controls midday shine as well as powder, for a fraction of the cost.",
      "Don't skip moisturizer — dehydrated skin often overproduces oil to compensate.",
      "A plain clay mask once or twice a week can help manage oil without buying anything new.",
    ],
  },
  dullness: {
    label: "Dullness",
    keywords: ["vitamin c", "niacinamide", "alpha hydroxy", "exfoliant"],
    freeTips: [
      "Gently exfoliate once or twice a week — dead skin buildup is the most common cause of a dull look.",
      "Stay hydrated through the day; overall dehydration shows up on skin as dullness.",
      "A short daily face massage with clean fingers boosts circulation and adds glow for free.",
    ],
  },
};

export const CONCERN_KEYS = Object.keys(CONCERN_DEFS) as ConcernKey[];

// Shared between geminiVision.ts (precise, per-spot boxes from the vision
// model) and faceAnalysis.ts (coarse, whole-region boxes from the offline
// heuristic) so the frontend renders both the same way regardless of
// which analyzer produced a scan.
export interface Detection {
  key: ConcernKey;
  box: [number, number, number, number]; // [ymin, xmin, ymax, xmax], normalized 0-1000
  note: string;
}

// A concern only counts as "detected" above this score, out of 100 —
// keeps the results screen from flagging every faint reading.
export const DETECTION_THRESHOLD = 40;

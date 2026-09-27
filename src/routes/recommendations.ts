import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { ConcernScore } from "../lib/faceAnalysis";
import { getSkinConditions } from "../lib/environment";
import { buildDailyBrief, conflictsWithSensitivities, DailyBrief } from "../lib/dailyBrief";
import {
  detectedConcerns,
  ownedSuggestions,
  planWithinBudget,
  promotedSuggestions,
  SuggestionSource,
} from "../lib/scanSuggestions";
import { searchWebProducts, WebSearchResult } from "../lib/webProductSearch";

const router = express.Router();

function formatRecommendation(rec: any) {
  const snapshot = rec.contextSnapshot as any;
  const brief: DailyBrief | null = snapshot?.brief ?? null;
  return {
    id: rec.id,
    // Briefs saved before the daily-brief rewrite only have the product +
    // reason, so fall back to those.
    headline: brief?.headline ?? "Today's pick",
    summary: brief?.summary ?? null,
    tips: brief?.tips ?? [],
    pick:
      brief?.pick ??
      (rec.product
        ? {
            productId: rec.product.id,
            userProductId: null,
            name: rec.product.name,
            brand: rec.product.brand,
            category: rec.product.category,
            price: rec.product.price,
            owned: false,
            reason: rec.reason,
          }
        : null),
    conditions: brief?.conditions ?? null,
    generatedAt: rec.createdAt,
  };
}

router.get("/latest", requireAuth, async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const rec = await prisma.recommendation.findFirst({
    where: { userId: req.userId!, createdAt: { gte: startOfDay } },
    orderBy: { createdAt: "desc" },
    include: { product: true },
  });

  // A row without a saved brief predates the daily-brief rewrite — treat
  // it as missing so the app generates a real brief instead of showing a
  // bare product for the rest of the day.
  if (!rec || !(rec.contextSnapshot as any)?.brief)
    return res.status(404).json({ error: "No recommendation yet today" });
  res.json(formatRecommendation(rec));
});

// POST /recommendations/generate — body { lat?, lon? }. Pulls live UV,
// air quality, temperature and humidity for the location, combines them
// with the user's skin profile, latest face scan, recent check-ins, owned
// products and routines, and saves the resulting brief for today.
router.post("/generate", requireAuth, async (req, res) => {
  const userId = req.userId!;
  const { lat, lon } = req.body || {};
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const hasCoords =
    typeof lat === "number" && typeof lon === "number" &&
    Number.isFinite(lat) && Number.isFinite(lon);

  const [skinProfile, scan, checkIns, owned, routines, catalog, disliked, conditions] =
    await Promise.all([
      prisma.skinProfile.findUnique({ where: { userId } }),
      prisma.faceScan.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }),
      prisma.checkIn.findMany({
        where: { userId, createdAt: { gte: weekAgo } },
        orderBy: { createdAt: "desc" },
        select: { mood: true },
      }),
      prisma.userProduct.findMany({
        where: { userId, isFinished: false },
        include: { product: true },
      }),
      prisma.routine.findMany({
        where: { userId },
        include: { steps: { include: { product: true } } },
      }),
      prisma.product.findMany(),
      prisma.recommendation.findMany({
        where: { userId, helpful: false, createdAt: { gte: sixtyDaysAgo } },
        select: { productId: true, contextSnapshot: true },
      }),
      hasCoords ? getSkinConditions(lat, lon) : Promise.resolve(null),
    ]);

  if (!skinProfile) {
    return res
      .status(400)
      .json({ error: "Complete your skin assessment first" });
  }

  const morningRoutines = routines.filter((r) => /^(am|morning)/i.test(r.timeOfDay));
  const dislikedProductIds = new Set(
    disliked
      .map((r) => (r.contextSnapshot as any)?.brief?.pick?.productId ?? r.productId)
      .filter((id): id is string => typeof id === "string"),
  );

  const brief = buildDailyBrief({
    now,
    conditions,
    skinProfile,
    latestScan: scan
      ? {
          items: (scan.concerns as unknown as { items: ConcernScore[] }).items ?? [],
          createdAt: scan.createdAt,
        }
      : null,
    recentMoods: checkIns.map((c) => c.mood),
    owned,
    hasMorningRoutine: morningRoutines.length > 0,
    morningRoutineHasSunscreen: morningRoutines.some((r) =>
      r.steps.some((s) => s.product.category === "sunscreen"),
    ),
    catalog,
    dislikedProductIds,
  });

  // Recommendation.productId is required, so a brief whose pick is a
  // custom (non-catalog) owned product — or has no pick — is anchored to
  // the first catalog product. The brief in contextSnapshot is the source
  // of truth for what was shown; feedback reads the pick from there.
  const anchorProductId = brief.pick?.productId ?? catalog[0]?.id;
  if (!anchorProductId) {
    return res.status(404).json({ error: "No products available" });
  }

  const rec = await prisma.recommendation.create({
    data: {
      userId,
      productId: anchorProductId,
      reason: brief.pick?.reason ?? brief.headline,
      contextSnapshot: JSON.parse(
        JSON.stringify({
          brief,
          skinProfile,
          timestamp: now.toISOString(),
        }),
      ),
    },
    include: { product: true },
  });

  res.status(201).json(formatRecommendation(rec));
});

// GET /recommendations/from-scan?source=owned|promoted|web — product
// suggestions for each concern on the caller's latest face scan, from the
// source they pick (see lib/scanSuggestions.ts). Free tips are always
// included. With no source, it defaults to "owned" when something they
// own fits a concern, otherwise "promoted".
router.get("/from-scan", requireAuth, async (req, res) => {
  const userId = req.userId!;
  const requested = String(req.query.source ?? "");

  const [scan, skinProfile, owned, catalog] = await Promise.all([
    prisma.faceScan.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.skinProfile.findUnique({ where: { userId } }),
    prisma.userProduct.findMany({
      where: { userId, isFinished: false },
      include: { product: true },
    }),
    prisma.product.findMany(),
  ]);

  if (!scan) {
    return res
      .status(400)
      .json({ error: "Scan your face first to get recommendations" });
  }

  const now = new Date();
  const concerns = detectedConcerns(
    (scan.concerns as unknown as { items: ConcernScore[] }).items ?? [],
  );
  const budget = skinProfile?.monthlyBudget ?? null;
  const ownedResult = ownedSuggestions(concerns, owned, now);
  const ownedMatches = ownedResult.concerns.reduce((n, c) => n + c.items.length, 0);

  const source: SuggestionSource =
    requested === "owned" || requested === "promoted" || requested === "web"
      ? requested
      : ownedMatches > 0
        ? "owned"
        : "promoted";

  const base = { source, budget, ownedMatches, generatedAt: scan.createdAt };

  if (source === "owned") {
    return res.json({ ...base, ...ownedResult, web: null });
  }
  if (source === "promoted") {
    return res.json({
      ...base,
      ...promotedSuggestions(concerns, catalog, owned, skinProfile),
      web: null,
    });
  }

  // web — reuse this scan's cached result unless the budget changed.
  type CachedWeb = WebSearchResult & { budget: number | null; generatedAt: string };
  let web = scan.webSuggestions as unknown as CachedWeb | null;
  if (!web || web.budget !== budget) {
    const found = await searchWebProducts({
      concerns,
      skinType: skinProfile?.skinType ?? null,
      sensitivities: skinProfile?.sensitivities ?? [],
      budget,
      ownedNames: owned.map((up) => up.product?.name ?? up.customName ?? "").filter(Boolean),
    });
    if (!found) {
      return res.status(503).json({
        error: "Couldn't search the web right now — try again in a bit, or use Lumora picks.",
      });
    }
    web = { ...found, budget, generatedAt: now.toISOString() };
    await prisma.faceScan.update({
      where: { id: scan.id },
      data: { webSuggestions: JSON.parse(JSON.stringify(web)) },
    });
  }

  const sensitivities = skinProfile?.sensitivities ?? [];
  const planned = planWithinBudget(
    concerns,
    (c) =>
      (web!.concerns.find((w) => w.key === c.key)?.products ?? [])
        .filter((p) => !conflictsWithSensitivities(`${p.name} ${p.keyIngredient}`.toLowerCase(), sensitivities))
        .map((p, i) => ({
          rank: -i, // keep Gemini's cheapest → premium order
          item: {
            productId: null,
            userProductId: null,
            name: p.name,
            brand: p.brand,
            price: p.approxPriceInr,
            category: null,
            keyIngredient: p.keyIngredient || null,
            why: p.why,
            tag: "web" as const,
            url: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(`${p.brand} ${p.name}`)}`,
            alsoFor: [],
          },
        })),
    budget,
  );

  res.json({
    ...base,
    ...planned,
    web: { grounded: web.grounded, sources: web.sources, searchedAt: web.generatedAt },
  });
});

router.post("/:id/feedback", requireAuth, async (req, res) => {
  const { helpful } = req.body;
  if (typeof helpful !== "boolean") {
    return res.status(400).json({ error: "helpful (boolean) required" });
  }

  const id = String(req.params.id);

  const rec = await prisma.recommendation.updateMany({
    where: { id, userId: req.userId! },
    data: { helpful },
  });

  if (rec.count === 0)
    return res.status(404).json({ error: "Recommendation not found" });
  res.json({ success: true });
});

export default router;

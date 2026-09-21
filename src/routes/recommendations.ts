import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { CONCERN_DEFS, ConcernKey } from "../lib/skinConcerns";
import { ConcernScore } from "../lib/faceAnalysis";

const router = express.Router();

function formatRecommendation(rec: any) {
  const snapshot = rec.contextSnapshot as any;
  return {
    id: rec.id,
    productId: rec.productId,
    productName: rec.product.name,
    brand: rec.product.brand,
    reason: rec.reason,
    generatedAt: rec.createdAt,
    weatherUsed: snapshot?.weather ?? null,
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

  if (!rec)
    return res.status(404).json({ error: "No recommendation yet today" });
  res.json(formatRecommendation(rec));
});

router.post("/generate", requireAuth, async (req, res) => {
  const skinProfile = await prisma.skinProfile.findUnique({
    where: { userId: req.userId! },
  });
  if (!skinProfile) {
    return res
      .status(400)
      .json({ error: "Complete your skin assessment first" });
  }

  const { temp, condition, humidity } = req.body || {};

  const allConcerns = [...skinProfile.concerns];

  const candidates = await prisma.product.findMany();

  const scored = candidates.map((p) => {
    let score = 0;
    const text = `${p.name} ${p.ingredients.join(" ")}`.toLowerCase();

    if (
      allConcerns.some((c) => c.includes("acne")) &&
      (text.includes("salicylic") || text.includes("niacinamide"))
    )
      score += 2;
    if (
      allConcerns.some((c) => c.includes("dry")) &&
      (text.includes("hyaluronic") || text.includes("ceramide"))
    )
      score += 2;
    if (
      allConcerns.some(
        (c) =>
          c.includes("dark spot") ||
          c.includes("pigment") ||
          c.includes("uneven") ||
          c.includes("dull"),
      ) &&
      (text.includes("vitamin c") || text.includes("niacinamide"))
    )
      score += 2;
    if (skinProfile.skinType === "oily" && p.category === "serum") score += 1;
    if (skinProfile.skinType === "dry" && p.category === "moisturizer")
      score += 1;

    let weatherReason = "";
    if (typeof temp === "number") {
      if (temp >= 28 && p.category === "sunscreen") {
        score += 5;
        weatherReason = `It's ${temp}°C today — sun protection matters more.`;
      }
      if (temp >= 28 && p.category === "moisturizer" && text.includes("gel")) {
        score += 1;
      }
      if (
        temp < 18 &&
        (text.includes("ceramide") || text.includes("hyaluronic"))
      ) {
        score += 2;
        weatherReason = `It's a cooler ${temp}°C — your skin likely needs extra hydration.`;
      }
    }
    if (typeof humidity === "number") {
      if (
        humidity >= 70 &&
        p.category === "serum" &&
        text.includes("niacinamide")
      ) {
        score += 2;
        weatherReason =
          weatherReason ||
          `Humidity is at ${humidity}% — an oil-controlling serum helps today.`;
      }
      if (
        humidity < 40 &&
        (text.includes("hyaluronic") || text.includes("glycerin"))
      ) {
        score += 2;
        weatherReason =
          weatherReason ||
          `Low humidity (${humidity}%) means your skin needs more moisture support.`;
      }
    }

    return { product: p, score, weatherReason };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];

  if (!top) {
    return res.status(404).json({ error: "No products available" });
  }

  const baseReason = `Based on your ${skinProfile.skinType} skin and focus on ${allConcerns.join(", ") || "general skincare"}, this product's ingredients align well with your goals.`;
  const reason = top.weatherReason
    ? `${top.weatherReason} ${baseReason}`
    : baseReason;

  const rec = await prisma.recommendation.create({
    data: {
      userId: req.userId!,
      productId: top.product.id,
      reason,
      contextSnapshot: {
        skinProfile: JSON.parse(JSON.stringify(skinProfile)),
        weather: { temp, condition, humidity },
        timestamp: new Date().toISOString(),
      },
    },
    include: { product: true },
  });

  res.status(201).json(formatRecommendation(rec));
});

// GET /recommendations/from-scan — turns the caller's latest face scan
// into concern-by-concern guidance: free tips (always shown, since the
// app isn't selling anything yet), a nudge to use a product they
// already own if it fits, and up to two catalog matches within their
// stated monthly budget (skinProfile.monthlyBudget), excluding
// anything they've already logged as owned.
router.get("/from-scan", requireAuth, async (req, res) => {
  const userId = req.userId!;

  const [scan, skinProfile, userProducts, products] = await Promise.all([
    prisma.faceScan.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.skinProfile.findUnique({ where: { userId } }),
    prisma.userProduct.findMany({ where: { userId }, include: { product: true } }),
    prisma.product.findMany(),
  ]);

  if (!scan) {
    return res
      .status(400)
      .json({ error: "Scan your face first to get recommendations" });
  }

  const storedConcerns = scan.concerns as unknown as { source: string; items: ConcernScore[] };
  const detectedConcerns = storedConcerns.items
    .filter((c) => c.detected)
    .sort((a, b) => b.score - a.score);

  const budget = skinProfile?.monthlyBudget ?? null;
  const ownedProductIds = new Set(
    userProducts.map((up) => up.productId).filter((id): id is string => Boolean(id)),
  );

  const concerns = detectedConcerns.map((concern) => {
    const def = CONCERN_DEFS[concern.key as ConcernKey];

    const ownedMatch = userProducts.find((up) => {
      const text = `${up.product?.name ?? up.customName ?? ""} ${up.product?.ingredients?.join(" ") ?? ""}`.toLowerCase();
      return def.keywords.some((k) => text.includes(k));
    });

    const suggestedProducts = products
      .filter((p) => !ownedProductIds.has(p.id))
      .filter((p) => (budget ? p.price <= budget : true))
      .filter((p) => {
        const text = `${p.name} ${p.ingredients.join(" ")}`.toLowerCase();
        return def.keywords.some((k) => text.includes(k));
      })
      .sort((a, b) => a.price - b.price)
      .slice(0, 2)
      .map((p) => ({
        id: p.id,
        name: p.name,
        brand: p.brand,
        price: p.price,
        category: p.category,
      }));

    return {
      key: concern.key,
      label: def.label,
      score: concern.score,
      freeTips: def.freeTips,
      ownedMatch: ownedMatch
        ? {
            id: ownedMatch.id,
            name: ownedMatch.product?.name ?? ownedMatch.customName ?? "Your product",
            brand: ownedMatch.product?.brand ?? ownedMatch.customBrand ?? "",
          }
        : null,
      suggestedProducts,
    };
  });

  res.json({ concerns, budget, generatedAt: scan.createdAt });
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

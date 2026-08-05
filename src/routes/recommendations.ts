import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

const router = express.Router();

function formatRecommendation(rec: any) {
  return {
    id: rec.id,
    productId: rec.productId,
    productName: rec.product.name,
    brand: rec.product.brand,
    reason: rec.reason,
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

  // Simple rule-based matching for now — pulls products matching the user's concerns/skin type
  // (Upgrade path: replace this block with pgvector similarity search once embeddings are ready to use here)
  const candidates = await prisma.product.findMany();

  const scored = candidates.map((p) => {
    let score = 0;
    const text = `${p.name} ${p.ingredients.join(" ")}`.toLowerCase();

    if (
      skinProfile.concerns.includes("acne") &&
      (text.includes("salicylic") || text.includes("niacinamide"))
    )
      score += 2;
    if (
      skinProfile.concerns.includes("dryness") &&
      (text.includes("hyaluronic") || text.includes("ceramide"))
    )
      score += 2;
    if (
      skinProfile.concerns.includes("dullness") &&
      (text.includes("vitamin c") || text.includes("niacinamide"))
    )
      score += 2;
    if (skinProfile.skinType === "oily" && p.category === "serum") score += 1;
    if (skinProfile.skinType === "dry" && p.category === "moisturizer")
      score += 1;

    return { product: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.product || candidates[0];

  if (!top) {
    return res
      .status(404)
      .json({ error: "No products available to recommend" });
  }

  const reason = `Based on your ${skinProfile.skinType} skin and focus on ${skinProfile.concerns.join(", ") || "general skincare"}, this product's ingredients align well with your goals.`;

  const rec = await prisma.recommendation.create({
    data: {
      userId: req.userId!,
      productId: top.id,
      reason,
      contextSnapshot: { skinProfile, timestamp: new Date().toISOString() },
    },
    include: { product: true },
  });

  res.status(201).json(formatRecommendation(rec));
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

import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const items = await prisma.userProduct.findMany({
    where: { userId: req.userId! },
    include: { product: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(items);
});

router.post("/", requireAuth, async (req, res) => {
  const {
    productId,
    customName,
    customBrand,
    category,
    openedAt,
    expiresAt,
    quantityTotal,
    quantityUnit,
  } = req.body;

  if (!productId && !customName) {
    return res
      .status(400)
      .json({ error: "Either productId or customName is required" });
  }

  // A custom (not-from-catalog) product still needs a real Product row —
  // routines, reviews, etc. all reference products by id, and a shelf item
  // with no linked product would silently be invisible to those features.
  let finalProductId = productId || null;
  if (!finalProductId && customName) {
    const created = await prisma.product.create({
      data: {
        name: customName,
        brand: customBrand || "Custom",
        category: category || "skincare",
        ingredients: [],
        price: 0,
      },
    });
    finalProductId = created.id;
  }

  const item = await prisma.userProduct.create({
    data: {
      userId: req.userId!,
      productId: finalProductId,
      customName: customName || null,
      customBrand: customBrand || null,
      openedAt: openedAt ? new Date(openedAt) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      quantityTotal: quantityTotal || null,
      quantityLeft: quantityTotal || null, // starts full
      quantityUnit: quantityUnit || null,
    },
    include: { product: true },
  });
  res.status(201).json(item);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const { isFinished, quantityLeft, expiresAt } = req.body;

  const existing = await prisma.userProduct.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ error: "Not found" });
  }

  const updated = await prisma.userProduct.update({
    where: { id },
    data: {
      ...(isFinished !== undefined ? { isFinished } : {}),
      ...(quantityLeft !== undefined ? { quantityLeft } : {}),
      ...(expiresAt !== undefined
        ? { expiresAt: expiresAt ? new Date(expiresAt) : null }
        : {}),
    },
    include: { product: true },
  });
  res.json(updated);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const existing = await prisma.userProduct.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.userId) {
    return res.status(404).json({ error: "Not found" });
  }
  await prisma.userProduct.delete({ where: { id } });
  res.json({ success: true });
});

export default router;

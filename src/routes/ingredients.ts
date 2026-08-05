import express from "express";
import { prisma } from "../lib/prisma";

const router = express.Router();

router.get("/", async (req, res) => {
  const { query } = req.query;
  const ingredients = await prisma.ingredient.findMany({
    where: query
      ? { name: { contains: String(query), mode: "insensitive" } }
      : {},
    orderBy: { name: "asc" },
  });
  res.json(ingredients);
});

router.get("/:name", async (req, res) => {
  const ingredient = await prisma.ingredient.findFirst({
    where: { name: { equals: req.params.name, mode: "insensitive" } },
  });
  if (!ingredient) return res.status(404).json({ error: "Not found" });
  res.json(ingredient);
});

export default router;

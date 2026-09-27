import express from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/requireAdmin";
import { lookupBarcode, searchProducts } from "../lib/openBeautyFacts";

// Catalog management for admins (see ADMIN_EMAILS in requireAdmin.ts):
// list, add, edit and delete products, plus Open Beauty Facts lookups to
// prefill new products from the internet.

const router = express.Router();
router.use(requireAdmin);

const CATEGORIES = ["cleanser", "toner", "serum", "moisturizer", "sunscreen", "mask", "eye cream", "exfoliant", "other"];

type ProductInput = {
  name: string;
  brand: string;
  category: string;
  price: number;
  ingredients: string[];
  imageUrl: string | null;
  barcode: string | null;
  isPromoted: boolean;
};

// Validates a full product (create) or just the fields present (update).
function parseProduct(body: any, partial: boolean): { data: Partial<ProductInput> } | { error: string } {
  const data: Partial<ProductInput> = {};
  const has = (k: string) => body?.[k] !== undefined;
  const need = (k: string) => !partial || has(k);

  if (need("name")) {
    if (typeof body.name !== "string" || body.name.trim().length < 2) return { error: "Name is required" };
    data.name = body.name.trim();
  }
  if (need("brand")) {
    if (typeof body.brand !== "string" || !body.brand.trim()) return { error: "Brand is required" };
    data.brand = body.brand.trim();
  }
  if (need("category")) {
    const category = String(body.category ?? "").trim().toLowerCase();
    if (!CATEGORIES.includes(category)) return { error: `Category must be one of: ${CATEGORIES.join(", ")}` };
    data.category = category;
  }
  if (need("price")) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) return { error: "Price must be more than ₹0" };
    data.price = Math.round(price);
  }
  if (has("ingredients") || !partial) {
    const list = Array.isArray(body.ingredients)
      ? body.ingredients
      : String(body.ingredients ?? "").split(",");
    data.ingredients = [
      ...new Set(list.map((i: unknown) => String(i).trim().toLowerCase()).filter(Boolean)),
    ] as string[];
  }
  if (has("imageUrl") || !partial) {
    const url = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    if (url && !/^https?:\/\//.test(url)) return { error: "Image URL must start with http(s)://" };
    data.imageUrl = url || null;
  }
  if (has("barcode") || !partial) {
    const code = typeof body.barcode === "string" ? body.barcode.trim() : "";
    if (code && !/^\d{6,14}$/.test(code)) return { error: "Barcode should be 6–14 digits" };
    data.barcode = code || null;
  }
  if (has("isPromoted") || !partial) data.isPromoted = Boolean(body.isPromoted);

  return { data };
}

function prismaError(err: unknown, res: express.Response) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return res.status(409).json({ error: "Another product already has this barcode" });
    if (err.code === "P2025") return res.status(404).json({ error: "Product not found" });
  }
  throw err;
}

router.get("/categories", (_req, res) => {
  res.json(CATEGORIES);
});

// Includes how many users/reviews/routines use each product, so the
// admin can see what's popular and why a delete might be refused.
router.get("/products", async (req, res) => {
  const query = String(req.query.query ?? "").trim();
  const products = await prisma.product.findMany({
    where: query
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { brand: { contains: query, mode: "insensitive" } },
            { barcode: query },
          ],
        }
      : {},
    orderBy: [{ isPromoted: "desc" }, { name: "asc" }],
    include: {
      _count: { select: { reviews: true, userProducts: true, routineSteps: true } },
    },
  });
  res.json(products);
});

router.post("/products", async (req, res) => {
  const parsed = parseProduct(req.body, false);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });
  try {
    const product = await prisma.product.create({ data: parsed.data as ProductInput });
    res.status(201).json(product);
  } catch (err) {
    prismaError(err, res);
  }
});

router.patch("/products/:id", async (req, res) => {
  const parsed = parseProduct(req.body, true);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });
  try {
    const product = await prisma.product.update({
      where: { id: String(req.params.id) },
      data: parsed.data,
    });
    res.json(product);
  } catch (err) {
    prismaError(err, res);
  }
});

// Only products nothing points at can be deleted — reviews, routines and
// users' shelves would otherwise lose their product.
router.delete("/products/:id", async (req, res) => {
  const id = String(req.params.id);
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      _count: {
        select: { reviews: true, userProducts: true, routineSteps: true, recommendations: true },
      },
    },
  });
  if (!product) return res.status(404).json({ error: "Product not found" });
  const inUse = Object.values(product._count).reduce((a, b) => a + b, 0);
  if (inUse > 0) {
    return res.status(409).json({
      error: "This product is used in reviews, routines or users' shelves, so it can't be deleted.",
    });
  }
  await prisma.product.delete({ where: { id } });
  res.json({ success: true });
});

// Internet lookups (Open Beauty Facts). Each result says whether the
// barcode is already in our catalog so the admin doesn't add duplicates.
async function withExisting<T extends { barcode: string | null }>(drafts: T[]) {
  const codes = drafts.map((d) => d.barcode).filter((c): c is string => Boolean(c));
  const existing = codes.length
    ? await prisma.product.findMany({ where: { barcode: { in: codes } }, select: { id: true, barcode: true } })
    : [];
  return drafts.map((d) => ({
    ...d,
    existingProductId: existing.find((e) => e.barcode === d.barcode)?.id ?? null,
  }));
}

router.get("/lookup/barcode/:code", async (req, res) => {
  try {
    const draft = await lookupBarcode(String(req.params.code));
    if (!draft) return res.status(404).json({ error: "Not found on Open Beauty Facts — fill it in manually" });
    res.json((await withExisting([draft]))[0]);
  } catch {
    res.status(502).json({ error: "Couldn't reach Open Beauty Facts — try again" });
  }
});

router.get("/lookup/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.status(400).json({ error: "Type at least 2 characters" });
  try {
    res.json(await withExisting(await searchProducts(q)));
  } catch {
    res.status(502).json({ error: "Couldn't reach Open Beauty Facts — try again" });
  }
});

export default router;

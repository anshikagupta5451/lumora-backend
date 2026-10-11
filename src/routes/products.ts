import express from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { barcodeVariants, lookupBarcode, searchProducts } from "../lib/openBeautyFacts";
import { MIN_MATCH_SCORE, ReadLine, ReadText } from "../lib/productMatch";
import { buildVerdict, CommunityStats, VerdictProduct } from "../lib/productVerdict";
import { detectedConcerns } from "../lib/scanSuggestions";
import type { ConcernScore } from "../lib/faceAnalysis";
import type { ConcernKey } from "../lib/skinConcerns";

const router = express.Router();

// A scan older than this no longer says much about today's skin.
const SCAN_RELEVANT_DAYS = 60;

router.get("/", async (req, res) => {
  const { category, query } = req.query;

  const products = await prisma.product.findMany({
    where: {
      ...(category ? { category: String(category) } : {}),
      ...(query
        ? { name: { contains: String(query), mode: "insensitive" } }
        : {}),
    },
    orderBy: { name: "asc" },
  });

  res.json(products);
});

// GET /products/popular — most-reviewed products with their average
// rating, for the Explore tab's "Popular in the community" row.
router.get("/popular", async (_req, res) => {
  const grouped = await prisma.review.groupBy({
    by: ["productId"],
    _count: { _all: true },
    _avg: { rating: true },
    orderBy: { _count: { productId: "desc" } },
    take: 10,
  });
  const products = await prisma.product.findMany({
    where: { id: { in: grouped.map((g) => g.productId) } },
  });
  res.json(
    grouped.flatMap((g) => {
      const p = products.find((x) => x.id === g.productId);
      return p
        ? [{
            id: p.id,
            name: p.name,
            brand: p.brand,
            category: p.category,
            price: p.price || null,
            imageUrl: p.imageUrl,
            reviewCount: g._count._all,
            avgRating: g._avg.rating ? Math.round(g._avg.rating * 10) / 10 : null,
          }]
        : [];
    }),
  );
});

async function communityStats(productId: string | null, skinType: string | null): Promise<CommunityStats> {
  if (!productId) return { count: 0, avg: null, sameSkinCount: 0, sameSkinAvg: null };
  const reviews = await prisma.review.findMany({
    where: { productId },
    select: { rating: true, skinType: true },
  });
  const avg = (rs: { rating: number }[]) =>
    rs.length ? rs.reduce((s, r) => s + r.rating, 0) / rs.length : null;
  const skin = skinType?.toLowerCase();
  // Reviews store "combo"; onboarding may say "combination".
  const same = reviews.filter((r) => {
    const s = r.skinType?.toLowerCase();
    return s && skin && (s === skin || (s.startsWith("comb") && skin.startsWith("comb")));
  });
  return { count: reviews.length, avg: avg(reviews), sameSkinCount: same.length, sameSkinAvg: avg(same) };
}

async function verdictFor(userId: string, product: VerdictProduct) {
  const since = new Date(Date.now() - SCAN_RELEVANT_DAYS * 24 * 60 * 60 * 1000);
  const [profile, owned, scan] = await Promise.all([
    prisma.skinProfile.findUnique({ where: { userId } }),
    prisma.userProduct.findMany({
      where: { userId, isFinished: false },
      include: { product: true },
    }),
    prisma.faceScan.findFirst({
      where: { userId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const scanConcerns = scan
    ? detectedConcerns((scan.concerns as unknown as { items: ConcernScore[] }).items ?? []).map(
        (c) => c.key as ConcernKey,
      )
    : [];
  const community = await communityStats(product.id, profile?.skinType ?? null);
  return buildVerdict({ product, profile, scanConcerns, owned, community });
}

// GET /products/barcode/:code/check — the in-shop "Is this right for me?"
// flow. Looks in our catalog first, then Open Beauty Facts, so it works
// for products nobody has added yet.
router.get("/barcode/:code/check", requireAuth, async (req, res) => {
  const code = String(req.params.code);
  const product = await prisma.product.findFirst({
    where: { barcode: { in: barcodeVariants(code) } },
  });

  if (product) {
    const verdict = await verdictFor(req.userId!, {
      id: product.id,
      name: product.name,
      category: product.category,
      ingredients: product.ingredients,
      price: product.price || null,
    });
    return res.json({
      source: "catalog",
      product: { ...product, price: product.price || null },
      verdict,
    });
  }

  let draft;
  try {
    draft = await lookupBarcode(code);
  } catch {
    return res.status(502).json({ error: "Couldn't look this product up right now — try again" });
  }
  if (!draft) {
    return res.status(404).json({ error: "We couldn't find this product" });
  }

  const verdict = await verdictFor(req.userId!, {
    id: null,
    name: draft.name,
    category: draft.category,
    ingredients: draft.ingredients,
    price: null,
  });
  res.json({
    source: "openbeautyfacts",
    product: {
      id: null,
      name: draft.name,
      brand: draft.brand,
      category: draft.category,
      ingredients: draft.ingredients,
      price: null,
      imageUrl: draft.imageUrl,
      barcode: code,
    },
    verdict,
  });
});

// POST /products/match — the photo scanner. Body is either `lines` (text
// the phone read off the front of the pack, with line heights) or
// `query` (typed into Manual search). Scores our catalog and Open Beauty
// Facts by brand and name and returns the best matches, best first.
// Catalog matches open the product page; OBF-only matches carry a barcode
// so the app can run the same check as a barcode scan.
router.post("/match", requireAuth, async (req, res) => {
  const body = req.body ?? {};
  const lines: ReadLine[] = Array.isArray(body.lines)
    ? body.lines
        .filter((l: any) => typeof l?.text === "string")
        .slice(0, 80)
        .map((l: any) => ({ text: String(l.text).slice(0, 200), size: Number(l.size) || 1 }))
    : typeof body.query === "string"
      ? [{ text: body.query.slice(0, 200), size: 1 }]
      : [];
  const read = new ReadText(lines);
  if (read.isEmpty) {
    return res.status(400).json({ error: "We couldn't read any text — try again with the name in view" });
  }

  const catalog = await prisma.product.findMany({
    select: { id: true, name: true, brand: true, category: true, imageUrl: true, price: true, barcode: true },
  });
  const knownBrand =
    catalog
      .map((p) => ({ brand: p.brand, s: read.brandScore(p.brand) }))
      .filter((b) => b.s >= 0.8)
      .sort((a, b) => b.s - a.s || b.brand.length - a.brand.length)[0]?.brand ?? null;

  const fromCatalog = catalog
    .map((p) => ({ p, score: read.score(p) }))
    .filter((m) => m.score >= MIN_MATCH_SCORE);

  // OBF is a fallback; a failed or slow search just means fewer matches.
  const obfResults = await Promise.all(
    read.searchQueries(knownBrand).map((q) => searchProducts(q).catch(() => [])),
  );
  const catalogCodes = new Set(
    catalog.flatMap((p) => (p.barcode ? barcodeVariants(p.barcode) : [])),
  );
  const seenCodes = new Set<string>();
  const fromObf = obfResults
    .flat()
    .filter((d) => {
      if (!d.barcode || seenCodes.has(d.barcode)) return false;
      seenCodes.add(d.barcode);
      return !barcodeVariants(d.barcode).some((c) => catalogCodes.has(c));
    })
    .map((d) => ({ d, score: read.score(d) }))
    .filter((m) => m.score >= MIN_MATCH_SCORE);

  const ratings = await prisma.review.groupBy({
    by: ["productId"],
    where: { productId: { in: fromCatalog.map((m) => m.p.id) } },
    _count: { _all: true },
    _avg: { rating: true },
  });

  const matches = [
    ...fromCatalog.map(({ p, score }) => {
      const r = ratings.find((x) => x.productId === p.id);
      return {
        source: "catalog" as const,
        productId: p.id,
        barcode: p.barcode,
        name: p.name,
        brand: p.brand,
        category: p.category,
        imageUrl: p.imageUrl,
        price: p.price || null,
        avgRating: r?._avg.rating ? Math.round(r._avg.rating * 10) / 10 : null,
        reviewCount: r?._count._all ?? 0,
        score,
      };
    }),
    ...fromObf.map(({ d, score }) => ({
      source: "openbeautyfacts" as const,
      productId: null,
      barcode: d.barcode,
      name: d.name,
      brand: d.brand,
      category: d.category,
      imageUrl: d.imageUrl,
      price: null,
      avgRating: null,
      reviewCount: 0,
      score,
    })),
  ]
    // Ties go to our catalog, which has prices and reviews.
    .sort((a, b) => b.score - a.score || (a.source === "catalog" ? -1 : 1))
    .slice(0, 10);

  res.json({ readText: [...read.words.keys()].slice(0, 20).join(" "), matches });
});

router.get("/barcode/:code", async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { barcode: { in: barcodeVariants(String(req.params.code)) } },
  });
  if (!product)
    return res.status(404).json({ error: "No product found for this barcode" });
  res.json(product);
});

router.get("/:id/verdict", requireAuth, async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: String(req.params.id) } });
  if (!product) return res.status(404).json({ error: "Product not found" });
  const verdict = await verdictFor(req.userId!, {
    id: product.id,
    name: product.name,
    category: product.category,
    ingredients: product.ingredients,
    price: product.price || null,
  });
  const community = await communityStats(product.id, null);
  res.json({ verdict, reviewCount: community.count, avgRating: community.avg });
});

router.get("/:id", async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
  });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

export default router;

// POST /face-scan/analyze — accepts one selfie (multipart/form-data,
// field name "image", optional field "previewAspect" = the phone's screen
// width / height). The photo is first cropped to the on-screen oval guide
// (ovalCropRect), and everything below uses that crop, so markers line up
// with the photo the results screen shows. Tries real AI analysis via Gemini's free tier
// first (src/lib/geminiVision.ts); if no API key is configured or the
// call fails for any reason, falls back to the offline pixel-heuristic
// in src/lib/faceAnalysis.ts so the feature keeps working either way.
// Either path also produces `detections` (on-photo markers) — Gemini's
// are precise per-spot boxes, the heuristic's are coarser whole-region
// boxes (see getHeuristicDetections) — so the results screen always has
// something to draw on the photo, not just aggregate scores.
// Stores the photo (same Supabase bucket as post images) and the
// resulting scores, tagged with which analyzer produced them.
// GET /face-scan/latest — the most recent scan for the caller.

import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { uploadImageToSupabase } from "../lib/supabase";
import {
  analyzeFaceImage,
  DEFAULT_PREVIEW_ASPECT,
  getHeuristicDetections,
  ovalCropRect,
} from "../lib/faceAnalysis";
import { analyzeFaceWithGemini } from "../lib/geminiVision";
import { Detection } from "../lib/skinConcerns";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  },
});

function formatFaceScan(scan: any) {
  const stored = scan.concerns as {
    source: "ai" | "heuristic";
    items: unknown;
    detections: Detection[];
  };
  return {
    id: scan.id,
    imageUrl: scan.imageUrl,
    imageWidth: scan.imageWidth,
    imageHeight: scan.imageHeight,
    concerns: stored.items,
    detections: stored.detections ?? [],
    source: stored.source,
    createdAt: scan.createdAt,
  };
}

router.post(
  "/analyze",
  requireAuth,
  upload.single("image"),
  async (req: any, res) => {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) return res.status(400).json({ error: "No image provided" });

    const sentAspect = Number(req.body?.previewAspect);
    const previewAspect =
      Number.isFinite(sentAspect) && sentAspect >= 0.3 && sentAspect <= 1.5
        ? sentAspect
        : DEFAULT_PREVIEW_ASPECT;

    try {
      // rotate() applies EXIF orientation, so width/height are as displayed.
      const { data: upright, info } = await sharp(file.buffer)
        .rotate()
        .toBuffer({ resolveWithObject: true });
      const crop = ovalCropRect(info.width, info.height, previewAspect);
      const face = await sharp(upright).extract(crop).jpeg({ quality: 90 }).toBuffer();

      const aiResult = await analyzeFaceWithGemini(face, "image/jpeg");
      let items = aiResult?.scores;
      let detections = aiResult?.detections ?? [];
      let source: "ai" | "heuristic" = "ai";
      if (!items) {
        items = await analyzeFaceImage(face);
        detections = getHeuristicDetections(items);
        source = "heuristic";
      }

      const imageUrl = await uploadImageToSupabase(face, "image/jpeg", req.userId);

      const scan = await prisma.faceScan.create({
        data: {
          userId: req.userId!,
          imageUrl,
          imageWidth: crop.width,
          imageHeight: crop.height,
          concerns: { source, items, detections } as any,
        },
      });

      res.status(201).json(formatFaceScan(scan));
    } catch (err) {
      console.error("[face-scan] analyze failed:", err);
      res.status(500).json({
        error: "Could not analyze that photo — try retaking it in better lighting",
      });
    }
  },
);

router.get("/latest", requireAuth, async (req, res) => {
  const scan = await prisma.faceScan.findFirst({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
  });
  if (!scan) return res.status(404).json({ error: "No face scan yet" });
  res.json(formatFaceScan(scan));
});

export default router;

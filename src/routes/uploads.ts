// src/routes/uploads.ts
//
// POST /uploads/images — accepts up to 6 images (multipart/form-data,
// field name "images"), uploads each to R2, returns their public URLs.
//
// Install: npm install multer && npm install -D @types/multer
//
// Wire into your app entry (e.g. src/index.ts or src/app.ts):
//   import uploadsRouter from "./routes/uploads";
//   app.use("/uploads", uploadsRouter);

import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/requireAuth";
import { uploadImageToSupabase } from "../lib/supabase";

const router = Router();

const MAX_IMAGES = 6;
const MAX_FILE_SIZE_MB = 8;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_IMAGES },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  },
});


router.post(
  "/images",
  requireAuth,
  upload.array("images", MAX_IMAGES),
  async (req: any, res) => {
    const files = req.files as Express.Multer.File[] | undefined;
    console.log(`[uploads] Received ${files?.length || 0} files from user ${req.userId}`);
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No images provided" });
    }

    try {
      const urls = await Promise.all(
        files.map((file) =>
          uploadImageToSupabase(file.buffer, file.mimetype, req.userId),
        ),
      );
      res.json({ urls });
    } catch (err) {
        console.log("[uploads] Error uploading images:", err);
      console.error("[uploads] Supabase upload failed:", err);
      res.status(500).json({ error: "Could not upload images" });
    }
  },
);

export default router;

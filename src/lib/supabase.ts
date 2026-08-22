// src/lib/supabase.ts
//
// Supabase Storage client for post images. Card-free alternative to R2,
// same free-tier intent: 1 GB storage, 2 GB egress on Supabase's free
// plan (see project docs for current numbers — verify on supabase.com
// if this matters for your usage).
//
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_BUCKET_NAME
//
// Install: npm install @supabase/supabase-js

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_BUCKET_NAME",
] as const;

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.warn(`[supabase] Missing env var ${key} — image uploads will fail.`);
  }
}

// IMPORTANT: use the service_role key here, never the anon key. The
// service role bypasses Row Level Security so the backend can upload
// and delete files on behalf of any authenticated user — this client
// must never be exposed to the frontend.
export const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
);

const BUCKET = process.env.SUPABASE_BUCKET_NAME || "post-images";

console.log("[debug] SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("[debug] KEY starts with sb_secret_:", process.env.SUPABASE_SERVICE_ROLE_KEY?.startsWith("sb_secret_"));

/**
 * Uploads a single image buffer to Supabase Storage under
 * posts/{userId}/{uuid}.{ext} and returns its public URL.
 */
export async function uploadImageToSupabase(
  buffer: Buffer,
  mimeType: string,
  userId: string,
): Promise<string> {
  const ext = mimeType.split("/")[1] || "jpg";
  const path = `posts/${userId}/${randomUUID()}.${ext}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType,
    // Images are immutable once uploaded (new upload = new path), so
    // cache aggressively — fewer repeat reads counted against quota,
    // faster loads for testers viewing the same post again.
    cacheControl: "31536000",
    upsert: false,
  });

  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Deletes multiple images from Supabase Storage given their public
 * URLs. Used when a post is deleted, so orphaned files don't sit in
 * the bucket forever.
 */
export async function deleteImagesFromSupabase(urls: string[]): Promise<void> {
  if (!urls || urls.length === 0) return;

  // Supabase public URLs look like:
  // https://{project}.supabase.co/storage/v1/object/public/{bucket}/{path}
  // Extract just the {path} part for the remove() call.
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const paths = urls
    .map((url) => {
      const idx = url.indexOf(marker);
      if (idx === -1) return null;
      return url.slice(idx + marker.length);
    })
    .filter((p): p is string => Boolean(p));

  if (paths.length === 0) return;

  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) {
    // Don't let a storage cleanup failure block the actual post
    // deletion — log it, but the DB row is the source of truth for the
    // user-facing action.
    console.error("[supabase] Failed to delete images:", paths, error);
  }
}
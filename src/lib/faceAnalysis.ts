// Heuristic, non-ML face/skin analysis.
//
// This is NOT real face detection — there is no model here identifying
// where a face actually is in the frame. Instead it trusts that the
// capture screen (face-scan.tsx) gets the user to align their face
// inside an on-screen oval guide; the route crops the photo to that oval
// (ovalCropRect) and this reads fixed, pre-defined regions of the crop
// that correspond to where eyes/cheeks/forehead land for a well-aligned
// shot. Each concern score comes from simple
// pixel statistics (brightness, color-channel balance, local contrast)
// in those regions, mapped onto a 0-100 scale using range constants
// that were picked by eyeballing sample photos, not trained on data.
//
// It is a deliberately free, dependency-light MVP (sharp only, no paid
// vision API, no native ML module) for a pre-launch testing build. If
// this needs to become accurate later, replace analyzeFaceImage's body
// with a call to a real face-landmark/skin-analysis model and keep the
// same ConcernScore[] return shape — nothing downstream needs to change.

import sharp from "sharp";
import {
  CONCERN_DEFS,
  CONCERN_KEYS,
  ConcernKey,
  DETECTION_THRESHOLD,
  Detection,
} from "./skinConcerns";

export interface ConcernScore {
  key: ConcernKey;
  label: string;
  score: number;
  detected: boolean;
  // Only present when a vision-AI analyzer (geminiVision.ts) produced this
  // score — the offline heuristic below has no reasoning to give.
  reasoning?: string;
}

const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 800;

interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The oval guide in face-scan.tsx, as fractions of the camera preview:
// width = 64% of the screen width, height = 1.35x its width, top = 16%
// of the screen height, horizontally centered. Keep in sync with the app.
const OVAL_WIDTH = 0.64;
const OVAL_HEIGHT_PER_WIDTH = 1.35;
const OVAL_TOP = 0.16;

// Screen width / height of the phone the photo was taken on. Older app
// builds don't send it; this is a typical modern phone (~9:20).
export const DEFAULT_PREVIEW_ASPECT = 0.45;

// The camera preview fills the screen ("cover"), so it only shows the
// middle of the photo when the photo's aspect differs from the screen's.
// Maps the on-screen oval onto the photo's pixels, so the analysis, the
// stored photo and the markers all use just the face the user aligned.
export function ovalCropRect(
  imageWidth: number,
  imageHeight: number,
  previewAspect: number,
): Region {
  const imageAspect = imageWidth / imageHeight;
  const visibleWidth = imageAspect > previewAspect ? imageHeight * previewAspect : imageWidth;
  const visibleHeight = imageAspect > previewAspect ? imageHeight : imageWidth / previewAspect;
  const offsetX = (imageWidth - visibleWidth) / 2;
  const offsetY = (imageHeight - visibleHeight) / 2;

  const width = OVAL_WIDTH * visibleWidth;
  const height = Math.min(imageHeight, width * OVAL_HEIGHT_PER_WIDTH);
  const left = Math.round(offsetX + ((1 - OVAL_WIDTH) / 2) * visibleWidth);
  const top = Math.round(Math.min(offsetY + OVAL_TOP * visibleHeight, imageHeight - height));
  return {
    left,
    top,
    width: Math.max(1, Math.min(Math.round(width), imageWidth - left)),
    height: Math.max(1, Math.min(Math.round(height), imageHeight - top)),
  };
}

// Where each feature lands inside the oval for a well-aligned selfie
// (the photo is cropped to the oval's bounding box first, see
// ovalCropRect): hairline near the top edge, chin near the bottom, cheeks
// near the sides. Fractions are [xFrom, xTo, yFrom, yTo], all 0-1. Kept as
// the single source of truth so both the pixel-region extraction below
// and the approximate on-photo markers in getHeuristicDetections stay in
// sync.
const REGION_FRACTIONS = {
  forehead: [0.3, 0.7, 0.1, 0.26],
  leftUnderEye: [0.22, 0.4, 0.47, 0.54],
  rightUnderEye: [0.6, 0.78, 0.47, 0.54],
  leftCheek: [0.16, 0.34, 0.56, 0.72],
  rightCheek: [0.66, 0.84, 0.56, 0.72],
  tZone: [0.44, 0.56, 0.42, 0.62],
  chin: [0.4, 0.6, 0.86, 0.95],
} satisfies Record<string, [number, number, number, number]>;

type RegionName = keyof typeof REGION_FRACTIONS;

function region(name: RegionName): Region {
  const [xFrom, xTo, yFrom, yTo] = REGION_FRACTIONS[name];
  return {
    left: Math.round(xFrom * CANVAS_WIDTH),
    top: Math.round(yFrom * CANVAS_HEIGHT),
    width: Math.max(1, Math.round((xTo - xFrom) * CANVAS_WIDTH)),
    height: Math.max(1, Math.round((yTo - yFrom) * CANVAS_HEIGHT)),
  };
}

// Same fractions, expressed as a normalized-0-1000 [ymin, xmin, ymax,
// xmax] box — the shape geminiVision.ts's `detections` also use, so the
// frontend renders both the same way.
function regionToBox(name: RegionName): [number, number, number, number] {
  const [xFrom, xTo, yFrom, yTo] = REGION_FRACTIONS[name];
  return [
    Math.round(yFrom * 1000),
    Math.round(xFrom * 1000),
    Math.round(yTo * 1000),
    Math.round(xTo * 1000),
  ];
}

const REGIONS = {
  forehead: region("forehead"),
  leftUnderEye: region("leftUnderEye"),
  rightUnderEye: region("rightUnderEye"),
  leftCheek: region("leftCheek"),
  rightCheek: region("rightCheek"),
  tZone: region("tZone"),
  chin: region("chin"),
};

interface RegionStats {
  r: number;
  g: number;
  b: number;
  luminance: number;
  grayStdev: number;
}

// sharp's stats() describes the pipeline's *input* and ignores extract(),
// greyscale() and convolve(), so every region used to get whole-photo
// numbers. Render the pipeline to raw pixels first, then measure those.
async function renderedStats(pipeline: sharp.Sharp) {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  }).stats();
}

async function statsFor(
  base: sharp.Sharp,
  r: Region,
): Promise<RegionStats> {
  const { channels } = await renderedStats(base.clone().extract(r));
  const [rc, gc, bc] = channels as [
    (typeof channels)[number],
    (typeof channels)[number],
    (typeof channels)[number],
  ];
  return {
    r: rc.mean,
    g: gc.mean,
    b: bc.mean,
    luminance: 0.299 * rc.mean + 0.587 * gc.mean + 0.114 * bc.mean,
    grayStdev: (rc.stdev + gc.stdev + bc.stdev) / 3,
  };
}

// Edge energy from a Laplacian convolution, as a proxy for skin
// texture roughness (flakier/drier skin tends to show more local
// contrast under camera lighting than smooth, well-hydrated skin).
async function roughnessFor(base: sharp.Sharp, r: Region): Promise<number> {
  const { channels } = await renderedStats(
    base
      .clone()
      .extract(r)
      .greyscale()
      .convolve({ width: 3, height: 3, kernel: [0, -1, 0, -1, 4, -1, 0, -1, 0] }),
  );
  return channels[0]!.mean;
}

function redness(s: RegionStats): number {
  return s.r - (s.g + s.b) / 2;
}

function colorSpread(s: RegionStats): number {
  return (Math.abs(s.r - s.g) + Math.abs(s.g - s.b) + Math.abs(s.r - s.b)) / 2;
}

function clampScore(raw: number, min: number, max: number): number {
  const pct = ((raw - min) / (max - min)) * 100;
  return Math.round(Math.max(0, Math.min(100, pct)));
}

// [min, max] raw-metric bounds each concern is rescaled into 0-100.
// Hand-picked heuristic constants — tune these if scores consistently
// skew too high/low across real test photos.
const RANGES: Record<ConcernKey, [number, number]> = {
  darkCircles: [2, 28],
  darkSpots: [4, 22],
  acne: [-3, 18],
  dryness: [3, 16],
  oiliness: [-5, 25],
  dullness: [-40, -10],
};

export async function analyzeFaceImage(
  imageBuffer: Buffer,
): Promise<ConcernScore[]> {
  const canonicalBuffer = await sharp(imageBuffer)
    .rotate()
    .resize(CANVAS_WIDTH, CANVAS_HEIGHT, { fit: "cover" })
    .toFormat("png")
    .toBuffer();

  const base = sharp(canonicalBuffer);

  const [forehead, leftUnderEye, rightUnderEye, leftCheek, rightCheek, tZone, chin] =
    await Promise.all([
      statsFor(base, REGIONS.forehead),
      statsFor(base, REGIONS.leftUnderEye),
      statsFor(base, REGIONS.rightUnderEye),
      statsFor(base, REGIONS.leftCheek),
      statsFor(base, REGIONS.rightCheek),
      statsFor(base, REGIONS.tZone),
      statsFor(base, REGIONS.chin),
    ]);

  const [leftRoughness, rightRoughness] = await Promise.all([
    roughnessFor(base, REGIONS.leftCheek),
    roughnessFor(base, REGIONS.rightCheek),
  ]);

  const underEyeLuminance = (leftUnderEye.luminance + rightUnderEye.luminance) / 2;
  const cheekLuminance = (leftCheek.luminance + rightCheek.luminance) / 2;

  const raws: Record<ConcernKey, number> = {
    darkCircles: cheekLuminance - underEyeLuminance,
    darkSpots: (leftCheek.grayStdev + rightCheek.grayStdev + forehead.grayStdev) / 3,
    acne: (redness(leftCheek) + redness(rightCheek) + redness(chin)) / 3,
    dryness: (leftRoughness + rightRoughness) / 2,
    oiliness: tZone.luminance - cheekLuminance,
    dullness:
      -((colorSpread(leftCheek) + colorSpread(rightCheek) + colorSpread(forehead)) / 3),
  };

  return CONCERN_KEYS.map((key) => {
    const [min, max] = RANGES[key];
    const score = clampScore(raws[key], min, max);
    return {
      key,
      label: CONCERN_DEFS[key].label,
      score,
      detected: score >= DETECTION_THRESHOLD,
    };
  });
}

// Approximate on-photo markers for when the AI analyzer is unavailable
// and this heuristic ran instead. Unlike Gemini, the heuristic never
// found individual spots — it only measured an average over each fixed
// region — so these boxes mark "this whole area's reading crossed the
// threshold", not "here is one specific blemish". They reuse the same
// regions the scoring above measured, so the marker always matches what
// actually drove that concern's score.
export function getHeuristicDetections(scores: ConcernScore[]): Detection[] {
  const isDetected = (key: ConcernKey) => scores.find((s) => s.key === key)?.detected ?? false;
  const detections: Detection[] = [];

  if (isDetected("darkCircles")) {
    detections.push(
      { key: "darkCircles", box: regionToBox("leftUnderEye"), note: "Under-eye area" },
      { key: "darkCircles", box: regionToBox("rightUnderEye"), note: "Under-eye area" },
    );
  }
  if (isDetected("darkSpots")) {
    detections.push(
      { key: "darkSpots", box: regionToBox("leftCheek"), note: "Tone measured here" },
      { key: "darkSpots", box: regionToBox("rightCheek"), note: "Tone measured here" },
      { key: "darkSpots", box: regionToBox("forehead"), note: "Tone measured here" },
    );
  }
  if (isDetected("acne")) {
    detections.push(
      { key: "acne", box: regionToBox("leftCheek"), note: "Redness measured here" },
      { key: "acne", box: regionToBox("rightCheek"), note: "Redness measured here" },
      { key: "acne", box: regionToBox("chin"), note: "Redness measured here" },
    );
  }

  return detections;
}

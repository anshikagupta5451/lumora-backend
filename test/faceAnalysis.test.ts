// Tests for the offline, non-AI face analyzer (the fallback used whenever
// GEMINI_API_KEY is missing or Gemini fails). Images are generated in
// memory with sharp, so there's no fixture file, network or database.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  analyzeFaceImage,
  getHeuristicDetections,
  ovalCropRect,
  type ConcernScore,
} from "../src/lib/faceAnalysis";
import { CONCERN_DEFS, CONCERN_KEYS, DETECTION_THRESHOLD, type ConcernKey } from "../src/lib/skinConcerns";

const W = 600;
const H = 800;
type RGB = [number, number, number];

// Same fractions as REGION_FRACTIONS in faceAnalysis.ts: [xFrom, xTo, yFrom, yTo].
const R = {
  forehead: [0.3, 0.7, 0.1, 0.26],
  leftUnderEye: [0.22, 0.4, 0.47, 0.54],
  rightUnderEye: [0.6, 0.78, 0.47, 0.54],
  leftCheek: [0.16, 0.34, 0.56, 0.72],
  rightCheek: [0.66, 0.84, 0.56, 0.72],
  tZone: [0.44, 0.56, 0.42, 0.62],
  chin: [0.4, 0.6, 0.86, 0.95],
} as const;
type RegionName = keyof typeof R;

function inRegion(x: number, y: number, name: RegionName) {
  const [x0, x1, y0, y1] = R[name];
  return x >= x0 * W && x < x1 * W && y >= y0 * H && y < y1 * H;
}

// Builds a 600x800 PNG where every pixel's colour comes from `pixel`.
async function makeImage(pixel: (x: number, y: number) => RGB, width = W, height = H): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const SKIN: RGB = [190, 150, 120];
const GRAY: RGB = [128, 128, 128];

function scoreOf(scores: ConcernScore[], key: ConcernKey) {
  const s = scores.find((c) => c.key === key);
  assert.ok(s, `missing score for ${key}`);
  return s;
}

describe("analyzeFaceImage (heuristic fallback)", () => {
  test("returns one score per concern, in CONCERN_KEYS order, with labels and 0-100 integer scores", async () => {
    const scores = await analyzeFaceImage(await makeImage(() => SKIN));
    assert.deepEqual(
      scores.map((s) => s.key),
      CONCERN_KEYS,
    );
    for (const s of scores) {
      assert.equal(s.label, CONCERN_DEFS[s.key].label);
      assert.ok(Number.isInteger(s.score), `${s.key} score ${s.score} is not an integer`);
      assert.ok(s.score >= 0 && s.score <= 100, `${s.key} score ${s.score} out of range`);
      assert.equal(s.detected, s.score >= DETECTION_THRESHOLD, `${s.key} detected flag disagrees with threshold`);
      assert.equal(s.reasoning, undefined, "the heuristic has no reasoning to give");
    }
  });

  test("a flat, featureless gray image reads as no dark circles, dark spots, acne or oiliness", async () => {
    const scores = await analyzeFaceImage(await makeImage(() => GRAY));
    assert.equal(scoreOf(scores, "darkCircles").score, 0);
    assert.equal(scoreOf(scores, "darkSpots").score, 0);
    assert.equal(scoreOf(scores, "acne").detected, false);
    assert.equal(scoreOf(scores, "oiliness").detected, false);
  });

  test("a colourless gray image is scored as maximally dull (no colour spread at all)", async () => {
    const scores = await analyzeFaceImage(await makeImage(() => GRAY));
    const dull = scoreOf(scores, "dullness");
    assert.equal(dull.score, 100);
    assert.equal(dull.detected, true);
  });

  test("a strongly red face scores acne as detected; a neutral gray face does not", async () => {
    const red = await analyzeFaceImage(await makeImage(() => [220, 90, 90]));
    const gray = await analyzeFaceImage(await makeImage(() => GRAY));
    assert.equal(scoreOf(red, "acne").detected, true);
    assert.equal(scoreOf(gray, "acne").detected, false);
    assert.ok(scoreOf(red, "acne").score > scoreOf(gray, "acne").score);
  });

  // ---- Suspected bug: sharp's .stats() ignores extract()/greyscale()/convolve()
  // in the pipeline and always reports statistics for the WHOLE input image
  // (faceAnalysis.ts:111 and :130-136). Every "region" therefore returns the
  // same numbers, so region comparisons (dark circles, oiliness) are always 0
  // and "dryness" is really whole-image brightness. These tests describe the
  // documented intent and are skipped so the suite stays green.

  test(
    "under-eye areas much darker than the cheeks are detected as dark circles",
    async () => {
      const img = await makeImage((x, y) =>
        inRegion(x, y, "leftUnderEye") || inRegion(x, y, "rightUnderEye") ? [110, 80, 70] : SKIN,
      );
      assert.equal(scoreOf(await analyzeFaceImage(img), "darkCircles").detected, true);
    },
  );

  test(
    "a T-zone much brighter than the cheeks is detected as oiliness",
    async () => {
      const img = await makeImage((x, y) => (inRegion(x, y, "tZone") ? [250, 245, 240] : [150, 120, 100]));
      assert.equal(scoreOf(await analyzeFaceImage(img), "oiliness").detected, true);
    },
  );

  test(
    "a smooth, evenly lit face is not flagged as dry",
    async () => {
      const scores = await analyzeFaceImage(await makeImage(() => SKIN));
      assert.equal(scoreOf(scores, "dryness").detected, false);
    },
  );

  test(
    "redness outside the cheeks and chin (e.g. a red background) does not raise the acne score",
    async () => {
      const img = await makeImage((x, y) => (y < 100 ? [250, 40, 40] : GRAY));
      const gray = await analyzeFaceImage(await makeImage(() => GRAY));
      assert.equal(scoreOf(await analyzeFaceImage(img), "acne").score, scoreOf(gray, "acne").score);
    },
  );

  test("is deterministic: the same image always gives the same scores", async () => {
    const img = await makeImage((x, y) => [(x * 7) % 256, (y * 3) % 256, ((x + y) * 5) % 256]);
    assert.deepEqual(await analyzeFaceImage(img), await analyzeFaceImage(img));
  });

  test("accepts photos that aren't 600x800 (e.g. a small JPEG) by normalising them first", async () => {
    const raw = Buffer.alloc(300 * 400 * 3, 128);
    const jpeg = await sharp(raw, { raw: { width: 300, height: 400, channels: 3 } }).jpeg().toBuffer();
    const scores = await analyzeFaceImage(jpeg);
    assert.equal(scores.length, CONCERN_KEYS.length);
    for (const s of scores) assert.ok(s.score >= 0 && s.score <= 100);
  });

  test("rejects a buffer that isn't an image instead of returning made-up scores", async () => {
    await assert.rejects(analyzeFaceImage(Buffer.from("definitely not an image")));
    await assert.rejects(analyzeFaceImage(Buffer.alloc(0)));
  });
});

function score(key: ConcernKey, detected: boolean): ConcernScore {
  return { key, label: CONCERN_DEFS[key].label, score: detected ? 80 : 10, detected };
}

describe("getHeuristicDetections", () => {
  test("returns no markers when nothing is detected", () => {
    assert.deepEqual(getHeuristicDetections(CONCERN_KEYS.map((k) => score(k, false))), []);
    assert.deepEqual(getHeuristicDetections([]), []);
  });

  test("marks both under-eye regions for dark circles, with boxes matching the measured regions", () => {
    const d = getHeuristicDetections([score("darkCircles", true)]);
    assert.equal(d.length, 2);
    assert.ok(d.every((x) => x.key === "darkCircles" && x.note === "Under-eye area"));
    // leftUnderEye fractions [0.22, 0.4, 0.47, 0.54] → [ymin, xmin, ymax, xmax] on a 0-1000 scale.
    assert.deepEqual(d[0]!.box, [470, 220, 540, 400]);
    assert.deepEqual(d[1]!.box, [470, 600, 540, 780]);
  });

  test("marks cheeks + forehead for dark spots and cheeks + chin for acne", () => {
    const d = getHeuristicDetections([score("darkSpots", true), score("acne", true)]);
    assert.equal(d.filter((x) => x.key === "darkSpots").length, 3);
    assert.equal(d.filter((x) => x.key === "acne").length, 3);
    assert.ok(d.some((x) => x.key === "acne" && x.box[0] === 860), "acne should include the chin box");
  });

  test("never draws boxes for whole-face concerns (dryness, oiliness, dullness)", () => {
    const d = getHeuristicDetections([score("dryness", true), score("oiliness", true), score("dullness", true)]);
    assert.deepEqual(d, []);
  });

  test("every box is a valid [ymin, xmin, ymax, xmax] inside 0-1000", () => {
    const d = getHeuristicDetections(CONCERN_KEYS.map((k) => score(k, true)));
    assert.equal(d.length, 8);
    for (const { box } of d) {
      const [ymin, xmin, ymax, xmax] = box;
      assert.ok(box.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000));
      assert.ok(ymin < ymax && xmin < xmax);
    }
  });
});

describe("ovalCropRect", () => {
  test("on a tall phone, crops the oval from the middle of a 3:4 photo the preview only partly shows", () => {
    // 3000x4000 photo, 0.45 screen: the preview shows x 600-2400 (1800 wide), all 4000 rows.
    const r = ovalCropRect(3000, 4000, 0.45);
    assert.equal(r.width, 1152); // 64% of the 1800 px the preview shows
    assert.equal(r.left, 924); // 600 + 18% of 1800
    assert.equal(r.top, 640); // 16% of 4000
    assert.equal(r.height, 1555); // 1.35x the width
  });

  test("when the photo and screen have the same shape, matches the oval's screen fractions", () => {
    const r = ovalCropRect(1000, 2000, 0.5);
    assert.deepEqual(r, { left: 180, top: 320, width: 640, height: 864 });
  });

  test("on a screen wider than the photo, the preview crops top and bottom instead", () => {
    // 1000x2000 photo on a 0.75 screen: the preview shows rows 667-1333 (1333 tall).
    const r = ovalCropRect(1000, 2000, 0.75);
    assert.equal(r.left, 180);
    assert.equal(r.width, 640);
    assert.equal(r.top, Math.round(333.33 + 0.16 * 1333.33));
  });

  test("always stays inside the photo", () => {
    for (const [w, h, a] of [[3000, 4000, 0.45], [4000, 3000, 0.45], [600, 800, 1.5], [100, 100, 0.3]] as const) {
      const r = ovalCropRect(w, h, a);
      assert.ok(r.left >= 0 && r.top >= 0 && r.width >= 1 && r.height >= 1);
      assert.ok(r.left + r.width <= w && r.top + r.height <= h, `out of bounds for ${w}x${h} @ ${a}`);
    }
  });
});

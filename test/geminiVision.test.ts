// Tests for the Gemini face-scan wrapper. The parsing/validation code is
// private, so it's exercised through the exported analyzeFaceWithGemini
// with globalThis.fetch replaced by a stub — no request ever leaves the
// process and no real API key is used or read.

import { test, describe, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { CONCERN_DEFS, CONCERN_KEYS, DETECTION_THRESHOLD } from "../src/lib/skinConcerns";

type Analyze = typeof import("../src/lib/geminiVision").analyzeFaceWithGemini;

const PRIMARY = "primary-test-model";
const FALLBACK = "fallback-test-model";
const ENV_KEYS = ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_FALLBACK_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let analyze: Analyze;
let calls: { url: string; body: any }[] = [];

// Each queued responder answers one fetch call, in order.
function stubFetch(...responders: (() => Response | Promise<Response>)[]) {
  calls = [];
  let i = 0;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
    const r = responders[Math.min(i++, responders.length - 1)];
    if (!r) throw new Error("no stub response");
    return r();
  }) as typeof fetch;
}

// Wraps model JSON the way the Gemini generateContent API does.
function modelReply(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
}

function allConcerns(score = 10) {
  return CONCERN_KEYS.map((key) => ({ key, score, detected: score >= DETECTION_THRESHOLD, reasoning: `${key} looks fine` }));
}

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Model names are read when the module loads, so set them before importing.
  process.env.GEMINI_MODEL = PRIMARY;
  process.env.GEMINI_FALLBACK_MODEL = FALLBACK;
  delete process.env.GEMINI_API_KEY;
  mock.method(console, "warn", () => {});
  mock.method(console, "error", () => {});
  analyze = (await import("../src/lib/geminiVision")).analyzeFaceWithGemini;
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
  mock.restoreAll();
});

describe("analyzeFaceWithGemini without GEMINI_API_KEY", () => {
  test("returns null (so the caller uses the heuristic) and never calls fetch", async () => {
    delete process.env.GEMINI_API_KEY;
    stubFetch(modelReply({ concerns: allConcerns(), detections: [] }));
    assert.equal(await analyze(IMAGE, "image/jpeg"), null);
    assert.equal(calls.length, 0);
  });

  test("treats an empty-string key the same as a missing key", async () => {
    process.env.GEMINI_API_KEY = "";
    stubFetch(modelReply({ concerns: allConcerns(), detections: [] }));
    assert.equal(await analyze(IMAGE, "image/jpeg"), null);
    assert.equal(calls.length, 0);
  });
});

describe("analyzeFaceWithGemini parsing and validation (stubbed fetch)", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
  });
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    globalThis.fetch = realFetch;
  });

  test("a well-formed reply becomes one ConcernScore per concern, in CONCERN_KEYS order, with our labels", async () => {
    stubFetch(modelReply({ concerns: [...allConcerns(20)].reverse(), detections: [] }));
    const result = await analyze(IMAGE, "image/jpeg");
    assert.ok(result);
    assert.deepEqual(result.scores.map((s) => s.key), CONCERN_KEYS);
    for (const s of result.scores) {
      assert.equal(s.label, CONCERN_DEFS[s.key].label);
      assert.equal(s.score, 20);
      assert.equal(s.reasoning, `${s.key} looks fine`);
    }
    assert.deepEqual(result.detections, []);
  });

  test("sends the image as base64 to the configured primary model", async () => {
    stubFetch(modelReply({ concerns: allConcerns(), detections: [] }));
    await analyze(IMAGE, "image/png");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, new RegExp(`/models/${PRIMARY}:generateContent`));
    const inline = calls[0]!.body.contents[0].parts[0].inline_data;
    assert.equal(inline.mime_type, "image/png");
    assert.equal(inline.data, IMAGE.toString("base64"));
  });

  test("clamps out-of-range scores to 0-100 and rounds fractional ones", async () => {
    const concerns = allConcerns();
    concerns[0]!.score = 150;
    concerns[1]!.score = -20;
    concerns[2]!.score = 42.6;
    stubFetch(modelReply({ concerns, detections: [] }));
    const result = await analyze(IMAGE, "image/jpeg");
    assert.ok(result);
    assert.equal(result.scores[0]!.score, 100);
    assert.equal(result.scores[1]!.score, 0);
    assert.equal(result.scores[2]!.score, 43);
  });

  test("a concern the model left out gets score 0, not detected, and no reasoning", async () => {
    stubFetch(modelReply({ concerns: allConcerns(60).filter((c) => c.key !== "dullness"), detections: [] }));
    const result = await analyze(IMAGE, "image/jpeg");
    assert.ok(result);
    const dull = result.scores.find((s) => s.key === "dullness");
    assert.deepEqual(dull, { key: "dullness", label: CONCERN_DEFS.dullness.label, score: 0, detected: false });
  });

  test("unknown concern keys from the model are ignored rather than added", async () => {
    stubFetch(modelReply({ concerns: [...allConcerns(), { key: "wrinkles", score: 99, detected: true, reasoning: "x" }], detections: [] }));
    const result = await analyze(IMAGE, "image/jpeg");
    assert.ok(result);
    assert.equal(result.scores.length, CONCERN_KEYS.length);
    assert.ok(!result.scores.some((s) => (s.key as string) === "wrinkles"));
  });

  test("when 'detected' is missing it is derived from the score threshold", async () => {
    const concerns = [
      { key: "acne", score: DETECTION_THRESHOLD, reasoning: "r" },
      { key: "dryness", score: DETECTION_THRESHOLD - 1, reasoning: "r" },
    ];
    stubFetch(modelReply({ concerns, detections: [] }));
    const result = await analyze(IMAGE, "image/jpeg");
    assert.ok(result);
    assert.equal(result.scores.find((s) => s.key === "acne")!.detected, true);
    assert.equal(result.scores.find((s) => s.key === "dryness")!.detected, false);
  });

  test("detections: keeps only localizable concerns with a 4-number box, caps at 10, defaults note to ''", async () => {
    const good = { key: "acne", box_2d: [100, 100, 200, 200], note: "spot" };
    const detections = [
      { key: "dryness", box_2d: [0, 0, 10, 10], note: "whole-face concern" },
      { key: "darkSpots", box_2d: [1, 2, 3], note: "only 3 numbers" },
      { key: "darkCircles", box_2d: "not an array", note: "bad" },
      null,
      { key: "darkCircles", box_2d: [300, 300, 350, 400] },
      ...Array.from({ length: 12 }, () => good),
    ];
    stubFetch(modelReply({ concerns: allConcerns(), detections }));
    const result = await analyze(IMAGE, "image/jpeg");
    assert.ok(result);
    assert.equal(result.detections.length, 10);
    assert.deepEqual(result.detections[0], { key: "darkCircles", box: [300, 300, 350, 400], note: "" });
    assert.ok(result.detections.every((d) => ["darkCircles", "darkSpots", "acne"].includes(d.key)));
  });

  test("a missing detections array is treated as no detections, not a failure", async () => {
    stubFetch(modelReply({ concerns: allConcerns() }));
    const result = await analyze(IMAGE, "image/jpeg");
    assert.ok(result);
    assert.deepEqual(result.detections, []);
  });

  test("malformed model output (bad JSON, no concerns array, empty reply) returns null on both models", async () => {
    for (const reply of [
      modelReply("{not json"),
      modelReply({ concerns: "nope", detections: [] }),
      () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    ]) {
      stubFetch(reply);
      assert.equal(await analyze(IMAGE, "image/jpeg"), null);
      assert.equal(calls.length, 2, "tries primary then fallback, without retrying the same model");
    }
  });

  test("a network error returns null instead of throwing", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    assert.equal(await analyze(IMAGE, "image/jpeg"), null);
  });

  test("a non-retryable HTTP error moves straight to the fallback model, which can still succeed", async () => {
    stubFetch(
      () => new Response("bad request", { status: 400 }),
      modelReply({ concerns: allConcerns(55), detections: [] }),
    );
    const result = await analyze(IMAGE, "image/jpeg");
    assert.ok(result);
    assert.equal(result.scores[0]!.score, 55);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.url, new RegExp(`/models/${FALLBACK}:`));
  });

  test("a daily-quota 429 is not retried on the same model", async () => {
    const quota = () => new Response('{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}', { status: 429 });
    stubFetch(quota, quota);
    assert.equal(await analyze(IMAGE, "image/jpeg"), null);
    assert.deepEqual(
      calls.map((c) => c.url.includes(PRIMARY) ? "primary" : "fallback"),
      ["primary", "fallback"],
    );
  });

  test("a transient 503 is retried on the same model and the retry's result is used", async () => {
    stubFetch(
      () => new Response("overloaded", { status: 503 }),
      modelReply({ concerns: allConcerns(70), detections: [] }),
    );
    const result = await analyze(IMAGE, "image/jpeg");
    assert.ok(result);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.url.includes(PRIMARY)));
    assert.equal(result.scores[0]!.detected, true);
  });

  // ---- Suspected validation gaps (AGENTS.md §4: "validate ... and clamp").

  test(
    "a non-numeric score is rejected or clamped, never stored as NaN",
    async () => {
      const concerns = allConcerns();
      (concerns[0] as { score: unknown }).score = "high";
      stubFetch(modelReply({ concerns, detections: [] }));
      const result = await analyze(IMAGE, "image/jpeg");
      if (result) assert.ok(Number.isFinite(result.scores[0]!.score));
    },
  );

  test(
    "detection boxes are clamped to the 0-1000 range and must be numbers",
    async () => {
      stubFetch(modelReply({ concerns: allConcerns(), detections: [{ key: "acne", box_2d: [-50, 0, 2000, "x"], note: "n" }] }));
      const result = await analyze(IMAGE, "image/jpeg");
      assert.ok(result);
      for (const d of result.detections) assert.ok(d.box.every((v) => typeof v === "number" && v >= 0 && v <= 1000));
    },
  );

  test(
    "'detected' is always a boolean consistent with the clamped score",
    async () => {
      const concerns = allConcerns(5);
      (concerns[0] as { detected: unknown }).detected = "yes";
      concerns[1]!.detected = true; // score 5, far below threshold
      stubFetch(modelReply({ concerns, detections: [] }));
      const result = await analyze(IMAGE, "image/jpeg");
      assert.ok(result);
      for (const s of result.scores) assert.equal(s.detected, s.score >= DETECTION_THRESHOLD);
    },
  );
});

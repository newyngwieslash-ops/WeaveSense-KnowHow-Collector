import test from "node:test";
import assert from "node:assert/strict";
import { canonicalTranscript, videoEvidenceTime, videoTextPreview } from "./video-contract.ts";

test("temporal API projection preserves exact bigint milliseconds and unknown time", () => {
  assert.deepEqual(videoEvidenceTime({ start_ms: "0", end_ms: "4000" }), { start_ms: 0, end_ms: 4000 });
  assert.deepEqual(videoEvidenceTime({ start_ms: 0, end_ms: 4000 }), { start_ms: 0, end_ms: 4000 });
  assert.deepEqual(videoEvidenceTime({ start_ms: null, end_ms: null }), { start_ms: null, end_ms: null });
  assert.deepEqual(videoEvidenceTime({}), { start_ms: null, end_ms: null });
  assert.deepEqual(videoEvidenceTime({ start_ms: "9007199254740991", end_ms: "9007199254740991" }), { start_ms: Number.MAX_SAFE_INTEGER, end_ms: Number.MAX_SAFE_INTEGER });
});

test("temporal API projection rejects corruption instead of rounding or inventing zero", () => {
  for (const value of ["", " ", "01", "1e3", "1.5", "-1", "NaN", "Infinity", "9007199254740992", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}, []]) {
    assert.throws(() => videoEvidenceTime({ start_ms: value, end_ms: value }), (e: any) => e.status === 422 && e.reason === "INVALID_EVIDENCE_TIME");
  }
  for (const row of [{ start_ms: 0, end_ms: null }, { start_ms: null, end_ms: 1 }, { start_ms: "4000", end_ms: "0" }]) {
    assert.throws(() => videoEvidenceTime(row), /INVALID_EVIDENCE_TIME/);
  }
});

test("bounded evidence and conflict previews retain complete UTF-16 characters", () => {
  for (const limit of [250, 1200]) {
    const input = "中".repeat(limit - 1) + "😀e\u0301完整尾部";
    const preview = videoTextPreview(input, limit);
    assert.equal(preview, "中".repeat(limit - 1));
    assert.ok(preview.isWellFormed());
    assert.equal(preview + input.slice(preview.length), input);
  }
});

test("model observations and explicit derived records cannot become canonical source quotes", () => {
  for (const segment of [
    { text: "synthetic visual conclusion", kind: "observation", start_ms: 1, end_ms: 1, frame_ref: "a-valid-frame-does-not-make-this-source" },
    { text: "synthetic inferred source", kind: "asr", start_ms: 0, end_ms: 1000, derived: true },
  ]) assert.throws(() => canonicalTranscript("Synthetic fixture", [segment as any]), (error: any) => error.reason === "DERIVED_MATERIAL_NOT_SOURCE");
});

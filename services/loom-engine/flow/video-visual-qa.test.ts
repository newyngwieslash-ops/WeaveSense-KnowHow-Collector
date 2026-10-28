import test from "node:test";
import assert from "node:assert/strict";
import { canonicalHash, sha, type VideoManifest } from "./video-contract.ts";
import { validateVisualPart } from "./video-visual.ts";

const frameKey = `tenants/qa/workspaces/qa/video/vj_qa/${"a".repeat(64)}/frame-001.jpg`;
const frame = { frame_id: "frame-001", object_key: frameKey, sha256: "a".repeat(64), timestamp_ms: 1000, media_sha256: "b".repeat(64) };
const manifest: VideoManifest = { schema_version: 1, artifact_stage: "processing_complete", video_job_id: "vj_qa", stage_attempt: 1, fencing_token: 1,
  input_kind: "media", input_hash: "b".repeat(64), media_sha256: "b".repeat(64), availability: "available", objects: [], frames: [frame],
  processors: { version: "qa-artifact-only" }, coverage: { required: [], completed: [], missing: [], duration_ms: 2000 } };
const observation = { type: "model_observation", derived: true, text: "Unreviewed synthetic observation", frame_ids: [frame.frame_id], frame_refs: [frameKey],
  start_ms: 1000, end_ms: 1000, media_sha256: frame.media_sha256, review_status: "unreviewed", provenance: { model_tasks: [{ task_id: "fixture-not-model-quality", usage_ref: "model_task:fixture-not-model-quality", model_config_hash: "f".repeat(64) }] } };

function validate(record: Record<string, unknown>) {
  // Re-sign the content identity after each mutation: a negative result must
  // come from the actual semantic validator, not merely a stale record hash.
  const raw = Buffer.from(JSON.stringify({ records: [{ ...record, record_id: canonicalHash(record) }] }));
  return validateVisualPart(manifest, { object_key: "fixture-part", sha256: sha(raw), bytes: raw.length, content_type: "application/json",
    record_count: 1, start_ms: Number(record.start_ms), end_ms: Number(record.end_ms) }, raw);
}

test("QA K013: each model frame identity must match the actual referenced frame, not only a valid object key", () => {
  assert.equal(validate(observation)[0].type, "model_observation");
  for (const patch of [{ frame_ids: ["invented-frame"] }, { frame_ids: [] }, { frame_ids: undefined }, { frame_ids: [frame.frame_id, frame.frame_id] }, { start_ms: 900, end_ms: 1100 }]) {
    assert.throws(() => validate({ ...observation, ...patch }), undefined, JSON.stringify(patch));
  }
});

test("QA K015: OCR, model inference and temporal overlap cannot masquerade as verified source agreement", () => {
  assert.equal(validate({ ...observation, type: "model_inference" })[0].derived, true);
  assert.throws(() => validate({ ...observation, derived: false }));
  assert.throws(() => validate({ ...observation, review_status: "approved" }));
  const alignment = { type: "alignment", frame_id: frame.frame_id, frame_ref: frameKey, start_ms: 1000, end_ms: 1000,
    relation: "unaligned", semantic_relation: "not_assessed", audio_segments: [] };
  assert.equal(validate(alignment)[0].relation, "unaligned");
  assert.throws(() => validate({ ...alignment, semantic_relation: "same_fact" }));
  const ocr = { type: "ocr", frame_id: frame.frame_id, frame_ref: frameKey, start_ms: 1000, end_ms: 1000,
    media_sha256: frame.media_sha256, text: "原画面文字", observed_text: "原画面文字", review_status: "unreviewed" };
  assert.equal(validate(ocr)[0].type, "ocr");
  assert.throws(() => validate({ ...ocr, observed_text: "model paraphrase" }));
});

test("QA K013: visual provenance requires a bounded unique host task, matching usage receipt and frozen model hash", () => {
  const task = observation.provenance.model_tasks[0];
  for (const tasks of [[{}], [{ ...task, task_id: "" }], [{ ...task, task_id: "https://untrusted.test/task" }],
    [{ ...task, usage_ref: "model_task:another-task" }], [{ ...task, model_config_hash: null }],
    [{ ...task, model_config_hash: ["f".repeat(64)] }], [{ ...task, model_config_hash: "route-name-not-frozen-hash" }], [task, task], Array.from({ length: 1001 }, (_, i) => ({ ...task, task_id: `task-${i}`, usage_ref: `model_task:task-${i}` }))]) {
    assert.throws(() => validate({ ...observation, provenance: { model_tasks: tasks } }), (error: any) => error.reason === "INVALID_VISUAL_PROVENANCE");
  }
});

test("QA K003: malformed visual JSON containers and null nested records produce controlled validation errors", () => {
  for (const payload of [null, [], true, "not records", { records: null }, { records: [null] }]) {
    const raw = Buffer.from(JSON.stringify(payload));
    assert.throws(() => validateVisualPart(manifest, { object_key: "fixture-part", sha256: sha(raw), bytes: raw.length, content_type: "application/json", record_count: 1, start_ms: 1000, end_ms: 1000 }, raw),
      (error: any) => error.status === 422);
  }
  const alignment = { type: "alignment", frame_id: frame.frame_id, frame_ref: frameKey, start_ms: 1000, end_ms: 1000,
    relation: "temporal_overlap", semantic_relation: "not_assessed", audio_segments: [null] };
  assert.throws(() => validate(alignment), (error: any) => error.reason === "INVALID_ALIGNMENT");
  assert.throws(() => validate({ ...alignment, relation: "unaligned", audio_segments: [], conflict_candidates: [null] }), (error: any) => error.reason === "INVALID_CONFLICT_CANDIDATE");
});

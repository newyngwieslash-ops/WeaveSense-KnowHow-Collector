// Actual PostgreSQL concurrency only. PGlite's single connection cannot prove
// that cancellation re-reads readiness after waiting for another transaction.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgDb, migrate, type Db } from "./db.ts";
import { Engine } from "./engine.ts";
import { sha, type VideoManifest } from "./video-contract.ts";
import { configureVideoRetentionJournal, initializeVideoDeletionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { applyVideoRetention } from "./video-knowledge.ts";
import { closeIsolatedPostgresDatabase } from "../validation/video-knowledge/pg-test-cleanup.ts";

const url = process.env.FLOW_VIDEO_TEST_PG_URL;
test("AC07 PostgreSQL: cancel waits for real ready commit then refuses to cancel or delete accepted objects", { skip: !url && "isolated FLOW_VIDEO_TEST_PG_URL required", timeout: 30_000 }, async t => {
  const maintenance = await pgDb(url!), name = `qa_cancel_ready_${process.pid}_${Date.now()}`;
  await maintenance.query(`CREATE DATABASE "${name}"`);
  const target = new URL(url!); target.pathname = `/${name}`;
  const primary = await pgDb(target.toString()), other = await pgDb(target.toString());
  const directory = await mkdtemp(join(tmpdir(), "video-cancel-ready-"));
  t.after(async () => {
    try { await closeIsolatedPostgresDatabase(maintenance, name, [primary, other]); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  assert.equal((await primary.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, false);
  await migrate(primary);
  const journal = { directory: join(directory, "journal"), journalId: "cancel-ready-test", key: "synthetic-cancel-ready-key-not-production" };
  await initializeVideoDeletionJournal(journal);
  let pause = false, release!: () => void, entered!: () => void, cancellationEntered!: (pid: number) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const readyEntered = new Promise<void>(resolve => { entered = resolve; });
  const cancelEntered = new Promise<number>(resolve => { cancellationEntered = resolve; });
  // Gate only timing AFTER a real UPDATE holds the row. No query result, ready
  // state, stage fence, document, index, object or outbox event is fabricated.
  const gated: Db = { ...primary, tx: fn => primary.tx(q => fn({ query: async (sql, params) => {
    const result = await q.query(sql, params);
    if (pause && sql.startsWith("UPDATE flow_video_jobs SET state=$4,stage='ready',completion_level='knowledge_ready'")) {
      pause = false; entered(); await gate;
    }
    return result;
  } })) };
  const cancelling: Db = { ...other, tx: fn => other.tx(async q => {
    const pid = Number((await q.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    return fn({ query: (sql, params) => {
      if (sql.startsWith("SELECT * FROM flow_video_jobs WHERE")) cancellationEntered(pid);
      return q.query(sql, params);
    } });
  }) };
  const first = new Engine(gated), second = new Engine(cancelling);
  for (const engine of [first, second]) {
    engine.video.enabled = true;
    configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
  }
  await replayVideoRetentionJournal(first);
  const scope = { tenant_id: "cancel_t", workspace_id: "cancel_w", actor: { type: "user", id: "reviewer" }, policy_version: "test_v1" };
  const profile = await first.video.saveProfile(scope, { name: "Synthetic cancellation race", config: { required_capabilities: ["transcript"] } });
  const source = await first.createSource(scope, { kind: "bilibili", title: "Self-authored cancellation fixture", url: "https://www.bilibili.com/video/BV1CANCEL001",
    config: { source_type: "video", native_id: "BV1CANCEL001", profile_id: profile.id, profile_version: profile.version, usage_basis: "Synthetic concurrency fixture only", allowed_uses: ["knowledge"] } });
  const receipt = await first.video.start(scope, "cancel-ready-race", { source_id: source.id });
  const bytes = new Map<string, Uint8Array>();
  first.video.provider = { instance: "synthetic-race-provider", discover: async () => ({ items: [], complete: true, next_cursor: null }),
    submit: async () => { throw new Error("explicit signed manifests only"); }, poll: async () => { throw new Error("explicit signed manifests only"); }, cancel: async () => "unsupported",
    readObject: async (_s, _j, key) => { const value = bytes.get(key); assert.ok(value); return value; } };
  const segments = [{ text: "Self-authored ready evidence.", start_ms: 0, end_ms: 1000 }];
  function object(name: string) {
    const raw = Buffer.from(JSON.stringify({ segments })), digest = sha(raw);
    const ref = { object_key: `tenants/${scope.tenant_id}/workspaces/${scope.workspace_id}/video/${receipt.video_job_id}/${digest}/${name}.json`, sha256: digest, bytes: raw.length, content_type: "application/json" };
    bytes.set(ref.object_key, raw); return ref;
  }
  const input = object("input"), inputStage = await first.video.claim("input-worker");
  const base: VideoManifest = { schema_version: 1, artifact_stage: "input_ready", video_job_id: receipt.video_job_id,
    stage_attempt: inputStage.attempt, fencing_token: Number(inputStage.fencing_token), input_kind: "platform_subtitles", input_hash: input.sha256,
    media_sha256: null, availability: "not_acquired", objects: [input], coverage: { required: [], completed: [], missing: [] }, processors: { version: "synthetic-race-v1" } };
  const accepted = await first.video.importManifest(scope, receipt.video_job_id, base, inputStage);
  const stage = await first.video.claim("process-worker"), output = object("transcript");
  const manifest: VideoManifest = { ...base, artifact_stage: "processing_complete", stage_attempt: stage.attempt, fencing_token: Number(stage.fencing_token),
    parent_manifest_sha256: accepted.manifest_sha256, objects: [output], transcript: { parts: [{ object_key: output.object_key, sha256: output.sha256, segment_count: 1, start_ms: 0, end_ms: 1000 }] },
    coverage: { required: ["transcript"], completed: ["transcript"], missing: [], duration_ms: 1000 } };
  pause = true;
  const committing = first.video.importManifest(scope, receipt.video_job_id, manifest, stage);
  let cancellation: Promise<{ value?: unknown; error?: any }> | undefined;
  try {
    await Promise.race([readyEntered, committing.then(() => { throw new Error("ready commit bypassed concurrency gate"); })]);
    let settled = false;
    cancellation = second.video.cancel(scope, receipt.video_job_id, "Synthetic concurrent cancellation").then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    const pid = await cancelEntered;
    let blocked: any;
    const deadline = Date.now() + 5000;
    do {
      blocked = (await primary.query("SELECT state,wait_event_type,query FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
      if (blocked?.wait_event_type === "Lock") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(settled, false, "cancel must not succeed before the concurrent ready transaction commits");
    assert.equal(blocked?.wait_event_type, "Lock", "independent PostgreSQL session really waits on the ready transaction");
    assert.match(blocked.query, /^SELECT \* FROM flow_video_jobs .*FOR UPDATE/);
    release();
    const ready = await committing, result = await cancellation;
    assert.equal(ready.completion_level, "knowledge_ready");
    assert.equal(result.error?.status, 409);
    assert.equal(result.error?.reason, "ALREADY_READY_USE_WITHDRAW");
    const current = await first.video.get(scope, receipt.video_job_id);
    assert.equal(current.state, "completed"); assert.equal(current.completion_level, "knowledge_ready");
    assert.equal(current.remote_cancel_status, "not_requested"); assert.equal(current.error, null);
    const objects = (await primary.query("SELECT object_key,state FROM flow_video_objects WHERE video_job_id=$1 ORDER BY object_key", [receipt.video_job_id])).rows;
    assert.equal(objects.length, 2); assert.ok(objects.every(x => x.state === "accepted"));
    assert.deepEqual(objects.map(x => x.object_key).sort(), [input.object_key, output.object_key].sort());
    assert.equal((await primary.query("SELECT count(*)::int n FROM flow_evidence WHERE document_id=$1", [ready.document_id])).rows[0].n, 1);
    assert.equal((await primary.query("SELECT count(*)::int n FROM flow_outbox WHERE job_id=$1 AND type='video.knowledge_ready'", [receipt.video_job_id])).rows[0].n, 1);
    assert.equal((await primary.query("SELECT count(*)::int n FROM flow_document_chunks WHERE document_id=$1", [ready.document_id])).rows[0].n, 1);
    t.diagnostic("real PostgreSQL two-pool row-lock interleaving; actual ready import wins, late cancel returns409 without deleting evidence/object metadata");
  } finally {
    release(); await committing.catch(() => {}); await cancellation;
  }
});

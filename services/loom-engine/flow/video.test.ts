import { test } from "node:test";
import assert from "node:assert/strict";
import { pgliteDb, migrate } from "./db.ts";
import { Engine } from "./engine.ts";
import { previousCron } from "./cron.ts";
import { sha, normalizeVideoURL, type VideoManifest } from "./video-contract.ts";
import type { VideoProvider } from "./video-provider.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { applyVideoRetention } from "./video-knowledge.ts";
import { admitVideoResources, settleVideoResources } from "./video-resources.ts";
import { validateVisualPart } from "./video-visual.ts";
import { canonicalHash } from "./video-contract.ts";

// Explicit synthetic fixtures; these exercise the actual database/state machine, not platform availability.
const S = { tenant_id: "test_t", workspace_id: "test_w", actor: { type: "user", id: "reviewer" }, policy_version: "policy_v1" };
async function setup(t: any, options: any = {}) {
  const db = await pgliteDb(); t.after(() => db.close()); await migrate(db);
  let now = new Date("2026-10-26T00:00:00Z");
  const engine = new Engine(db, async () => [], () => now); engine.video.enabled = true;
  const root = await mkdtemp(join(tmpdir(), "video-core-journal-"));
  const journal = { directory: join(root, "journal"), journalId: "synthetic-core-journal", key: "synthetic-fixture-key-never-a-production-secret" };
  await initializeVideoDeletionJournal(journal); configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
  await replayVideoRetentionJournal(engine);
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = await engine.video.saveProfile(S, { name: "Synthetic development domain", config: { required_capabilities: ["transcript"], max_discovery_pages: 1, ...options } });
  const source = await engine.createSource(S, { kind: "bilibili", url: "https://space.bilibili.com/123456", title: "fixture account",
    config: { source_type: "account", author_id: "123456", profile_id: profile.id, profile_version: 1, usage_basis: "synthetic fixture only", allowed_uses: ["knowledge"] } });
  const objects = new Map<string, Uint8Array>();
  const provider: VideoProvider = { instance: "fixture", discover: async () => ({ items: [], complete: true, next_cursor: null, mode: "fixture" }),
    submit: async () => ({ task_id: "external_fixture", state: "pending" }), poll: async () => ({ task_id: "external_fixture", state: "pending" }), cancel: async () => "unsupported",
    readObject: async (_s, _j, key) => { const value = objects.get(key); if (!value) throw new Error("fixture object missing"); return value; },
    verifyObject: async (_s, _j, key) => { const value = objects.get(key)!; return { bytes: value.byteLength, sha256: sha(value) }; } };
  engine.video.provider = provider;
  const input = { source_id: source.id, native_id: "BV1fixture", canonical_url: "https://www.bilibili.com/video/BV1fixture", content_version: "v1" };
  return { db, engine, profile, source, provider, input, objects, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test("CFG001 immutable scoped versions and fresh JWTs share business fingerprint", async t => {
  const f = await setup(t);
  const newer = await f.engine.video.saveProfile(S, { id: f.profile.id, expected_version: 1, name: "v2", config: { required_capabilities: ["transcript"] } });
  assert.equal(newer.version, 2);
  await assert.rejects(f.engine.video.saveProfile(S, { id: f.profile.id, expected_version: 1, name: "stale", config: {} }), (e: any) => e.status === 409);
  await assert.rejects(f.engine.video.profile({ ...S, workspace_id: "foreign" }, f.profile.id, 1), (e: any) => e.status === 404);
  const a = await f.engine.video.start({ ...S, jti: "a", iat: 1, exp: 2 } as any, "a", f.input);
  const b = await f.engine.video.start({ ...S, jti: "b", iat: 3, exp: 4 } as any, "b", f.input);
  assert.equal(a.video_job_id, b.video_job_id);
  assert.equal(a.profile_version, 1);
  await assert.rejects(f.engine.video.start(S, "a", { ...f.input, content_version: "v2" }), (e: any) => e.reason === "IDEMPOTENCY_CONFLICT");
  assert.equal((await f.engine.video.reconcile(S, { idempotency_key: "a" })).video_job_id, a.video_job_id);
});

test("COL004/020 canonical Bili P1 and daily backend admission never double count replay", async t => {
  const f = await setup(t, { max_daily_jobs: 1 });
  const a = await f.engine.video.start(S, "part-default", f.input);
  const b = await f.engine.video.start(S, "part-explicit", { ...f.input, canonical_url: f.input.canonical_url + "?p=1", part_id: "1" });
  assert.equal(a.video_job_id, b.video_job_id);
  assert.equal(a.part_id, "1");
  await assert.rejects(f.engine.video.start(S, "over-daily-limit", { ...f.input, native_id: "BV2fixture", canonical_url: "https://www.bilibili.com/video/BV2fixture" }), (e: any) => e.reason === "RESOURCE_QUOTA_EXCEEDED");
});

test("IF017 schedule enabled CAS stays scoped and does not change cadence", async t => {
  const f = await setup(t);
  const schedule = await f.engine.createSchedule(S, "user:reviewer", "policy_v1", { source_ids: [f.source.id], interval_seconds: 300 });
  const paused = await f.engine.setScheduleEnabled(S, schedule.id, { expected_revision: 1, enabled: false });
  assert.equal(paused.enabled, false); assert.equal(paused.interval_seconds, 300); assert.equal(paused.revision, 2);
  await assert.rejects(f.engine.setScheduleEnabled(S, schedule.id, { expected_revision: 1, enabled: true }), (e: any) => e.status === 409);
  await assert.rejects(f.engine.setScheduleEnabled({ ...S, workspace_id: "foreign" }, schedule.id, { expected_revision: 2, enabled: true }), (e: any) => e.status === 404);
  assert.equal((await f.engine.setScheduleEnabled(S, schedule.id, { expected_revision: 2, enabled: true })).enabled, true);
  assert.equal((await f.engine.listSchedules(S))[0].monitor_id, null);
});

test("COL019 cancel ambiguous submit preserves unknown remote truth and operation cancellation fences jobs", async t => {
  const f = await setup(t);
  f.provider.submit = async () => { throw new Error("response lost after external acceptance"); };
  const a = await f.engine.video.start(S, "unknown-cancel", f.input);
  await f.engine.video.workOnce("worker");
  const result = await f.engine.cancelOperation(S, a.operation_id);
  assert.equal(result.video_jobs_cancelled, 1);
  const current = await f.engine.video.get(S, a.video_job_id);
  assert.equal(current.state, "cancelled"); assert.equal(current.remote_cancel_status, "unknown");
});

test("COL020 unknown/open host child holds parent; settled costs are not double charged", async t => {
  const f = await setup(t); let closed = 0; let open = 1;
  f.engine.budget = { reserve: async () => ({ reservation_id: "parent" }), close: async (_s, id, outcome, amount) => { assert.equal(id, "parent"); assert.equal(amount, 0); assert.equal(outcome, "settle"); closed++; } };
  const a = await f.engine.video.start(S, "cost-hold", f.input);
  await f.db.query(`UPDATE flow_video_jobs SET state='failed',budget_reservation_id='parent' WHERE id=$1`, [a.video_job_id]);
  f.engine.video.budgetStatus = async () => ({ reservation_id: "parent", status: "reserved", consumed_micro: 17, allocated_micro: open ? 20 : 0, remaining_micro: 83, open_children: open, unknown_children: open });
  await f.engine.video.maintain(); assert.equal(closed, 0);
  open = 0; await f.engine.video.maintain(); assert.equal(closed, 1);
  assert.equal(Number((await f.engine.video.job(S, a.video_job_id)).actual_usage_micro), 17);
});

test("COL020 retry of a closed parent reserves only remaining frozen cumulative budget", async t => {
  const f = await setup(t, { budget_micro: 100 }); let reserved = 0;
  const a = await f.engine.video.start(S, "bounded-retry", f.input);
  await f.db.query(`UPDATE flow_video_jobs SET state='failed',budget_reservation_id='old-parent' WHERE id=$1`, [a.video_job_id]);
  f.engine.video.budgetStatus = async () => ({ reservation_id: "old-parent", status: "settled", consumed_micro: 17, allocated_micro: 0, remaining_micro: 83, open_children: 0, unknown_children: 0 });
  f.engine.budget = { reserve: async (_job, key, amount) => { assert.match(key, /:budget:1$/); reserved += amount; return { reservation_id: "new-parent" }; }, close: async () => {} };
  await f.engine.video.retry(S, a.video_job_id);
  await f.engine.video.workOnce("after-retry");
  assert.equal(reserved, 83);
  const job = await f.engine.video.job(S, a.video_job_id);
  assert.equal(job.budget_reservation_id, "new-parent"); assert.equal(Number(job.budget_consumed_prior_micro), 17);
});

test("COL019 retry cannot resurrect cancellation or mutate its budget after an in-flight check", async t => {
  for (const boundary of ["budget", "provider"] as const) await t.test(boundary, async t => {
    const f = await setup(t, { budget_micro: 100 });
    const started = await f.engine.video.start(S, `cancel-during-${boundary}`, f.input);
    await f.engine.video.workOnce("original-worker");
    await f.db.query(`UPDATE flow_video_jobs SET state='failed',budget_reservation_id='old-parent' WHERE id=$1`, [started.video_job_id]);
    await f.db.query(`UPDATE flow_video_stages SET state='failed',lease_owner=NULL,lease_expires_at=NULL WHERE video_job_id=$1`, [started.video_job_id]);
    let reached!: () => void, resume!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    f.engine.video.budgetStatus = async () => {
      if (boundary === "budget") { reached(); await gate; }
      return { reservation_id: "old-parent", status: "settled", consumed_micro: 17, allocated_micro: 0, remaining_micro: 83, open_children: 0, unknown_children: 0 };
    };
    f.provider.retry = async () => ({ task_id: "external_fixture", state: "pending" });
    f.provider.poll = async () => { if (boundary === "provider") { reached(); await gate; } return { task_id: "external_fixture", state: "failed" }; };
    const retry = f.engine.video.retry(S, started.video_job_id);
    const rejected = assert.rejects(retry, (error: any) => error.reason === "RETRY_STATE_CHANGED");
    await waiting;
    await f.engine.video.cancel(S, started.video_job_id, "cancel wins before retry commit");
    resume(); await rejected;
    const current = await f.engine.video.job(S, started.video_job_id);
    assert.equal(current.state, "cancelled"); assert.equal(current.budget_reservation_id, "old-parent");
    assert.equal(Number(current.budget_generation), 0); assert.equal(Number(current.budget_consumed_prior_micro), 0);
    assert.equal((await f.db.query(`SELECT state FROM flow_video_stages WHERE video_job_id=$1`, [started.video_job_id])).rows[0].state, "cancelled");
    assert.notEqual((await f.db.query(`SELECT state FROM flow_video_submission_intents WHERE video_job_id=$1`, [started.video_job_id])).rows[0].state, "resume_requested");
    assert.equal(await f.engine.video.claim("must-not-restart"), null);
  });
});

test("COL029 intermediate inventory requires verified delete receipts before execution erase", async t => {
  const f = await setup(t); let confirmed = false, erasures = 0;
  const a = await f.engine.video.start(S, "cleanup", f.input), job = await f.engine.video.job(S, a.video_job_id);
  const raw = Buffer.from(JSON.stringify({ segments: [{ text: "fixture intermediate" }] })), digest = sha(raw);
  const key = `tenants/${S.tenant_id}/workspaces/${S.workspace_id}/video/${job.id}/${digest}/chunk.json`;
  f.objects.set(key, raw);
  await f.engine.video.registerArtifacts(job, [{ object_key: key, sha256: digest, bytes: raw.byteLength, content_type: "application/json" }]);
  f.provider.deleteObject = async (_s, _id, objectKey, hash) => { assert.equal(objectKey, key); return { deleted: confirmed, sha256: hash }; };
  f.provider.eraseJob = async (_s, id) => { erasures++; return { erased: true, video_job_id: id }; };
  await f.engine.video.cancel(S, job.id, "test cleanup");
  await f.engine.revokeSource(S, f.source.id);
  await f.engine.video.maintain();
  assert.equal((await f.engine.video.job(S, job.id)).cleanup_error.code, "DELETE_UNCONFIRMED");
  assert.equal(erasures, 0);
  assert.equal((await f.db.query(`SELECT state FROM flow_video_objects WHERE object_key=$1`, [key])).rows[0].state, "delete_pending");
  confirmed = true; f.advance(61000); await f.engine.video.maintain();
  assert.equal(erasures, 1);
  assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM flow_video_cleanup_receipts`)).rows[0].n, 1);
  assert.ok((await f.engine.video.job(S, job.id)).execution_erased_at);
});

test("COL013 lost external response never resubmits; reconcile-by-key recovers confirmed task", async t => {
  const f = await setup(t); let submits = 0, polls = 0;
  f.provider.submit = async () => { submits++; throw new Error("response lost after accepted"); };
  f.provider.reconcile = async () => ({ task_id: "confirmed_external", state: "pending" });
  f.provider.poll = async (_j, _s, id) => { assert.equal(id, "confirmed_external"); polls++; return { task_id: id, state: "pending" }; };
  const receipt = await f.engine.video.start(S, "lost-start", f.input);
  await f.engine.video.workOnce("worker-one");
  assert.equal((await f.engine.video.get(S, receipt.video_job_id)).state, "reconciliation_required");
  assert.equal(await f.engine.video.workOnce("worker-two"), null);
  await f.engine.video.reconcile(S, { idempotency_key: "lost-start" });
  await f.engine.video.workOnce("worker-two");
  f.advance(6000); await f.engine.video.workOnce("worker-two");
  assert.equal(submits, 1); assert.equal(polls, 2);
  const cancelled = await f.engine.video.cancel(S, receipt.video_job_id, "fixture cancel");
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.remote_cancel_status, "unsupported");
  assert.equal(await f.engine.video.workOnce("late"), null);
});

test("COL018 explicit auth rejection blocks without ambiguous submission intent", async t => {
  const f = await setup(t);
  f.provider.submit = async () => { throw Object.assign(new Error("denied"), { status: 403, reason: "AUTH_REQUIRED" }); };
  const r = await f.engine.video.start(S, "denied", f.input);
  await f.engine.video.workOnce("w");
  assert.equal((await f.engine.video.get(S, r.video_job_id)).state, "blocked_auth");
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_submission_intents")).rows[0].n, 0);
});

test("COL024 external stage status reports only persisted submit/poll observations", async t => {
  const f = await setup(t);
  const remoteId = "private-external-task-id-not-for-clients";
  f.provider.instance = "https://private-provider.invalid?token=never-project";
  f.provider.submit = async () => ({ task_id: remoteId, state: "pending" });
  f.provider.poll = async () => ({ task_id: remoteId, state: "failed", error: { code: "PROCESSOR_FAILED" } });
  const receipt = await f.engine.video.start(S, "observed-pending", f.input);
  const summary = (stage: any) => ({ submission_intent_state: stage.submission_intent_state, external_task_known: stage.external_task_known,
    external_observed_state: stage.external_observed_state, external_observed_at: stage.external_observed_at });
  assert.deepEqual(summary((await f.engine.video.get(S, receipt.video_job_id)).stages[0]), {
    submission_intent_state: "none", external_task_known: false, external_observed_state: "unknown", external_observed_at: null,
  });
  await f.engine.video.workOnce("observed-worker");
  const pending = await f.engine.video.get(S, receipt.video_job_id);
  assert.deepEqual(summary(pending.stages[0]), { submission_intent_state: "accepted", external_task_known: true,
    external_observed_state: "pending", external_observed_at: new Date("2026-10-26T00:00:00Z") });
  assert.doesNotMatch(JSON.stringify(pending), /private-external|private-provider|never-project|intent_key|provider_instance|external_task_id/);
  await assert.rejects(f.engine.video.get({ ...S, workspace_id: "foreign" }, receipt.video_job_id), (e: any) => e.status === 404);
  f.advance(6000); await f.engine.video.workOnce("observed-worker");
  const failed = await f.engine.video.get(S, receipt.video_job_id);
  assert.deepEqual(summary(failed.stages[0]), { submission_intent_state: "terminal", external_task_known: true,
    external_observed_state: "failed", external_observed_at: new Date("2026-10-26T00:00:06Z") });
  // Older deployments had no external observations. A terminal intent is not proof of a particular outcome.
  await f.db.query(`UPDATE flow_video_submission_intents SET external_observed_state=NULL,external_observed_at=NULL WHERE video_job_id=$1`, [receipt.video_job_id]);
  assert.deepEqual(summary((await f.engine.video.get(S, receipt.video_job_id)).stages[0]), {
    submission_intent_state: "terminal", external_task_known: true, external_observed_state: "unknown", external_observed_at: null,
  });
});

test("COL024 lost submit stays unknown until actual reconciliation; cancel is not external completion", async t => {
  const f = await setup(t); let submits = 0; let found = false;
  f.provider.submit = async () => { submits++; throw new Error("lost reply after possible external acceptance"); };
  f.provider.reconcile = async () => found ? { task_id: "private-reconciled-id", state: "pending" } : null;
  const receipt = await f.engine.video.start(S, "observed-lost", f.input);
  await f.engine.video.workOnce("lost-worker");
  let status = await f.engine.video.get(S, receipt.video_job_id);
  assert.equal(status.state, "reconciliation_required");
  assert.equal(status.stages[0].submission_intent_state, "submitted");
  assert.equal(status.stages[0].external_task_known, false);
  assert.equal(status.stages[0].external_observed_state, "unknown");
  assert.equal(status.stages[0].external_observed_at, null);
  status = await f.engine.video.reconcile(S, { idempotency_key: "observed-lost" }) as typeof status;
  assert.equal(status.stages[0].external_observed_state, "unknown");
  assert.equal(status.stages[0].external_observed_at, null);
  found = true; f.advance(1000);
  status = await f.engine.video.reconcile(S, { idempotency_key: "observed-lost" }) as typeof status;
  assert.equal(status.stages[0].submission_intent_state, "accepted");
  assert.equal(status.stages[0].external_task_known, true);
  assert.equal(status.stages[0].external_observed_state, "pending");
  assert.equal(status.stages[0].external_observed_at.toISOString(), "2026-10-26T00:00:01.000Z");
  f.advance(1000); status = await f.engine.video.cancel(S, receipt.video_job_id, "stop locally");
  assert.equal(status.state, "cancelled"); assert.equal(status.remote_cancel_status, "unsupported");
  assert.equal(status.stages[0].external_observed_state, "pending");
  assert.equal(status.stages[0].external_observed_at.toISOString(), "2026-10-26T00:00:01.000Z");
  assert.equal(submits, 1);
  assert.doesNotMatch(JSON.stringify(status), /private-reconciled-id/);
});

test("COL024 stale poll cannot overwrite a newer lease generation's external observation", async t => {
  const f = await setup(t);
  const receipt = await f.engine.video.start(S, "observed-stale", f.input);
  await f.engine.video.workOnce("old-owner");
  let started!: () => void; const polling = new Promise<void>(resolve => { started = resolve; });
  let finish!: (result: any) => void;
  f.provider.poll = async () => { started(); return new Promise(resolve => { finish = resolve; }); };
  f.advance(6000); const late = f.engine.video.workOnce("old-owner");
  await polling;
  f.advance(91000); const current = await f.engine.video.claim("new-owner");
  assert.ok(current); assert.equal(current.video_job_id, receipt.video_job_id);
  assert.equal(Number(current.attempt), 2);
  finish({ task_id: "external_fixture", state: "failed", error: { code: "PROCESSOR_FAILED" } });
  assert.deepEqual(await late, { state: "stale" });
  const stage = (await f.engine.video.get(S, receipt.video_job_id)).stages[0];
  assert.equal(Number(stage.attempt), 2);
  assert.equal(stage.external_observed_state, "pending");
  assert.equal(stage.external_observed_at.toISOString(), "2026-10-26T00:00:00.000Z");
});

test("COL018 provider circuit persists failures and blocks new submits until bounded recovery", async t => {
  const f = await setup(t, { max_daily_download_bytes: 100_000_000_000, max_daily_media_ms: 360_000_000 }); let submissions = 0;
  f.provider.submit = async () => { submissions++; throw new Error("connection lost after unconfirmed acceptance"); };
  for (let i = 0; i < 5; i++) {
    await f.engine.video.start(S, `circuit-${i}`, { ...f.input, native_id: `BVfixture${i}`, canonical_url: `https://www.bilibili.com/video/BVfixture${i}` });
    await f.engine.video.workOnce("circuit-worker");
  }
  assert.equal(submissions, 5);
  const queued = await f.engine.video.start(S, "circuit-next", { ...f.input, native_id: "BVfixture6", canonical_url: "https://www.bilibili.com/video/BVfixture6" });
  await f.engine.video.workOnce("circuit-worker");
  assert.equal(submissions, 5); assert.equal((await f.engine.video.get(S, queued.video_job_id)).error.code, "PROVIDER_CIRCUIT_OPEN");
  f.advance(120000);
  f.provider.submit = async () => { submissions++; return { task_id: "recovered-task", state: "pending" }; };
  await f.engine.video.workOnce("circuit-worker");
  assert.equal(submissions, 6);
  const health = (await f.db.query(`SELECT * FROM flow_video_provider_health`)).rows[0];
  assert.equal(health.consecutive_failures, 0); assert.equal(health.blocked_until, null);
});

test("COL009/010 preview discovery is isolated; scheduled pages persist tasks before watermark", async t => {
  const f = await setup(t); let page = 0;
  f.provider.discover = async (_source, cursor) => {
    page++;
    return { items: [{ ...f.input, title: "synthetic page", published_at: "2026-10-25T00:00:00Z" }], next_cursor: cursor ? null : "page-two", complete: !!cursor, watermark: "newest", mode: "fixture" };
  };
  const preview = await f.engine.video.discover(S, "preview", { source_id: f.source.id });
  await f.engine.workOnce("preview");
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 0);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_discovery_checkpoints")).rows[0].n, 0);
  assert.equal((await f.engine.video.discoveryResult(S, preview.operation_id)).items.length, 1);
  await f.engine.createSchedule(S, "user:reviewer", "policy_v1", { source_ids: [f.source.id], interval_seconds: 60 });
  await f.engine.schedulerTick(); await f.engine.workOnce("scheduled-one");
  let cp = (await f.db.query("SELECT * FROM flow_video_discovery_checkpoints")).rows[0];
  assert.equal(cp.partial, true); assert.equal(cp.stable_watermark, null); assert.equal(cp.checkpoint, "page-two");
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 1);
  f.advance(60000); await f.engine.schedulerTick(); await f.engine.workOnce("scheduled-two");
  cp = (await f.db.query("SELECT * FROM flow_video_discovery_checkpoints")).rows[0];
  assert.equal(cp.partial, false); assert.equal(cp.stable_watermark, "newest"); assert.equal(cp.checkpoint, null);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 1);
  assert.equal(page, 3);
  assert.equal((await f.db.query("SELECT grant_actor FROM flow_video_jobs")).rows[0].grant_actor, "user:reviewer");
});

test("cron window duration uses previous actual timezone occurrence across DST", () => {
  const at = new Date("2026-03-08T13:00:00Z"); // 09:00 New York after spring forward.
  assert.equal(previousCron("0 9 * * *", "America/New_York", at).toISOString(), "2026-03-07T14:00:00.000Z");
  assert.equal((at.getTime() - previousCron("0 9 * * *", "America/New_York", at).getTime()) / 1000, 23 * 3600);
});

test("COL030 bounded historical recheck verifies bytes and reuses only exact current ready evidence", async t => {
  const f = await setup(t, { reconcile_after_seconds: 3600, max_reconcile_items: 1 });
  const identity = sha("synthetic pinned processor and model digest");
  const inputFor = async (version: string, text: string) => {
    const receipt = await f.engine.video.start(S, version, { ...f.input, content_version: version });
    const stage = await f.engine.video.claim("input"); assert.ok(stage);
    const raw = Buffer.from(JSON.stringify({ segments: [{ text, start_ms: 0, end_ms: 1000 }] })), digest = sha(raw);
    const object = { object_key: `tenants/${S.tenant_id}/workspaces/${S.workspace_id}/video/${receipt.video_job_id}/${digest}/input.json`, sha256: digest, bytes: raw.length, content_type: "application/json" };
    f.objects.set(object.object_key, raw);
    const manifest: VideoManifest = { schema_version: 1, artifact_stage: "input_ready", video_job_id: receipt.video_job_id, stage_attempt: stage.attempt, fencing_token: Number(stage.fencing_token), input_kind: "platform_subtitles", input_hash: digest, media_sha256: null,
      availability: "not_acquired", objects: [object], coverage: { required: [], completed: [], missing: [] }, processors: { version: "synthetic-input", processing_identity: identity } };
    return { receipt, stage, manifest, object };
  };
  const first = await inputFor("first", "Historical source text");
  const accepted = await f.engine.video.importManifest(S, first.receipt.video_job_id, first.manifest, first.stage);
  const process = await f.engine.video.claim("process"); assert.ok(process);
  const complete: VideoManifest = { ...first.manifest, artifact_stage: "processing_complete", stage_attempt: process.attempt, fencing_token: Number(process.fencing_token), parent_manifest_sha256: accepted.manifest_sha256,
    transcript: { parts: [{ object_key: first.object.object_key, sha256: first.object.sha256, segment_count: 1, start_ms: 0, end_ms: 1000 }] }, coverage: { required: ["transcript"], completed: ["transcript"], missing: [], duration_ms: 1000 } };
  const ready = await f.engine.video.importManifest(S, first.receipt.video_job_id, complete, process);
  const same = await inputFor("unchanged-recheck", "Historical source text");
  const reused = await f.engine.video.importManifest(S, same.receipt.video_job_id, same.manifest, same.stage);
  assert.equal(reused.reused_from_job_id, first.receipt.video_job_id); assert.equal(reused.revision, ready.revision);
  assert.equal((await f.engine.video.artifacts(S, same.receipt.video_job_id)).items[0].quote, "Historical source text");
  assert.equal(await f.engine.video.claim("must-not-call-asr"), null);
  const changed = await inputFor("changed-recheck", "Changed source bytes");
  await f.engine.video.importManifest(S, changed.receipt.video_job_id, changed.manifest, changed.stage);
  assert.equal((await f.engine.video.get(S, changed.receipt.video_job_id)).stage, "process");
  await f.engine.video.cancel(S, changed.receipt.video_job_id, "leave old evidence intact");
  assert.equal((await f.engine.getRevision(S, ready.document_id, ready.revision)).body, "Historical source text");
  f.advance(3601000);
  await f.engine.createSchedule(S, "user:reviewer", "policy_v1", { source_ids: [f.source.id], interval_seconds: 60 });
  await f.engine.schedulerTick(); await f.engine.workOnce("historical-scan");
  const rechecks = (await f.db.query(`SELECT * FROM flow_video_jobs WHERE input->>'content_version' LIKE 'recheck:%'`)).rows;
  assert.equal(rechecks.length, 1); assert.equal(rechecks[0].input.native_id, f.input.native_id);
  assert.equal(rechecks[0].input.reacquire, true);
  assert.ok((await f.db.query(`SELECT input_checked_at,last_reconcile_at FROM flow_video_assets`)).rows[0].last_reconcile_at);
});

test("K006 lawful scoped input waits for exact streamed bytes and cannot import arbitrary object keys", async t => {
  const f = await setup(t); const bytes = Buffer.from(JSON.stringify({ segments: [{ text: "Lawful uploaded subtitle", start_ms: 0, end_ms: 1000 }] }));
  const descriptor = { input_kind: "platform_subtitles", sha256: sha(bytes), bytes: bytes.length, content_type: "application/json" };
  let uploads = 0;
  f.provider.uploadInput = async (job, expected, body) => {
    uploads++; const parts: Uint8Array[] = []; for await (const part of body) parts.push(part);
    const actual = Buffer.concat(parts); assert.equal(sha(actual), expected.sha256);
    const ref = { object_key: `tenants/${S.tenant_id}/workspaces/${S.workspace_id}/video/${job.id}/${expected.sha256}/input.json`, sha256: expected.sha256, bytes: actual.length, content_type: expected.content_type };
    f.objects.set(ref.object_key, actual); return ref;
  };
  const receipt = await f.engine.video.start(S, "lawful-input", { ...f.input, lawful_input: descriptor });
  assert.equal(receipt.stage, "awaiting_input"); assert.equal(await f.engine.video.claim("no-download"), null);
  async function* stream(data = bytes) { yield data.subarray(0, 10); yield data.subarray(10); }
  await assert.rejects(f.engine.video.uploadInput({ ...S, actor: { type: "user", id: "other" } }, receipt.video_job_id, stream(), bytes.length, "application/json"), (e: any) => e.reason === "INPUT_GRANT_MISMATCH");
  await assert.rejects(f.engine.video.uploadInput(S, receipt.video_job_id, stream(), bytes.length + 1, "application/json"), (e: any) => e.reason === "INPUT_DESCRIPTOR_MISMATCH");
  await assert.rejects(f.engine.video.start(S, "arbitrary-key", { ...f.input, input_object: { object_key: "foreign/private" } }), (e: any) => e.reason === "INPUT_REFERENCE_NOT_ALLOWED");
  const accepted = await f.engine.video.uploadInput(S, receipt.video_job_id, stream(), bytes.length, "application/json");
  assert.equal(accepted.input_received, true); assert.equal(accepted.stage, "input");
  await f.engine.video.uploadInput(S, receipt.video_job_id, stream(), bytes.length, "application/json"); assert.equal(uploads, 1);
  const job = await f.engine.video.job(S, receipt.video_job_id); assert.equal(job.input.input_kind, "platform_subtitles"); assert.equal(job.input.input_object.sha256, descriptor.sha256);
  assert.ok(await f.engine.video.claim("input-receipt-ready"));
});

test("COL020 daily byte/time reservations are atomic, replay-safe, and unknown holds are not zero", async t => {
  const f = await setup(t, { max_video_bytes: 1000, max_duration_ms: 1000, max_daily_download_bytes: 2000, max_daily_media_ms: 2000 });
  const jobs = [];
  for (let i = 0; i < 3; i++) {
    const receipt = await f.engine.video.start(S, `resource-${i}`, { ...f.input, content_version: `resource-${i}` });
    jobs.push(await f.engine.video.job(S, receipt.video_job_id));
  }
  await admitVideoResources(f.engine, jobs[0], f.profile); await admitVideoResources(f.engine, jobs[0], f.profile);
  await admitVideoResources(f.engine, jobs[1], f.profile);
  await assert.rejects(admitVideoResources(f.engine, jobs[2], f.profile), (e: any) => e.reason === "DAILY_RESOURCE_LIMIT");
  assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM flow_video_resource_admissions WHERE state='held'`)).rows[0].n, 2);
  const proof = { input_kind: "platform_subtitles", input_hash: sha("synthetic verified receipt"), objects: [{ sha256: sha("synthetic verified receipt"), bytes: 100 }], coverage: {} } as VideoManifest;
  for (const job of jobs.slice(0, 2)) await f.db.tx(q => settleVideoResources(q, job, proof, f.engine.now()));
  await admitVideoResources(f.engine, jobs[2], f.profile);
  assert.equal(Number((await f.db.query(`SELECT sum(actual_bytes) AS n FROM flow_video_resource_admissions WHERE state='settled'`)).rows[0].n), 200);
});

test("COL020 provider/source admission does not let one busy source starve another", async t => {
  const f = await setup(t);
  const previous = process.env.FLOW_VIDEO_PROVIDER_CONCURRENCY; process.env.FLOW_VIDEO_PROVIDER_CONCURRENCY = "2";
  t.after(() => { if (previous === undefined) delete process.env.FLOW_VIDEO_PROVIDER_CONCURRENCY; else process.env.FLOW_VIDEO_PROVIDER_CONCURRENCY = previous; });
  const other = await f.engine.createSource(S, { kind: "bilibili", url: "https://space.bilibili.com/98765", title: "other synthetic account", config: { source_type: "account", author_id: "98765", profile_id: f.profile.id, profile_version: 1, usage_basis: "fixture", allowed_uses: ["knowledge"] } });
  await f.engine.video.start(S, "source-a1", f.input);
  f.advance(1);
  await f.engine.video.start(S, "source-a2", { ...f.input, content_version: "other" });
  f.advance(1);
  await f.engine.video.start(S, "source-b1", { ...f.input, source_id: other.id, native_id: "BVother", canonical_url: "https://www.bilibili.com/video/BVother" });
  const third = await f.engine.createSource(S, { kind: "bilibili", url: "https://space.bilibili.com/11111", title: "third synthetic account", config: { source_type: "account", author_id: "11111", profile_id: f.profile.id, profile_version: 1, usage_basis: "fixture", allowed_uses: ["knowledge"] } });
  f.advance(1);
  await f.engine.video.start(S, "source-c1", { ...f.input, source_id: third.id, native_id: "BVthird", canonical_url: "https://www.bilibili.com/video/BVthird" });
  const a = await f.engine.video.claim("replica-a"), b = await f.engine.video.claim("replica-b"); assert.ok(a); assert.ok(b);
  const ja = await f.engine.video.job(S, a.video_job_id), jb = await f.engine.video.job(S, b.video_job_id);
  assert.equal(ja.source_id, f.source.id); assert.equal(jb.source_id, other.id); assert.equal(await f.engine.video.claim("replica-c"), null);
});

test("G15 expired same-owner reclaim obeys provider, source and workspace caps", async t => {
  for (const scenario of [
    { name: "provider", provider: "1", source: "8", occupants: 1 },
    { name: "source", provider: "8", source: "1", occupants: 1 },
    { name: "workspace", provider: "8", source: "8", occupants: 4 },
  ]) await t.test(scenario.name, async sub => {
    const f = await setup(sub);
    const priorProvider = process.env.FLOW_VIDEO_PROVIDER_CONCURRENCY, priorSource = process.env.FLOW_VIDEO_SOURCE_CONCURRENCY;
    process.env.FLOW_VIDEO_PROVIDER_CONCURRENCY = scenario.provider; process.env.FLOW_VIDEO_SOURCE_CONCURRENCY = scenario.source;
    sub.after(() => {
      if (priorProvider === undefined) delete process.env.FLOW_VIDEO_PROVIDER_CONCURRENCY; else process.env.FLOW_VIDEO_PROVIDER_CONCURRENCY = priorProvider;
      if (priorSource === undefined) delete process.env.FLOW_VIDEO_SOURCE_CONCURRENCY; else process.env.FLOW_VIDEO_SOURCE_CONCURRENCY = priorSource;
    });
    const initial = await f.engine.video.start(S, "expired-owner", f.input);
    const old = await f.engine.video.claim("owner-a", 1000); assert.ok(old);
    // Make other due work win ordering while the old stage still retains its owner.
    await f.db.query(`UPDATE flow_video_stages SET next_poll_at=$2 WHERE video_job_id=$1`, [initial.video_job_id, new Date(f.engine.now().getTime() + 3600000).toISOString()]);
    f.advance(1001);
    const occupied: any[] = [];
    for (let i = 0; i < scenario.occupants; i++) {
      await f.engine.video.start(S, `occupant-${i}`, { ...f.input, content_version: `occupant-${i}` });
      const stage = await f.engine.video.claim(`owner-${i + 1}`, 90000); assert.ok(stage); assert.notEqual(stage.video_job_id, initial.video_job_id); occupied.push(stage);
    }
    assert.equal(await f.engine.video.claim("owner-a"), null, `${scenario.name} cap must include expired same-owner reacquisition`);
    const unchanged = (await f.db.query(`SELECT attempt,fencing_token FROM flow_video_stages WHERE video_job_id=$1`, [initial.video_job_id])).rows[0];
    assert.equal(unchanged.attempt, old.attempt); assert.equal(Number(unchanged.fencing_token), Number(old.fencing_token));
    const continued = await f.engine.video.claim("owner-1"); assert.ok(continued);
    assert.equal(continued.video_job_id, occupied[0].video_job_id); assert.equal(continued.attempt, occupied[0].attempt); assert.equal(Number(continued.fencing_token), Number(occupied[0].fencing_token));
    // Only release an operational test lease; this does not fabricate source readiness.
    await f.db.query(`UPDATE flow_video_stages SET state='completed',lease_owner=NULL,lease_expires_at=NULL WHERE video_job_id=$1`, [occupied[0].video_job_id]);
    const reclaimed = await f.engine.video.claim("owner-a"); assert.ok(reclaimed);
    assert.equal(reclaimed.video_job_id, initial.video_job_id); assert.equal(reclaimed.attempt, old.attempt + 1); assert.equal(Number(reclaimed.fencing_token), Number(old.fencing_token) + 1);
    await assert.rejects(f.engine.video.heartbeat(old), (error: any) => error.reason === "STALE_FENCE");
  });
});

test("K013 visual metadata rejects inference relabeling, forged frames and fabricated alignment", () => {
  const key = "scoped-frame", media = sha("synthetic-media"), frameHash = sha("synthetic-frame");
  const record = { type: "model_inference", text: "Synthetic model claim, not source truth", derived: true, frame_ids: ["f1"], frame_refs: [key], start_ms: 100, end_ms: 100, media_sha256: media, review_status: "unreviewed", provenance: { model_tasks: [{ task_id: "fixture-model", usage_ref: "model_task:fixture-model", model_config_hash: "f".repeat(64) }] } };
  const encode = (value: any) => Buffer.from(JSON.stringify({ records: [{ ...value, record_id: canonicalHash(value) }] }));
  const manifest = { frames: [{ frame_id: "f1", object_key: key, sha256: frameHash, timestamp_ms: 100, media_sha256: media }], media_sha256: media, coverage: { duration_ms: 1000 } } as VideoManifest;
  const part = (bytes: Uint8Array) => ({ object_key: "fixture-part", sha256: sha(bytes), bytes: bytes.length, content_type: "application/json", record_count: 1, start_ms: 100, end_ms: 100 });
  const valid = encode(record); assert.equal(validateVisualPart(manifest, part(valid), valid)[0].derived, true);
  for (const change of [{ ...record, derived: false }, { ...record, frame_refs: ["foreign"] }, { ...record, type: "alignment", relation: "semantic_agreement", semantic_relation: "verified", audio_segments: [] }]) {
    const invalid = encode(change); assert.throws(() => validateVisualPart(manifest, part(invalid), invalid));
  }
});

test("COL002 shared text extracts exactly one platform HTTPS URL without persisting or fetching arbitrary text", () => {
  assert.equal(normalizeVideoURL("bilibili", "分享视频：https://www.bilibili.com/video/BVfixture?p=2 复制打开"), "https://www.bilibili.com/video/BVfixture?p=2");
  assert.equal(normalizeVideoURL("douyin", "看看 https://v.douyin.com/ABC123/ 。"), "https://v.douyin.com/ABC123/");
  for (const value of ["https://b23.tv/a https://b23.tv/b", "http://b23.tv/a", "https://127.0.0.1/private", "https://user:secret@b23.tv/a", "x".repeat(4097)]) assert.throws(() => normalizeVideoURL("bilibili", value));
});

test("K015 narrow numeric conflict candidates preserve actual audio/OCR sides and never assert truth", () => {
  const audio = { text: "速度: 50 km/h", start_ms: 0, end_ms: 200, kind: "asr" as const };
  const ocr = { text: "速度: 30 km/h", start_ms: 100, end_ms: 100, kind: "ocr" as const, frame_ref: "frame-key" };
  const candidate = { relation: "numeric_disagreement_candidate", review_status: "unreviewed", truth_status: "not_asserted", label: "速度", unit: "km/h", audio_value: "50", visual_value: "30",
    audio: { text: audio.text, start_ms: 0, end_ms: 200, text_sha256: sha(audio.text) }, visual: { text: ocr.text, start_ms: 100, end_ms: 100, frame_ref: "frame-key", text_sha256: sha(ocr.text) } };
  const manifest = { media_sha256: sha("media"), frames: [{ frame_id: "frame", object_key: "frame-key", sha256: sha("frame"), timestamp_ms: 100, media_sha256: sha("media") }], coverage: { duration_ms: 1000 } } as VideoManifest;
  const validate = (c: any) => {
    const record = { type: "alignment", frame_id: "frame", frame_ref: "frame-key", start_ms: 100, end_ms: 100, relation: "temporal_overlap", semantic_relation: "not_assessed", audio_segments: [{ start_ms: 0, end_ms: 200, text_sha256: sha(audio.text) }], conflict_candidates: [c] };
    const raw = Buffer.from(JSON.stringify({ records: [{ ...record, record_id: canonicalHash(record) }] }));
    return validateVisualPart(manifest, { object_key: "visual-part", sha256: sha(raw), bytes: raw.length, content_type: "application/json", record_count: 1, start_ms: 100, end_ms: 100 }, raw, [audio, ocr]);
  };
  assert.equal(validate(candidate)[0].conflict_candidates[0].truth_status, "not_asserted");
  for (const change of [{ ...candidate, truth_status: "audio_is_true" }, { ...candidate, label: "other" }, { ...candidate, audio_value: "500" }, { ...candidate, visual: { ...candidate.visual, text_sha256: sha("forged") } }]) assert.throws(() => validate(change));
});

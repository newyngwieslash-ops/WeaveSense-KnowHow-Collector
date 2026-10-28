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

test("COL020 stale maintenance receipt cannot overwrite or settle a replacement budget generation", async t => {
  const f = await setup(t, { budget_micro: 100 });
  const a = await f.engine.video.start(S, "stale-maintenance", f.input);
  await f.db.query(`UPDATE flow_video_jobs SET state='failed',budget_reservation_id='old-parent' WHERE id=$1`, [a.video_job_id]);
  let reached!: () => void, release!: () => void, calls = 0; const waiting = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { release = r; });
  f.engine.video.budgetStatus = async () => {
    if (++calls === 1) { reached(); await gate; }
    return { reservation_id: "old-parent", status: "settled", consumed_micro: 17, allocated_micro: 0, remaining_micro: 83, open_children: 0, unknown_children: 0 };
  };
  const closed: string[] = [];
  f.engine.budget = { reserve: async () => ({ reservation_id: "new-parent" }), close: async (_s, id) => { closed.push(id); } };
  const maintenance = f.engine.video.maintain(); await waiting;
  await f.engine.video.retry(S, a.video_job_id); await f.engine.video.workOnce("new-generation");
  await f.db.query(`UPDATE flow_video_jobs SET actual_usage_micro=23 WHERE id=$1`, [a.video_job_id]);
  release(); await maintenance;
  const current = await f.engine.video.job(S, a.video_job_id);
  assert.equal(current.state, "running"); assert.equal(current.budget_reservation_id, "new-parent");
  assert.equal(Number(current.budget_generation), 1); assert.equal(current.budget_closed_at, null); assert.equal(current.budget_closing_at, null);
  assert.equal(Number(current.actual_usage_micro), 23); assert.deepEqual(closed, []);
});

test("COL020 persisted close intent fences retry and survives an unknown close response", async t => {
  const f = await setup(t, { budget_micro: 100 });
  const a = await f.engine.video.start(S, "closing-parent", f.input);
  await f.db.query(`UPDATE flow_video_jobs SET state='failed',budget_reservation_id='old-parent' WHERE id=$1`, [a.video_job_id]);
  let reached!: () => void, release!: () => void, closeCalls = 0, settled = false;
  const waiting = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { release = r; });
  f.engine.video.budgetStatus = async () => ({ reservation_id: "old-parent", status: settled ? "settled" : "reserved", consumed_micro: 17, allocated_micro: 0, remaining_micro: 83, open_children: 0, unknown_children: 0 });
  f.engine.budget = { reserve: async () => ({ reservation_id: "new-parent" }), close: async (_s, id, _outcome, amount) => {
    assert.equal(id, "old-parent"); assert.equal(amount, 0);
    if (++closeCalls === 1) { reached(); await gate; settled = true; throw new Error("host closed parent but response lost"); }
  } };
  const maintenance = f.engine.video.maintain(); await waiting;
  await assert.rejects(f.engine.video.retry(S, a.video_job_id), (e: any) => e.reason === "BUDGET_RECONCILIATION_REQUIRED");
  release(); await maintenance;
  let current = await f.engine.video.job(S, a.video_job_id);
  assert.ok(current.budget_closing_at); assert.equal(current.budget_closed_at, null);
  await assert.rejects(f.engine.video.retry(S, a.video_job_id), (e: any) => e.reason === "BUDGET_RECONCILIATION_REQUIRED");
  await f.engine.video.maintain(); assert.equal(closeCalls, 2);
  current = await f.engine.video.job(S, a.video_job_id); assert.equal(current.budget_closing_at, null); assert.ok(current.budget_closed_at);
  await f.engine.video.retry(S, a.video_job_id); await f.engine.video.workOnce("after-confirmed-close");
  current = await f.engine.video.job(S, a.video_job_id);
  assert.equal(current.budget_reservation_id, "new-parent"); assert.equal(Number(current.budget_generation), 1); assert.equal(Number(current.budget_consumed_prior_micro), 17); assert.equal(current.budget_closed_at, null);
});

test("COL020 retry begun before close intent rechecks it after its host budget await", async t => {
  const f = await setup(t, { budget_micro: 100 });
  const a = await f.engine.video.start(S, "retry-before-closing", f.input);
  await f.db.query(`UPDATE flow_video_jobs SET state='failed',budget_reservation_id='parent' WHERE id=$1`, [a.video_job_id]);
  let reached!: () => void, release!: () => void, statusCalls = 0;
  const waiting = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { release = r; });
  f.engine.video.budgetStatus = async () => {
    if (++statusCalls === 1) { reached(); await gate; }
    return { reservation_id: "parent", status: "reserved", consumed_micro: 0, allocated_micro: 0, remaining_micro: 100, open_children: 0, unknown_children: 0 };
  };
  f.engine.budget = { reserve: async () => ({ reservation_id: "unused" }), close: async () => { throw new Error("unknown close response"); } };
  const retry = f.engine.video.retry(S, a.video_job_id); const rejected = assert.rejects(retry, (e: any) => e.reason === "RETRY_STATE_CHANGED"); await waiting;
  await f.engine.video.maintain(); release(); await rejected;
  const current = await f.engine.video.job(S, a.video_job_id); assert.equal(current.state, "failed"); assert.ok(current.budget_closing_at);
  assert.equal(await f.engine.video.claim("must-not-spend-closing-parent"), null);
});

test("COL020 cancellation during reserve retains the accepted receipt for exact maintenance release", async t => {
  const f = await setup(t, { budget_micro: 100 });
  let reached!: () => void, release!: () => void, submits = 0;
  const waiting = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { release = r; });
  const closes: any[] = [];
  f.engine.budget = { reserve: async () => { reached(); await gate; return { reservation_id: "cancelled-parent" }; }, close: async (_s, id, outcome, amount) => { closes.push({ id, outcome, amount }); } };
  f.engine.video.budgetStatus = async () => ({ reservation_id: "cancelled-parent", status: "reserved", consumed_micro: 0, allocated_micro: 0, remaining_micro: 100, open_children: 0, unknown_children: 0 });
  f.provider.submit = async () => { submits++; return { task_id: "must-not-submit", state: "pending" }; };
  const a = await f.engine.video.start(S, "cancel-reserve", f.input), work = f.engine.video.workOnce("cancelled-owner"); await waiting;
  await f.engine.video.cancel(S, a.video_job_id, "cancel during host reserve"); release();
  assert.deepEqual(await work, { state: "stale" });
  const current = await f.engine.video.job(S, a.video_job_id);
  assert.equal(current.state, "cancelled"); assert.equal(current.budget_reservation_id, "cancelled-parent"); assert.equal(submits, 0);
  await f.engine.video.maintain(); await f.engine.video.maintain();
  assert.deepEqual(closes, [{ id: "cancelled-parent", outcome: "release", amount: 0 }]);
  assert.ok((await f.engine.video.job(S, a.video_job_id)).budget_closed_at);
});

test("COL020 cancellation with lost reserve response reconciles only the durable original key", async t => {
  const f = await setup(t, { budget_micro: 100 });
  let reached!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { release = r; });
  const keys: string[] = [], accepted = new Map<string, string>(), closes: string[] = [];
  f.engine.budget = { reserve: async (_s, key) => {
    keys.push(key); if (!accepted.has(key)) accepted.set(key, "accepted-before-loss");
    if (keys.length === 1) { reached(); await gate; throw new Error("reserve response lost after host acceptance"); }
    return { reservation_id: accepted.get(key)! };
  }, lookup: async (_s, key) => { keys.push(key); return accepted.has(key) ? { reservation_id: accepted.get(key)! } : null; }, close: async (_s, id) => { closes.push(id); } };
  f.engine.video.budgetStatus = async () => ({ reservation_id: "accepted-before-loss", status: "reserved", consumed_micro: 0, allocated_micro: 0, remaining_micro: 100, open_children: 0, unknown_children: 0 });
  const a = await f.engine.video.start(S, "cancel-lost-reserve", f.input), work = f.engine.video.workOnce("lost-response"); await waiting;
  await f.engine.video.cancel(S, a.video_job_id, "cancel before response"); release(); await work;
  let current = await f.engine.video.job(S, a.video_job_id);
  assert.equal(current.budget_reservation_id, null); assert.ok(current.budget_reserving_at);
  const untouched = await f.engine.video.start(S, "cancel-before-any-reserve", { ...f.input, content_version: "never-reserved" });
  await f.engine.video.cancel(S, untouched.video_job_id, "never started");
  await f.engine.video.maintain(); await f.engine.video.maintain();
  current = await f.engine.video.job(S, a.video_job_id);
  assert.equal(current.state, "cancelled"); assert.equal(current.budget_reservation_id, "accepted-before-loss"); assert.equal(current.budget_reserving_at, null); assert.ok(current.budget_closed_at);
  assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1); assert.equal(accepted.size, 1); assert.deepEqual(closes, ["accepted-before-loss"]);
  assert.equal((await f.engine.video.job(S, untouched.video_job_id)).budget_reservation_id, null);
});

test("COL020 a later admission denial never erases an earlier unknown reservation intent", async t => {
  const f = await setup(t, { budget_micro: 100 }); let calls = 0, visible = false; const closed: string[] = [];
  f.engine.budget = {
    reserve: async () => { if (++calls === 1) throw new Error("accepted but response lost"); throw Object.assign(new Error("grant revoked during replay"), { status: 402 }); },
    lookup: async () => visible ? { reservation_id: "accepted-parent" } : null,
    close: async (_s, id) => { closed.push(id); },
  };
  f.engine.video.budgetStatus = async () => ({ reservation_id: "accepted-parent", status: "reserved", consumed_micro: 0, allocated_micro: 0, remaining_micro: 100, open_children: 0, unknown_children: 0 });
  const a = await f.engine.video.start(S, "unknown-then-denied", f.input);
  await f.engine.video.workOnce("first-unknown"); await f.engine.video.retry(S, a.video_job_id); await f.engine.video.workOnce("later-denial");
  let current = await f.engine.video.job(S, a.video_job_id);
  assert.equal(current.state, "failed"); assert.equal(current.error.code, "BUDGET_RESERVATION_UNKNOWN"); assert.ok(current.budget_reserving_at);
  visible = true; await f.engine.video.cancel(S, a.video_job_id, "cancel unknown hold"); await f.engine.video.maintain();
  current = await f.engine.video.job(S, a.video_job_id);
  assert.equal(current.budget_reservation_id, "accepted-parent"); assert.equal(current.budget_reserving_at, null); assert.ok(current.budget_closed_at);
  assert.equal(calls, 2); assert.deepEqual(closed, ["accepted-parent"]);
});

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgliteDb, migrate } from "./db.ts";
import { Engine } from "./engine.ts";
import { HTTPVideoProvider } from "./video-provider.ts";
import { verify } from "./auth.ts";
import { sha } from "./video-contract.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { applyVideoRetention } from "./video-knowledge.ts";

// Two actual HTTP namespaces, actual signed adapter and durable PGlite state.
// Only the external worker responses/media are synthetic; no real platform/account.
const S = { tenant_id: "provider_t", workspace_id: "provider_w", actor: { type: "user", id: "fixture" }, policy_version: "policy_v1" };
const signingKey = "synthetic-provider-signing-key-never-production";
const text = Buffer.from(JSON.stringify({ segments: [{ text: "Self-authored provider rollback fixture", start_ms: 0, end_ms: 1000 }] }));
async function worker(t: TestContext) {
  const calls: { method: string; path: string; job: string | null }[] = [], tasks = new Map<string, any>();
  let mode = "pending", loseSubmit = false, drift = false, onPoll: (() => void) | undefined;
  let reconcileResponse: ((value: any) => Promise<any>) | undefined;
  const object = (id: string) => ({ object_key: `tenants/${S.tenant_id}/workspaces/${S.workspace_id}/video/${id}/${sha(text)}/input.json`, sha256: sha(text), bytes: text.length, content_type: "application/json" });
  const result = (task: any) => ({ task_id: drift ? "different_external_task" : task.id, state: mode === "complete" ? "completed" : mode,
    ...(mode === "failed" ? { error: { code: "PROCESSOR_FAILED" } } : {}),
    ...(mode === "complete" ? { next_artifact_cursor: "receipt-page-1", artifacts: [], manifest: {
      schema_version: 1, artifact_stage: "input_ready", video_job_id: task.video_job_id, stage_attempt: 1, fencing_token: 1,
      input_kind: "platform_subtitles", input_hash: sha(text), media_sha256: null, availability: "not_acquired", objects: [object(task.video_job_id)],
      coverage: { required: [], completed: [], missing: [] }, processors: { version: "synthetic-worker-contract", processing_identity: sha("synthetic-locked-processor") },
    } } : {}) });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture"), chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ method: req.method!, path: url.pathname, job: body.video_job_id ?? url.searchParams.get("video_job_id") });
    if (req.headers.authorization !== "Bearer synthetic-service-token" || !req.headers["x-flow-execution-context"]) { res.writeHead(403).end(); return; }
    const context = verify(signingKey, String(req.headers["x-flow-execution-context"]), "video-knowledge");
    assert.equal(context.tenant_id, S.tenant_id); assert.equal(context.workspace_id, S.workspace_id);
    assert.equal(context.job_id, body.video_job_id ?? url.searchParams.get("video_job_id"));
    const send = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/v1/jobs" && req.method === "POST") {
      const task = { ...body, id: `task_${body.video_job_id}` }; tasks.set(body.video_job_id, task);
      if (loseSubmit) { req.socket.destroy(); return; }
      send(result(task)); return;
    }
    if (url.pathname === "/v1/jobs/inventory") { send({ artifacts: [], next_artifact_cursor: null }); return; }
    if (url.pathname === "/v1/jobs/cleanup") { send({ complete: true, deleted_temporary_ids: [], skipped_active_ids: [] }); return; }
    if (url.pathname === "/v1/objects/delete") { send({ deleted: true, sha256: body.sha256 }); return; }
    if (url.pathname === "/v1/jobs/erase") { send({ erased: true, video_job_id: body.video_job_id }); return; }
    if (url.pathname === "/v1/objects") { res.writeHead(200, { "content-type": "application/json", "content-length": text.length }); res.end(text); return; }
    const task = tasks.get(body.video_job_id ?? url.searchParams.get("video_job_id"));
    if (!task) { res.writeHead(404).end(); return; }
    if (url.pathname === "/v1/jobs/reconcile") { send(reconcileResponse ? await reconcileResponse(result(task)) : result(task)); return; }
    if (url.pathname === `/v1/jobs/${task.id}/cancel`) { mode = "failed"; send({ status: "confirmed" }); return; }
    if (url.pathname === `/v1/jobs/${task.id}/retry`) { mode = "pending"; send(result(task)); return; }
    if (url.pathname === `/v1/jobs/${task.id}/artifacts`) { send({ artifacts: [object(task.video_job_id)], next_artifact_cursor: null }); return; }
    if (url.pathname === `/v1/jobs/${task.id}`) { onPoll?.(); send(result(task)); return; }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
  const provider = new HTTPVideoProvider(`http://127.0.0.1:${(server.address() as any).port}`, "synthetic-service-token", signingKey);
  return { provider, calls, tasks, object, mode: (value: string) => { mode = value; }, drift: (value: boolean) => { drift = value; }, loseSubmit: () => { loseSubmit = true; }, onPoll: (fn: () => void) => { onPoll = fn; }, onReconcile: (fn: (value: any) => Promise<any>) => { reconcileResponse = fn; } };
}
async function setup(t: TestContext) {
  const db = await pgliteDb(); t.after(() => db.close()); await migrate(db);
  let now = new Date("2026-10-28T00:00:00Z");
  const engine = new Engine(db, async () => [], () => now); engine.video.enabled = true;
  const root = await mkdtemp(join(tmpdir(), "video-provider-instance-")); t.after(() => rm(root, { recursive: true, force: true }));
  const journal = { directory: join(root, "journal"), journalId: "synthetic-provider-journal", key: "synthetic-journal-key-never-production-secret" };
  await initializeVideoDeletionJournal(journal); configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event)); await replayVideoRetentionJournal(engine);
  const profile = await engine.video.saveProfile(S, { name: "Synthetic upgrade TEST", config: { required_capabilities: ["transcript"], budget_micro: 100 } });
  const source = await engine.createSource(S, { kind: "bilibili", url: "https://space.bilibili.com/123456", title: "synthetic account",
    config: { source_type: "account", author_id: "123456", profile_id: profile.id, profile_version: 1, usage_basis: "self-authored fixture only", allowed_uses: ["knowledge"] } });
  const a = await worker(t), b = await worker(t); engine.video.provider = a.provider;
  const receipt = await engine.video.start(S, "provider-rollout", { source_id: source.id, native_id: "BV1fixture", canonical_url: "https://www.bilibili.com/video/BV1fixture", content_version: "v1" });
  const id = receipt.video_job_id;
  const intent = async () => (await db.query(`SELECT * FROM flow_video_submission_intents WHERE video_job_id=$1 AND stage='input'`, [id])).rows[0];
  return { db, engine, a, b, id, intent, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
const changed = (e: any) => e.status === 409 && e.reason === "PROVIDER_INSTANCE_CHANGED";

test("COL031 actual HTTP worker replacement cannot adopt an accepted task; rollback resumes the original ID/artifact cursor", async t => {
  const f = await setup(t);
  await assert.rejects(f.engine.video.registerArtifacts(await f.engine.video.job(S, f.id), null as any), (e: any) => e.status === 422 && e.reason === "INVALID_ARTIFACT_OBJECT");
  await f.engine.video.workOnce("owner"); const original = await f.intent();
  assert.equal(original.provider_instance, f.a.provider.instance); assert.ok(original.external_task_id);
  f.engine.video.provider = f.b.provider; f.advance(6000);
  const stopped = await f.engine.video.workOnce("owner");
  assert.equal(stopped.state, "reconciliation_required"); assert.equal(stopped.error.code, "PROVIDER_INSTANCE_CHANGED");
  await assert.rejects(f.engine.video.reconcile(S, { video_job_id: f.id }), changed);
  assert.equal(f.b.calls.length, 0); assert.deepEqual(await f.intent(), original);
  assert.equal((await f.engine.video.job(S, f.id)).completion_level, "pending");
  f.engine.video.provider = f.a.provider; f.a.mode("complete");
  await f.engine.video.reconcile(S, { video_job_id: f.id });
  // Even a configuration swap while the valid response is in flight must not
  // redirect its following artifact cursor/verification/import to the new worker.
  f.a.onPoll(() => { f.engine.video.provider = f.b.provider; });
  const resumed = await f.engine.video.workOnce("owner");
  assert.equal(resumed.completion_level, "input_ready"); assert.equal(resumed.stage, "process");
  assert.equal((await f.intent()).external_task_id, original.external_task_id);
  assert.equal((await f.intent()).provider_instance, original.provider_instance);
  assert.equal(f.a.calls.filter(x => x.method === "POST" && x.path === "/v1/jobs").length, 1);
  assert.ok(f.a.calls.some(x => x.path === `/v1/jobs/${original.external_task_id}/artifacts`));
  assert.equal(f.b.calls.length, 0);
  const objects = (await f.db.query(`SELECT state,sha256 FROM flow_video_objects WHERE video_job_id=$1`, [f.id])).rows;
  assert.deepEqual(objects, [{ state: "accepted", sha256: sha(text) }]);
  const next = await f.engine.video.workOnce("owner");
  assert.equal(next.state, "reconciliation_required"); assert.equal(f.b.calls.length, 0);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM flow_video_submission_intents WHERE video_job_id=$1`, [f.id])).rows[0].n, 1);
  f.engine.video.provider = f.a.provider;
  assert.equal((await f.engine.video.reconcile(S, { video_job_id: f.id })).state, "queued");
  assert.equal(f.a.calls.filter(x => x.method === "POST" && x.path === "/v1/jobs").length, 1);
});

test("COL031 retry and resume-requested dispatch retain the original namespace and budget generation", async t => {
  const f = await setup(t); f.a.mode("failed");
  await f.engine.video.workOnce("owner"); const original = await f.intent();
  const before = await f.engine.video.job(S, f.id);
  f.engine.video.provider = f.b.provider;
  await assert.rejects(f.engine.video.retry(S, f.id), changed);
  assert.equal((await f.engine.video.job(S, f.id)).budget_generation, before.budget_generation);
  assert.deepEqual(await f.intent(), original); assert.equal(f.b.calls.length, 0);
  f.engine.video.provider = f.a.provider; await f.engine.video.retry(S, f.id);
  assert.equal((await f.intent()).state, "resume_requested");
  f.engine.video.provider = f.b.provider; await f.engine.video.workOnce("owner");
  assert.equal((await f.intent()).state, "resume_requested"); assert.equal(f.b.calls.length, 0);
  f.engine.video.provider = f.a.provider;
  await f.engine.video.reconcile(S, { video_job_id: f.id });
  // Reconciliation sees the same failed task; explicit retry resumes that ID.
  const failed = await f.engine.video.workOnce("owner"); assert.equal(failed.state, "failed");
  await f.engine.video.retry(S, f.id); await f.engine.video.workOnce("owner");
  assert.ok(f.a.calls.some(x => x.path === `/v1/jobs/${original.external_task_id}/retry`));
  assert.equal(f.a.calls.filter(x => x.path === "/v1/jobs").length, 1);
  assert.equal((await f.intent()).external_task_id, original.external_task_id); assert.equal(f.b.calls.length, 0);
});

test("COL031 ambiguous submission and cancellation retain unknown remote truth and parent hold until original worker returns", async t => {
  const f = await setup(t); f.a.loseSubmit(); let closed = 0;
  f.engine.budget = { reserve: async () => ({ reservation_id: "original-parent" }), close: async () => { closed++; } };
  f.engine.video.budgetStatus = async () => ({ reservation_id: "original-parent", status: "reserved", consumed_micro: 0, allocated_micro: 0, remaining_micro: 100, open_children: 0, unknown_children: 0 });
  await f.engine.video.workOnce("owner"); const original = await f.intent();
  assert.equal(original.external_task_id, null); assert.equal(f.a.tasks.size, 1);
  f.engine.video.provider = f.b.provider;
  await assert.rejects(f.engine.video.reconcile(S, { video_job_id: f.id }), changed);
  const cancelled = await f.engine.video.cancel(S, f.id, "synthetic rollout cancellation");
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.remote_cancel_status, "unknown");
  await f.engine.video.maintain();
  const held = await f.engine.video.job(S, f.id);
  assert.equal(held.cleanup_error.code, "PROVIDER_INSTANCE_CHANGED"); assert.equal(held.budget_closed_at, null); assert.equal(closed, 0);
  assert.equal(f.b.calls.length, 0); assert.deepEqual(await f.intent(), original);
  f.engine.video.provider = f.a.provider; await f.engine.video.maintain();
  const final = await f.engine.video.job(S, f.id);
  assert.equal(final.state, "cancelled"); assert.equal(final.remote_cancel_status, "confirmed"); assert.ok(final.budget_closed_at); assert.equal(closed, 1);
  const recovered = await f.intent(); assert.equal(recovered.external_task_id, f.a.tasks.get(f.id).id); assert.equal(recovered.state, "terminal");
  assert.equal(f.a.calls.filter(x => x.path === "/v1/jobs").length, 1); assert.equal(f.b.calls.length, 0);
});

test("COL031 replacement cannot delete or erase another worker's accepted object namespace", async t => {
  const f = await setup(t); f.a.mode("complete");
  await f.engine.video.workOnce("owner");
  const object = f.a.object(f.id);
  f.engine.video.provider = f.b.provider;
  await assert.rejects(f.engine.video.rawObject(S, f.id, object.object_key), changed);
  await f.engine.video.cancel(S, f.id, "synthetic cleanup");
  await f.db.query(`UPDATE flow_video_assets SET revoked_at=now() WHERE id=(SELECT asset_id FROM flow_video_jobs WHERE id=$1)`, [f.id]);
  await f.engine.video.maintain();
  assert.equal((await f.engine.video.job(S, f.id)).execution_erased_at, null);
  assert.equal((await f.db.query(`SELECT state FROM flow_video_objects WHERE video_job_id=$1`, [f.id])).rows[0].state, "delete_pending");
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM flow_video_cleanup_receipts`)).rows[0].n, 0); assert.equal(f.b.calls.length, 0);
  f.engine.video.provider = f.a.provider; f.advance(61000); await f.engine.video.maintain();
  assert.equal((await f.db.query(`SELECT state FROM flow_video_objects WHERE video_job_id=$1`, [f.id])).rows[0].state, "deleted");
  assert.ok((await f.engine.video.job(S, f.id)).execution_erased_at);
  assert.ok(f.a.calls.some(x => x.path === "/v1/objects/delete")); assert.ok(f.a.calls.some(x => x.path === "/v1/jobs/erase")); assert.equal(f.b.calls.length, 0);
});

test("COL031 a different task receipt cannot rebind, import, settle or terminate the original task on any recovery path", async t => {
  const f = await setup(t); let closed = 0;
  f.engine.budget = { reserve: async () => ({ reservation_id: "original-parent" }), close: async () => { closed++; } };
  f.engine.video.budgetStatus = async () => ({ reservation_id: "original-parent", status: "reserved", consumed_micro: 0, allocated_micro: 0, remaining_micro: 100, open_children: 0, unknown_children: 0 });
  await f.engine.video.workOnce("owner"); const original = await f.intent();
  f.a.drift(true); f.a.mode("complete"); f.advance(6000);
  const stopped = await f.engine.video.workOnce("owner");
  assert.equal(stopped.state, "reconciliation_required"); assert.equal(stopped.error.code, "PROVIDER_TASK_MISMATCH");
  assert.deepEqual(await f.intent(), original);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM flow_video_manifests WHERE video_job_id=$1`, [f.id])).rows[0].n, 0);
  assert.equal(f.a.calls.filter(x => x.path.endsWith("/artifacts") || x.path === "/v1/objects").length, 0);
  const mismatch = (e: any) => e.status === 409 && e.reason === "PROVIDER_TASK_MISMATCH";
  await assert.rejects(f.engine.video.reconcile(S, { video_job_id: f.id }), mismatch);
  assert.deepEqual(await f.intent(), original);
  f.a.drift(false); f.a.mode("failed"); await f.engine.video.reconcile(S, { video_job_id: f.id });
  assert.equal((await f.engine.video.workOnce("owner")).state, "failed");
  const failed = await f.intent(); f.a.drift(true);
  await assert.rejects(f.engine.video.retry(S, f.id), mismatch);
  assert.deepEqual(await f.intent(), failed);
  f.a.drift(false); await f.engine.video.retry(S, f.id); const resume = await f.intent();
  assert.equal(resume.state, "resume_requested"); f.a.drift(true);
  assert.equal((await f.engine.video.workOnce("owner")).error.code, "PROVIDER_TASK_MISMATCH");
  assert.deepEqual(await f.intent(), resume);
  await f.engine.video.cancel(S, f.id, "synthetic drift cancellation"); await f.engine.video.maintain();
  assert.equal((await f.engine.video.job(S, f.id)).cleanup_error.code, "PROVIDER_TASK_MISMATCH");
  assert.equal((await f.intent()).state, "resume_requested"); assert.equal(closed, 0);
  assert.equal((await f.engine.video.job(S, f.id)).budget_closed_at, null);
  f.a.drift(false); await f.engine.video.maintain();
  assert.equal((await f.intent()).external_task_id, original.external_task_id); assert.equal((await f.intent()).state, "terminal");
  assert.equal(closed, 1); assert.equal(f.a.calls.filter(x => x.path === "/v1/jobs").length, 1); assert.equal(f.b.calls.length, 0);
});

test("COL031 an old contradictory terminal flag is not proof of external completion or permission to close its parent", async t => {
  const f = await setup(t); let closed = 0;
  f.engine.budget = { reserve: async () => ({ reservation_id: "legacy-parent" }), close: async () => { closed++; } };
  f.engine.video.budgetStatus = async () => ({ reservation_id: "legacy-parent", status: "reserved", consumed_micro: 0, allocated_micro: 0, remaining_micro: 100, open_children: 0, unknown_children: 0 });
  await f.engine.video.workOnce("owner"); const original = await f.intent();
  assert.equal(original.external_observed_state, "pending");
  // Exact persisted inconsistency from the independently reproduced pre-fix
  // wrong-task receipt: terminal flag, but the original task was only pending.
  await f.db.query(`UPDATE flow_video_submission_intents SET state='terminal' WHERE video_job_id=$1`, [f.id]);
  await f.db.query(`UPDATE flow_video_jobs SET state='failed' WHERE id=$1`, [f.id]);
  await f.engine.video.maintain(); assert.equal(closed, 0);
  assert.equal((await f.engine.video.job(S, f.id)).budget_closed_at, null);
  assert.equal((await f.intent()).external_observed_state, "pending");
  await f.engine.video.retry(S, f.id); await f.engine.video.cancel(S, f.id, "resolve legacy pending task");
  await f.engine.video.maintain();
  assert.equal((await f.intent()).external_task_id, original.external_task_id);
  assert.equal((await f.intent()).external_observed_state, "failed"); assert.equal(closed, 1);
  assert.equal(f.a.calls.filter(x => x.path === "/v1/jobs").length, 1);
});

for (const operation of ["reconcile", "maintenance"] as const) test(`COL031 concurrent unknown ${operation} freezes the first durable task ID and rejects a later conflicting receipt`, async t => {
  const f = await setup(t); f.a.loseSubmit();
  await f.engine.video.workOnce("owner"); assert.equal((await f.intent()).external_task_id, null);
  if (operation === "maintenance") await f.engine.video.cancel(S, f.id, "synthetic concurrent cleanup");
  let count = 0, reached!: () => void;
  const both = new Promise<void>(resolve => { reached = resolve; }), release: (() => void)[] = [];
  f.a.onReconcile(async value => {
    const index = count++, gate = new Promise<void>(resolve => { release[index] = resolve; });
    if (count === 2) reached(); await gate;
    return index === 0 ? value : { ...value, task_id: "late_conflicting_task", state: "failed", usage: { synthetic: 999 } };
  });
  const run = () => operation === "reconcile" ? f.engine.video.reconcile(S, { video_job_id: f.id }) : f.engine.video.maintain();
  const first = run(), second = run();
  const secondResult = operation === "reconcile" ? assert.rejects(second, (e: any) => e.reason === "PROVIDER_TASK_MISMATCH") : second;
  await both; release[0](); await first;
  const accepted = await f.intent(); assert.equal(accepted.external_task_id, f.a.tasks.get(f.id).id);
  release[1](); await secondResult;
  const final = await f.intent();
  assert.equal(final.external_task_id, accepted.external_task_id); assert.equal(final.external_observed_state, accepted.external_observed_state); assert.equal(final.state, accepted.state);
  if (operation === "maintenance") assert.equal((await f.engine.video.job(S, f.id)).cleanup_error.code, "PROVIDER_TASK_MISMATCH");
  assert.equal(f.a.calls.filter(x => x.path === "/v1/jobs").length, 1);
  assert.equal(f.a.calls.filter(x => x.path.includes("late_conflicting_task") || x.path.endsWith("/artifacts")).length, 0);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM flow_video_manifests WHERE video_job_id=$1`, [f.id])).rows[0].n, 0);
});

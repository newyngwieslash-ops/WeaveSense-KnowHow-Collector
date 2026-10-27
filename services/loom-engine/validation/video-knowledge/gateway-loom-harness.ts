// Cross-language integration fixture. Uses the production HTTP handler and real
// PGlite migrations; it does not simulate Loom responses or a platform provider.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgliteDb, migrate } from "../../flow/db.ts";
import { Engine, canvasConfigHash } from "../../flow/engine.ts";
import { handler } from "../../flow/server.ts";
import { sha } from "../../flow/video-contract.ts";
import { configureVideoKnowledge, platformKnowledgeRuntime } from "../../flow/video-knowledge-runtime.ts";
import { configureVideoRetentionJournal, initializeVideoDeletionJournal, replayVideoRetentionJournal } from "../../flow/video-journal.ts";
import { applyVideoRetention } from "../../flow/video-knowledge.ts";

const signingKey = process.env.VIDEO_QA_SIGNING_KEY;
if (!signingKey || signingKey.length < 32) throw new Error("VIDEO_QA_SIGNING_KEY required");
const db = await pgliteDb();
await migrate(db);
const engine = new Engine(db, async () => { throw new Error("fixture has no network provider"); });
// Test-only explicit provisioning of a NEW external journal, not startup auto-init.
const journalRoot = await mkdtemp(join(tmpdir(), "video-gateway-journal-"));
const journal = { directory: join(journalRoot, "journal"), journalId: "gateway-fixture", key: signingKey };
await initializeVideoDeletionJournal(journal);
configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
await replayVideoRetentionJournal(engine);
engine.video.enabled = true;
if (process.env.VIDEO_QA_HOST_URL) configureVideoKnowledge(engine, platformKnowledgeRuntime({ baseURL: process.env.VIDEO_QA_HOST_URL, signingKey, audience: "flow-platform" }));
if (process.env.VIDEO_QA_READY_FIXTURE === "1") {
  await readyFixture();
  await db.close();
  await rm(journalRoot, { recursive: true, force: true });
  process.exit(0);
}
const server = createServer(handler(engine, { signingKey, audience: "loom-engine", issuer: "flow-platform" }));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("listen failed");
process.stdout.write(`http://127.0.0.1:${address.port}\n`);
async function stop() {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.close();
  await rm(journalRoot, { recursive: true, force: true });
}
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });

// Real scheduler/discovery/import/outbox projection; only the licensed platform
// acquisition is substituted with clearly labelled in-memory synthetic bytes.
async function readyFixture() {
  const scope = { tenant_id: "ready_t", workspace_id: "ready_w", actor: { type: "user", id: "reviewer" }, policy_version: "qa_v1" };
  const profile = await engine.video.saveProfile(scope, { name: "Ready cycle fixture", config: { required_capabilities: ["transcript"] } });
  const source = await engine.createSource(scope, { kind: "bilibili", title: "Fixture battery", url: "https://www.bilibili.com/video/BV1QA0000001",
    config: { source_type: "video", native_id: "BV1QA0000001", profile_id: profile.id, profile_version: profile.version, usage_basis: "Synthetic cross-language fixture only", allowed_uses: ["knowledge"] } });
  const objects = new Map<string, Uint8Array>();
  engine.video.provider = {
    instance: "qa-synthetic", discover: async () => ({ items: [{ native_id: "BV1QA0000001", title: "Fixture battery", canonical_url: source.url }], complete: true, next_cursor: null, mode: "fixture" }),
    submit: async () => { throw new Error("fixture imports only"); }, poll: async () => { throw new Error("fixture imports only"); }, cancel: async () => "unsupported",
    readObject: async (_s, _j, key) => { const bytes = objects.get(key); if (!bytes) throw new Error("missing fixture object"); return bytes; },
  };
  const preview = await engine.previewMonitor(scope, { keywords: ["battery"], source_ids: [source.id], interval_seconds: 3600, budget_micro_per_window: 100 });
  const { monitor } = await engine.applyMonitor(scope, "user:reviewer", "qa_v1", { preview_id: preview.preview_id, approval_id: "qa-collection", idempotency_key: "qa-monitor" });
  const config = { nodes: [{ id: "data", type: "data-source", metadata: { dataSource: { format: "json", rawText: '[{"n":1}]' } } }, { id: "out", type: "markdown", metadata: {} }], connections: [{ fromNodeId: "data", toNodeId: "out" }] };
  await engine.updateMonitor(scope, "user:reviewer", monitor.id, { canvas_id: "qa_canvas", canvas_config: config,
    canvas_auto_run_grant: { approval_id: "qa-canvas", actor: "user:reviewer", policy_version: "qa_v1", config_version: 1, purpose: "monitor_canvas_recurring", execution_id: "qa_agent_run", monitor_id: monitor.id,
      interval_seconds: 3600, timezone: "UTC", total_budget_micro: 1000, max_runs: 10, expires_at: "2099-01-01T00:00:00Z", revoked_at: null, config_hash: canvasConfigHash(config), budget_micro_per_window: 100,
      scope: { tenant_id: scope.tenant_id, workspace_id: scope.workspace_id, canvas_id: "qa_canvas", source_ids: [source.id], tool_ids: ["intel_run_canvas_workflow"] } } });
  await db.query("UPDATE flow_schedules SET next_run_at=$2 WHERE id=$1", [monitor.schedule_id, new Date().toISOString()]);
  await engine.schedulerTick();
  await engine.workOnce("qa-discover");
  const job = (await db.query("SELECT * FROM flow_video_jobs")).rows[0];
  if (!job) throw new Error("scheduled discovery did not create video job");
  const object = (name: string, data: any) => {
    const bytes = Buffer.from(JSON.stringify(data)), hash = sha(bytes);
    const ref = { object_key: `tenants/${scope.tenant_id}/workspaces/${scope.workspace_id}/video/${job.id}/${hash}/${name}`, sha256: hash, bytes: bytes.length, content_type: "application/json" };
    objects.set(ref.object_key, bytes); return ref;
  };
  const segments = [{ text: "battery evidence from synthetic subtitles", start_ms: 0, end_ms: 1000 }];
  const input = object("input.json", { segments }), first = await engine.video.claim("qa-input");
  if (!first) throw new Error("input stage missing");
  const accepted = await engine.video.importManifest(scope, job.id, { schema_version: 1, artifact_stage: "input_ready", video_job_id: job.id, stage_attempt: first.attempt, fencing_token: Number(first.fencing_token),
    input_kind: "platform_subtitles", input_hash: input.sha256, media_sha256: null, availability: "not_acquired", objects: [input], coverage: { required: [], completed: [], missing: [] }, processors: { version: "qa-input" } }, first);
  const second = await engine.video.claim("qa-process"), output = object("segments.json", { segments });
  if (!second) throw new Error("processing stage missing");
  await engine.video.importManifest(scope, job.id, { schema_version: 1, artifact_stage: "processing_complete", video_job_id: job.id, stage_attempt: second.attempt, fencing_token: Number(second.fencing_token),
    input_kind: "platform_subtitles", input_hash: input.sha256, media_sha256: null, availability: "not_acquired", parent_manifest_sha256: accepted.manifest_sha256, objects: [output],
    transcript: { parts: [{ object_key: output.object_key, sha256: output.sha256, segment_count: 1, start_ms: 0, end_ms: 1000 }] },
    coverage: { required: ["transcript"], completed: ["transcript"], missing: [], duration_ms: 1000 }, processors: { version: "qa-process" } }, second);
  const events = (await db.query("SELECT * FROM flow_outbox WHERE type IN ('collection.completed','video.knowledge_ready') ORDER BY sequence")).rows;
  process.stdout.write(JSON.stringify({ events, monitor_id: monitor.id }) + "\n");
}

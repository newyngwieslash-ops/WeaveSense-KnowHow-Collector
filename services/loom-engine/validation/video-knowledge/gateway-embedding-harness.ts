// Real Loom stage/index plus real Go billing/model-task HTTP. Acquisition bytes
// and model vectors are explicitly synthetic; no platform/provider credential.
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { pgliteDb, migrate } from "../../flow/db.ts";
import { Engine } from "../../flow/engine.ts";
import { handler } from "../../flow/server.ts";
import { sign } from "../../flow/auth.ts";
import { sha } from "../../flow/video-contract.ts";
import { configureVideoKnowledge, platformKnowledgeRuntime } from "../../flow/video-knowledge-runtime.ts";
import { configureVideoRetentionJournal, initializeVideoDeletionJournal, replayVideoRetentionJournal } from "../../flow/video-journal.ts";
import { applyVideoRetention } from "../../flow/video-knowledge.ts";

const signingKey = process.env.VIDEO_QA_SIGNING_KEY!, host = process.env.VIDEO_QA_HOST_URL!;
if (!host || signingKey.length < 32) throw new Error("explicit fixture configuration required");
const scope = { tenant_id: process.env.VIDEO_QA_TENANT!, workspace_id: process.env.VIDEO_QA_WORKSPACE!, actor: { type: "user", id: "u_alice" }, policy_version: "qa_v1" };
const db = await pgliteDb(); await migrate(db);
let now = new Date();
const engine = new Engine(db, async () => { throw new Error("no platform fixture provider"); }, () => now); engine.video.enabled = true;
const journalRoot = await mkdtemp(join(tmpdir(), "video-embedding-journal-"));
const journal = { directory: join(journalRoot, "journal"), journalId: "embedding-fixture", key: signingKey };
await initializeVideoDeletionJournal(journal);
configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
await replayVideoRetentionJournal(engine);
configureVideoKnowledge(engine, platformKnowledgeRuntime({ baseURL: host, signingKey, audience: "flow-platform" }));
const server = createServer(handler(engine, { signingKey, audience: "loom-engine", issuer: "flow-platform" }));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
process.stdout.write(`http://127.0.0.1:${(server.address() as any).port}\n`);
const lines = createInterface({ input: process.stdin });
await new Promise<void>(resolve => lines.once("line", () => resolve())); lines.close();
try {
  const profile = await engine.video.saveProfile(scope, { name: "Synthetic embedding integration", config: { required_capabilities: ["transcript", "embedding"], budget_micro: 100000, embedding_model_id: "fixture-embedding", embedding_budget_micro: 10000, embedding_dimensions: 3 } });
  const source = await engine.createSource(scope, { kind: "bilibili", title: "Embedding source", url: "https://www.bilibili.com/video/BV1QA0000001", config: { source_type: "video", native_id: "BV1QA0000001", profile_id: profile.id, profile_version: 1, usage_basis: "Synthetic fixture only", allowed_uses: ["knowledge"] } });
  const objects = new Map<string, Uint8Array>();
  engine.video.provider = { instance: "synthetic", discover: async () => ({ items: [], complete: true, next_cursor: null, mode: "fixture" }), submit: async () => { throw new Error("explicit fixture imports only"); }, poll: async () => { throw new Error("explicit fixture imports only"); }, cancel: async () => "unsupported",
    readObject: async (_s, _j, key) => { const value = objects.get(key); if (!value) throw new Error("missing fixture bytes"); return value; } };
  const receipt = await engine.video.start(scope, "embedding-crosslayer", { source_id: source.id, native_id: "BV1QA0000001" });
  // The production coordinator reserves through this same existing billing API;
  // fixture imports skip acquisition, so bind its real admission explicitly.
  const token = sign(signingKey, { ...scope, iss: "loom-engine", aud: "flow-platform", actor: { type: "service_principal", id: "loom-engine" }, scopes: ["intel.video.model"] });
  const budgetResponse = await fetch(`${host}/api/internal/flow/budget/reserve`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ grant_actor: "user:u_alice", workspace_id: scope.workspace_id, key: "embedding-fixture-budget", amount_micro: 100000, ref_id: receipt.video_job_id }) });
  const budget: any = await budgetResponse.json(); if (!budgetResponse.ok || !budget.data?.reservation_id) throw new Error(`budget fixture ${budgetResponse.status} ${JSON.stringify(budget)}`);
  await db.query("UPDATE flow_video_jobs SET budget_reservation_id=$2 WHERE id=$1", [receipt.video_job_id, budget.data.reservation_id]);
  const object = (name: string, data: any) => { const bytes = Buffer.from(JSON.stringify(data)), hash = sha(bytes); const ref = { object_key: `tenants/${scope.tenant_id}/workspaces/${scope.workspace_id}/video/${receipt.video_job_id}/${hash}/${name}`, sha256: hash, bytes: bytes.length, content_type: "application/json" }; objects.set(ref.object_key, bytes); return ref; };
  const segments = [{ text: "Full synthetic embedding material without a paid model.", start_ms: 0, end_ms: 1000 }], input = object("input.json", { segments });
  const first = await engine.video.claim("input"); if (!first) throw new Error("input stage missing");
  const accepted = await engine.video.importManifest(scope, receipt.video_job_id, { schema_version: 1, artifact_stage: "input_ready", video_job_id: receipt.video_job_id, stage_attempt: first.attempt, fencing_token: Number(first.fencing_token), input_kind: "platform_subtitles", input_hash: input.sha256, media_sha256: null, availability: "not_acquired", objects: [input], coverage: { required: [], completed: [], missing: [] }, processors: { version: "qa-input" } }, first);
  const processStage = await engine.video.claim("process"), output = object("segments.json", { segments }); if (!processStage) throw new Error("process stage missing");
  // Exercise the production worker's durable adapter across TWO Python
  // processes, including an actual host settlement whose response is lost.
  const usageBody = { tenant_id: scope.tenant_id, workspace_id: scope.workspace_id, video_job_id: receipt.video_job_id,
    stage: "process", stage_attempt: processStage.attempt, fencing_token: Number(processStage.fencing_token), intent_key: "qa-meter",
    profile: profile.config, asset: {} };
  const usageEnv = { ...process.env, VIDEO_QA_USAGE_BODY: JSON.stringify(usageBody), VIDEO_QA_USAGE_STATE: join(journalRoot, "worker") };
  const usageScript = fileURLToPath(new URL("./gateway-usage-harness.py", import.meta.url));
  const initialUsage = await promisify(execFile)(process.env.VIDEO_QA_PYTHON ?? "python3", [usageScript], { env: { ...usageEnv, VIDEO_QA_USAGE_PHASE: "initial" }, timeout: 30000 });
  if (JSON.parse(initialUsage.stdout).phase !== "pending_after_lost_settlement") throw new Error("worker response loss fixture failed");
  const resumedUsage = await promisify(execFile)(process.env.VIDEO_QA_PYTHON ?? "python3", [usageScript], { env: { ...usageEnv, VIDEO_QA_USAGE_PHASE: "resume" }, timeout: 30000 });
  const usageWorker = JSON.parse(resumedUsage.stdout);
  const staged = await engine.video.importManifest(scope, receipt.video_job_id, { schema_version: 1, artifact_stage: "processing_complete", video_job_id: receipt.video_job_id, stage_attempt: processStage.attempt, fencing_token: Number(processStage.fencing_token), input_kind: "platform_subtitles", input_hash: input.sha256, media_sha256: null, availability: "not_acquired", parent_manifest_sha256: accepted.manifest_sha256, objects: [output], transcript: { parts: [{ object_key: output.object_key, sha256: output.sha256, segment_count: 1, start_ms: 0, end_ms: 1000 }] }, coverage: { required: ["transcript"], completed: ["transcript"], missing: [], duration_ms: 1000 }, processors: { version: "qa-process" } }, processStage);
  const before = (await db.query("SELECT count(*)::int n FROM flow_outbox WHERE type='video.knowledge_ready'")).rows[0].n;
  if (before !== 0 || staged.stage !== "embedding") throw new Error("embedding bypassed ready barrier");
  let job: any;
  for (let i = 0; i < 40; i++) {
    await engine.video.workOnce("embedding"); job = await engine.video.get(scope, receipt.video_job_id);
    if (["completed", "completed_with_gaps", "failed", "blocked_auth", "reconciliation_required"].includes(job.state)) break;
    await new Promise(resolve => setTimeout(resolve, 75)); now = new Date(now.getTime() + 6000);
  }
  const vectors = (await db.query("SELECT dims,vector FROM flow_document_embeddings")).rows;
  const ready = (await db.query("SELECT payload FROM flow_outbox WHERE type='video.knowledge_ready'")).rows;
  const batches = (await db.query("SELECT receipt,state FROM flow_video_embedding_batches")).rows;
  process.stdout.write(JSON.stringify({ job, ready, vectors, batches, usage_worker: usageWorker, ready_before_embedding: before, reservation_id: budget.data.reservation_id }) + "\n");
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); await rm(journalRoot, { recursive: true, force: true }); }

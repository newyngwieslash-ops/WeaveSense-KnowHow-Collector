// Real Loom HTTP, scheduler, stage workers and canonical indexing. Only the
// external acquisition provider is synthetic; no platform/model claim is made.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgliteDb, migrate } from "../../flow/db.ts";
import { Engine } from "../../flow/engine.ts";
import { handler } from "../../flow/server.ts";
import { sha, type VideoManifest } from "../../flow/video-contract.ts";
import { configureVideoRetentionJournal, initializeVideoDeletionJournal, replayVideoRetentionJournal } from "../../flow/video-journal.ts";
import { applyVideoRetention } from "../../flow/video-knowledge.ts";
import { configureVideoKnowledge, platformKnowledgeRuntime } from "../../flow/video-knowledge-runtime.ts";

const signingKey = process.env.VIDEO_QA_SIGNING_KEY;
if (!signingKey || signingKey.length < 32) throw new Error("VIDEO_QA_SIGNING_KEY required");
const db = await pgliteDb();
await migrate(db);
const engine = new Engine(db, async () => { throw new Error("synthetic provider has no network access"); });
const directory = await mkdtemp(join(tmpdir(), "video-paging-journal-"));
const journal = { directory: join(directory, "journal"), journalId: "paging-fixture", key: signingKey };
await initializeVideoDeletionJournal(journal);
configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
await replayVideoRetentionJournal(engine);
engine.video.enabled = true;
if (process.env.VIDEO_QA_HOST_URL) configureVideoKnowledge(engine, platformKnowledgeRuntime({ baseURL: process.env.VIDEO_QA_HOST_URL, signingKey, audience: "flow-platform" }));
const objects = new Map<string, Uint8Array>();
const receipts: { stage: string; job_id: string; intent_key: string }[] = [];
let discoveryCalls = 0;
const segments = Array.from({ length: 81 }, (_, i) => ({
  text: `segment-${String(i).padStart(3, "0")}:` + "\u4e2d\u6587\ud83e\uddea".repeat(i === 40 ? 420 : 50) + `:tail-${i}`,
  start_ms: i * 1000, end_ms: (i + 1) * 1000,
}));
// A second acceptance test supplies hostile subtitle text. It remains bytes in
// the ordinary input manifest; it cannot alter any route/provider implementation.
if (process.env.VIDEO_QA_SOURCE_ATTACK) segments[0].text = process.env.VIDEO_QA_SOURCE_ATTACK;
engine.video.provider = {
  instance: "synthetic-sdk-paging-not-live-platform",
  discover: async source => {
    discoveryCalls++;
    return { items: [{ native_id: source.config.native_id, part_id: "1", title: source.title, canonical_url: source.url }], complete: true, next_cursor: null, mode: "fixture" };
  },
  submit: async (job, stage, intentKey, _profile, inputManifest) => {
    receipts.push({ stage: stage.stage, job_id: job.id, intent_key: intentKey });
    // A genuinely asynchronous stage outlives the initiating MCP call. The
    // worker, not a test route/import shortcut, commits the signed manifest.
    await new Promise(resolve => setTimeout(resolve, stage.stage === "input" ? 1200 : 100));
    const bytes = Buffer.from(JSON.stringify({ segments })), hash = sha(bytes);
    const object = { object_key: `tenants/${job.tenant_id}/workspaces/${job.workspace_id}/video/${job.id}/${hash}/${stage.stage}.json`, sha256: hash, bytes: bytes.length, content_type: "application/json" };
    objects.set(object.object_key, bytes);
    const manifest: VideoManifest = {
      schema_version: 1, artifact_stage: stage.stage === "input" ? "input_ready" : "processing_complete", video_job_id: job.id,
      stage_attempt: stage.attempt, fencing_token: Number(stage.fencing_token), input_kind: "platform_subtitles",
      input_hash: inputManifest?.input_hash ?? hash, media_sha256: null, availability: "not_acquired", objects: [object],
      coverage: stage.stage === "input" ? { required: [], completed: [], missing: [] } : { required: ["transcript"], completed: ["transcript"], missing: [], duration_ms: 81000 },
      processors: { version: "synthetic-sdk-paging-v1" },
      ...(stage.stage === "process" ? { parent_manifest_sha256: job.input_manifest_sha256,
        transcript: { parts: [{ object_key: object.object_key, sha256: hash, segment_count: segments.length, start_ms: 0, end_ms: 81000 }] } } : {}),
    };
    return { task_id: `synthetic-${stage.stage}-${job.id}`, state: "completed", manifest };
  },
  poll: async () => { throw new Error("completed synthetic tasks must not be resubmitted or polled"); },
  cancel: async () => "unsupported",
  readObject: async (_scope, _job, key, max) => {
    const bytes = objects.get(key);
    if (!bytes || bytes.length > max) throw new Error("synthetic object missing or too large");
    return bytes;
  },
};
const production = handler(engine, { signingKey, audience: "loom-engine", issuer: "flow-platform" });
const server = createServer((req, res) => {
  if (req.url === "/__fixture/receipts" && req.method === "GET") {
    // Observations only; cannot advance, seed, or complete production state.
    void db.query("SELECT count(*)::int n FROM flow_video_jobs").then(async jobs => {
      const ready = await db.query("SELECT count(*)::int n FROM flow_outbox WHERE type='video.knowledge_ready'");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mode: "synthetic-provider", submissions: receipts, discovery_calls: discoveryCalls, jobs: jobs.rows[0].n, knowledge_ready_events: ready.rows[0].n }));
    }).catch(error => { res.writeHead(500); res.end(String(error)); });
    return;
  }
  void production(req, res);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("listen failed");
process.stdout.write(`http://127.0.0.1:${address.port}\n`);
let stopping = false;
const background = (async () => {
  while (!stopping) {
    await engine.schedulerTick();
    await engine.workOnce("sdk-discovery");
    await engine.video.workOnce("sdk-video");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
})();
background.catch(error => { process.stderr.write(String(error)); process.exitCode = 1; stopping = true; });
async function stop() {
  stopping = true;
  await background;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await db.close();
  await rm(directory, { recursive: true, force: true });
}
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });

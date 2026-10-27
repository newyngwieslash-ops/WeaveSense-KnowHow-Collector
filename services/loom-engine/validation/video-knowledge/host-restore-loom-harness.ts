// QA only: real Loom handlers/coordinator/domain + PGlite + independent journal.
// Platform subtitles are labelled synthetic; no paid model or human review claim.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgliteDb, migrate } from "../../flow/db.ts";
import { Engine } from "../../flow/engine.ts";
import { Reports } from "../../flow/reports.ts";
import { handler } from "../../flow/server.ts";
import { sha } from "../../flow/video-contract.ts";
import { applyVideoRetention } from "../../flow/video-knowledge.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "../../flow/video-journal.ts";

const signingKey = process.env.VIDEO_QA_SIGNING_KEY!;
if (!signingKey || signingKey.length < 32) throw new Error("VIDEO_QA_SIGNING_KEY required");
const scope = { ...JSON.parse(process.env.VIDEO_QA_SCOPE!), actor: { type: "user", id: "u_alice" }, policy_version: "qa_v1" };
const db = await pgliteDb(); await migrate(db);
const engine = new Engine(db, async () => [{ external_id: "rss-qa", title: "RSS independent", body: "PUBLIC_RSS_CANARY", url: "https://example.invalid/rss-item", published_at: new Date().toISOString() }]);
const directory = await mkdtemp(join(tmpdir(), "host-restore-loom-"));
const config = { directory: join(directory, "journal"), journalId: "qa-host-restore", key: signingKey };
await initializeVideoDeletionJournal(config);
configureVideoRetentionJournal(engine, config, (q, event) => applyVideoRetention(engine, q, event, event));
await replayVideoRetentionJournal(engine); engine.video.enabled = true;
const objects = new Map<string, Uint8Array>();
engine.video.provider = { instance: "synthetic-host-restore", discover: async () => ({ items: [], complete: true, next_cursor: null, mode: "fixture" }),
  submit: async () => { throw new Error("fixture imports only"); }, poll: async () => { throw new Error("fixture imports only"); }, cancel: async () => "unsupported",
  readObject: async (_s, _j, key) => { const bytes = objects.get(key); if (!bytes) throw new Error("object absent"); return bytes; } };
const retention = process.env.VIDEO_QA_TYPED_TTL === "1" ? { retention_policy: { version: 1,
  ...Object.fromEntries(["media", "audio", "frame", "transcript", "evidence"].map(kind => [kind, { access_seconds: 60, maximum_seconds: 120 }])) } } : {};
const profile = await engine.video.saveProfile(scope, { name: "Host restore fixture", config: { required_capabilities: ["transcript"], ...retention } });
const authorizationExpiresAt = process.env.VIDEO_QA_AUTH_EXPIRES_SECONDS ? new Date(Date.now() + Number(process.env.VIDEO_QA_AUTH_EXPIRES_SECONDS) * 1000).toISOString() : undefined;
const source = await engine.createSource(scope, { kind: "bilibili", title: "Private synthetic source", url: "https://www.bilibili.com/video/BV1RESTORE01", config: {
  source_type: "video", native_id: "BV1RESTORE01", profile_id: profile.id, profile_version: profile.version, usage_basis: "Synthetic restoration fixture", allowed_uses: ["knowledge"],
  ...(authorizationExpiresAt ? { authorization_expires_at: authorizationExpiresAt } : {}) } });
const job = await engine.video.start(scope, "host-restore-video", { source_id: source.id });
const object = (name: string) => {
  const bytes = Buffer.from(JSON.stringify({ segments: [{ text: "PRIVATE_HOST_RESTORE_CANARY", start_ms: 0, end_ms: 1000 }] })), digest = sha(bytes);
  const ref = { object_key: `tenants/${scope.tenant_id}/workspaces/${scope.workspace_id}/video/${job.video_job_id}/${digest}/${name}`, sha256: digest, bytes: bytes.length, content_type: "application/json" };
  objects.set(ref.object_key, bytes); return ref;
};
const first = await engine.video.claim("qa-input"), input = object("input.json");
const parent = await engine.video.importManifest(scope, job.video_job_id, { schema_version: 1, artifact_stage: "input_ready", video_job_id: job.video_job_id,
  stage_attempt: first.attempt, fencing_token: Number(first.fencing_token), input_kind: "platform_subtitles", input_hash: input.sha256,
  media_sha256: null, availability: "not_acquired", objects: [input], coverage: { required: [], completed: [], missing: [] }, processors: { version: "qa-input" } }, first);
const second = await engine.video.claim("qa-process"), output = object("segments.json");
const ready = await engine.video.importManifest(scope, job.video_job_id, { schema_version: 1, artifact_stage: "processing_complete", video_job_id: job.video_job_id,
  stage_attempt: second.attempt, fencing_token: Number(second.fencing_token), input_kind: "platform_subtitles", input_hash: input.sha256,
  media_sha256: null, availability: "not_acquired", parent_manifest_sha256: parent.manifest_sha256, objects: [output],
  transcript: { parts: [{ object_key: output.object_key, sha256: output.sha256, segment_count: 1, start_ms: 0, end_ms: 1000 }] },
  coverage: { required: ["transcript"], completed: ["transcript"], missing: [], duration_ms: 1000 }, processors: { version: "qa-processing" } }, second);
const rss = await engine.createSource(scope, { kind: "rss", url: "https://example.invalid/qa-rss" });
await engine.requestCollection(scope, "rss-qa", { source_ids: [rss.id] }); await engine.workOnce("qa-rss");
const rssDocument = (await engine.listDocuments(scope, { source_id: rss.id })).find((d: any) => d.source_id === rss.id);
const reports = new Reports(engine);
async function report(key: string, documentId: string, canary: string) {
  const run: any = await reports.startResearch(scope, key, { parent_run_id: "qa-host-parent", question: canary, evidence_scope: { document_ids: [documentId] } });
  if (run.status !== "succeeded" || !run.output.claims.length) throw new Error("research fixture failed");
  return { ...await reports.saveReport(scope, "user:u_alice", key, { title: canary, body: canary, claims: run.output.claims, material_scope: { document_ids: [documentId] }, research_run_id: run.id }), research_id: run.id };
}
const videoReport = await report("video-report", ready.document_id, "PRIVATE_HOST_RESTORE_CANARY");
const rssReport = await report("rss-report", rssDocument.id, "PUBLIC_RSS_CANARY");
const events = (await db.query("SELECT * FROM flow_outbox WHERE type IN ('report.completed','research.completed') ORDER BY sequence")).rows;
const server = createServer(handler(engine, { signingKey, audience: "loom-engine", issuer: "flow-platform" }));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const retentionState = (await db.query("SELECT text_access_expires_at,retention_policy_hash FROM flow_video_jobs WHERE id=$1", [job.video_job_id])).rows[0];
process.stdout.write(JSON.stringify({ endpoint: `http://127.0.0.1:${(server.address() as any).port}`, job: await engine.video.get(scope, job.video_job_id), video_report: videoReport, rss_report: rssReport, rss_document: rssDocument, events, authorization_expires_at: authorizationExpiresAt, retention: retentionState }) + "\n");
async function stop() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); await rm(directory, { recursive: true, force: true }); }
process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });

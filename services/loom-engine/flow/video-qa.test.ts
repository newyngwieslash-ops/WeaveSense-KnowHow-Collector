// Independent contract/fault fixtures against the real coordinator and migrated
// database. Platform acquisition and model quality are deliberately not claimed.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readFile, cp, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PGlite } from "@electric-sql/pglite";
import { Engine } from "./engine.ts";
import { migrate, pgliteDb, pgDb, withTenant, type Db } from "./db.ts";
import { verify, sign, requireScope } from "./auth.ts";
import { assertVideoObject, canonicalHash, canonicalTranscript, normalizeVideoURL, sha, type VideoManifest, type VideoScope } from "./video-contract.ts";
import { HTTPVideoProvider, type VideoProvider } from "./video-provider.ts";
import { VideoKnowledgeService, applyVideoRetention } from "./video-knowledge.ts";
import { configureVideoKnowledge } from "./video-knowledge-runtime.ts";
import { handler } from "./server.ts";
import { VideoKnowledgeSkills } from "./video-knowledge-skills.ts";
import { Reports } from "./reports.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "./video-journal.ts";

const S = { tenant_id: "qa_tenant", workspace_id: "qa_workspace", actor: { type: "user", id: "qa_reviewer" }, policy_version: "qa_v1" };
const FOREIGN = { ...S, workspace_id: "qa_foreign" };
const journalDirectories: string[] = [];
afterEach(async () => { for (const path of journalDirectories.splice(0)) await rm(path, { recursive: true, force: true }); });

async function openDisk(path: string): Promise<Db> {
  const pg = new PGlite(path);
  return {
    query: (sql, params) => pg.query(sql, params as any[]) as any,
    tx: fn => pg.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params as any[]) as any })),
    close: () => pg.close(),
  };
}

async function fixture(database?: Db, clock = () => new Date(), profileConfig: Record<string, unknown> = {}) {
  const db = database ?? await pgliteDb();
  await migrate(db);
  const engine = new Engine(db, async () => { throw new Error("no live provider in QA fixture"); }, clock);
  engine.video.enabled = true;
  const journalParent = await mkdtemp(join(tmpdir(), "knowhow-qa-journal-")); journalDirectories.push(journalParent);
  const journalConfig = { directory: join(journalParent, "journal"), journalId: "qa-synthetic-journal", key: "q".repeat(48) };
  await initializeVideoDeletionJournal(journalConfig);
  configureVideoRetentionJournal(engine, journalConfig, (q, event) => applyVideoRetention(engine, q, event, event));
  await replayVideoRetentionJournal(engine);
  const bytes = new Map<string, Uint8Array>();
  const provider: VideoProvider = {
    instance: "qa-fixture-not-a-live-platform",
    discover: async () => ({ items: [], complete: false, next_cursor: null, mode: "fixture" }),
    submit: async () => { throw new Error("explicit fixture imports only"); },
    poll: async () => { throw new Error("explicit fixture imports only"); },
    cancel: async () => "unsupported",
    readObject: async (_scope: VideoScope, _job: string, key: string, max: number) => {
      const raw = bytes.get(key); assert.ok(raw, `missing fixture object ${key}`);
      assert.ok(raw.byteLength <= max); return raw;
    },
  };
  engine.video.provider = provider;
  const profile = await engine.video.saveProfile(S, { name: "QA synthetic only", config: { required_capabilities: ["transcript"], ...profileConfig } });
  const source = await engine.createSource(S, { kind: "bilibili", title: "测试🧪", url: "https://www.bilibili.com/video/BV1QA0000001?p=1",
    config: { source_type: "video", native_id: "BV1QA0000001", part_id: "1", profile_id: profile.id, profile_version: profile.version,
      usage_basis: "Synthetic fixture, not a licensed real video", allowed_uses: ["knowledge"] } });
  const object = (job: string, data: any, name = "segments.json") => {
    const raw = Buffer.from(JSON.stringify(data)), digest = sha(raw);
    const ref = { object_key: `tenants/${S.tenant_id}/workspaces/${S.workspace_id}/video/${job}/${digest}/${name}`, sha256: digest, bytes: raw.length, content_type: "application/json" };
    bytes.set(ref.object_key, raw); return ref;
  };
  async function start(version = "v1") {
    const receipt = await engine.video.start(S, `qa-${version}`, { source_id: source.id, content_version: version });
    const st = await engine.video.claim("qa-input"); assert.ok(st);
    const ref = object(receipt.video_job_id, { kind: "manual", language: "zh", segments: [{ text: "真实夹具文字🧪", start_ms: 0, end_ms: 1000 }] }, "input.json");
    const manifest: VideoManifest = { schema_version: 1, artifact_stage: "input_ready", video_job_id: receipt.video_job_id,
      stage_attempt: st.attempt, fencing_token: Number(st.fencing_token), input_kind: "platform_subtitles", input_hash: ref.sha256,
      media_sha256: null, availability: "not_acquired", objects: [ref], coverage: { required: [], completed: [], missing: [] }, processors: { version: "qa-input-v1" } };
    return { receipt, st, manifest };
  }
  async function process(input: Awaited<ReturnType<typeof start>>, segments = [{ text: "知识结论🧪", start_ms: 0, end_ms: 1000 }]) {
    const accepted = await engine.video.importManifest(S, input.receipt.video_job_id, input.manifest, input.st);
    const st = await engine.video.claim("qa-process"); assert.ok(st);
    const ref = object(input.receipt.video_job_id, { segments });
    const manifest: VideoManifest = { schema_version: 1, artifact_stage: "processing_complete", video_job_id: input.receipt.video_job_id,
      stage_attempt: st.attempt, fencing_token: Number(st.fencing_token), input_kind: "platform_subtitles", input_hash: input.manifest.input_hash,
      media_sha256: null, availability: "not_acquired", parent_manifest_sha256: accepted.manifest_sha256, objects: [ref],
      transcript: { parts: [{ object_key: ref.object_key, sha256: ref.sha256, segment_count: segments.length, start_ms: 0, end_ms: segments.at(-1)!.end_ms }] },
      coverage: { required: ["transcript"], completed: ["transcript"], missing: [], duration_ms: segments.at(-1)!.end_ms }, processors: { version: "qa-process-v1" } };
    return { st, manifest };
  }
  return { db, engine, source, profile, provider, bytes, object, start, process, journalConfig };
}

test("QA AC12: canonical UTF-16 offsets preserve emoji, combining marks and full tail", () => {
  const title = "行业🧪", segments = [{ text: "中文😀e\u0301", start_ms: 0, end_ms: 1000 }, { text: "跨段🛰️终点", start_ms: 1000, end_ms: 2000 }];
  const actual = canonicalTranscript(title, segments);
  assert.equal(actual.spans[0].char_start, 6);
  for (const span of actual.spans) assert.equal(actual.text.slice(span.char_start, span.char_end), span.text);
  assert.equal(actual.text, title + "\n\n" + segments.map(s => s.text).join("\n"));
});

test("QA G14: shared three-language scope, durable idempotency and manifest corpus", async t => {
  const shared = JSON.parse(await readFile(new URL("../validation/video-knowledge/shared-contract-v1.json", import.meta.url), "utf8"));
  assert.equal(shared.version, 1);
  for (const item of shared.auth) {
    const validate = () => requireScope(verify(shared.key, item.token, "video-knowledge", shared.now), shared.permission);
    if (item.accept) assert.doesNotThrow(validate, item.id); else assert.throws(validate, undefined, item.id);
  }
  for (const item of shared.object_keys) {
    const validate = () => assertVideoObject(shared.scope, item.key, item.job_id ?? undefined);
    if (item.accept) assert.doesNotThrow(validate, item.id); else assert.throws(validate, undefined, item.id);
  }
  const f = await fixture(undefined, undefined, { max_video_bytes: 1_000_000, max_duration_ms: 5_000 }); t.after(() => f.db.close());
  const first = await f.engine.video.start(S, shared.idempotency.key, { source_id: f.source.id, ...shared.idempotency.first });
  const same = await f.engine.video.start(S, shared.idempotency.key, { source_id: f.source.id, ...shared.idempotency.same });
  assert.equal(same.video_job_id, first.video_job_id);
  await assert.rejects(f.engine.video.start(S, shared.idempotency.key, { source_id: f.source.id, ...shared.idempotency.changed }), (e: any) => e.reason === "IDEMPOTENCY_CONFLICT");
  await f.engine.video.cancel(S, first.video_job_id);
  // Reject cases first so a successful import does not leave a pending process
  // stage competing with the next input claim in this real coordinator.
  for (const item of [...shared.manifest_cases].sort((a, b) => Number(a.accept) - Number(b.accept))) {
    const input = await f.start("shared-" + item.id);
    const ref = { object_key: shared.input.object_key.replace(shared.job_id, input.receipt.video_job_id), sha256: shared.input.sha256, bytes: shared.input.bytes, content_type: "application/json" };
    f.bytes.set(ref.object_key, Buffer.from(shared.input.raw));
    const m = { ...input.manifest, input_hash: ref.sha256, objects: [ref] };
    if (item.id === "wrong_object_workspace") ref.object_key = ref.object_key.replace("qa_workspace", "foreign");
    if (item.id === "wrong_hash") ref.sha256 = m.input_hash = "f".repeat(64);
    if (item.id === "path_hash_mismatch") { ref.object_key = ref.object_key.replace(ref.sha256, "f".repeat(64)); f.bytes.set(ref.object_key, Buffer.from(shared.input.raw)); }
    if (item.id === "wrong_size") ref.bytes++;
    if (item.id === "wrong_job") m.video_job_id = "foreign_job";
    if (item.id === "unbacked_input_hash") m.input_hash = "e".repeat(64);
    if (item.id === "invalid_subtitle_availability") m.availability = "available";
    if (item.id === "bad_schema") (m as any).schema_version = 2;
    const validate = () => f.engine.video.importManifest(S, input.receipt.video_job_id, m, input.st);
    if (item.accept) await validate(); else await assert.rejects(validate(), undefined, item.id);
  }
});

test("QA COL002: invalid platform and invalid Bilibili part never collapse to default identity", () => {
  for (const part of ["0", "-1", "1.5", "bogus", "9007199254740993"]) {
    assert.throws(() => normalizeVideoURL("bilibili", `https://www.bilibili.com/video/BV1QA0000001?p=${part}`));
  }
  assert.throws(() => normalizeVideoURL("unknown", "https://www.douyin.com/video/123"));
});

test("QA IF004: signed malformed validity claims cannot create perpetual authorization", () => {
  const key = "q".repeat(32), now = Math.floor(Date.now() / 1000);
  const good = { iss: "flow-platform", aud: "loom-engine", tenant_id: "t", workspace_id: "w", actor: { type: "user", id: "u" }, scopes: [], policy_version: "p", iat: now, exp: now + 60, jti: "qa" };
  function token(claims: any) {
    const head = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"), body = Buffer.from(JSON.stringify(claims)).toString("base64url"), unsigned = `${head}.${body}`;
    return unsigned + "." + createHmac("sha256", key).update(unsigned).digest("base64url");
  }
  for (const malformed of [{ ...good, exp: undefined }, { ...good, iat: undefined }, { ...good, exp: "tomorrow" }, { ...good, iat: now + 100, exp: now + 150 }, { ...good, iat: now + 100, exp: now + 60 }]) {
    assert.throws(() => verify(key, token(malformed), "loom-engine", now));
  }
});

test("QA CFG: job freezes the selected profile processing mode, not an unrelated source default", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const profile = await f.engine.video.saveProfile(S, { id: f.profile.id, expected_version: 1, name: "Full video fixture", config: { required_capabilities: ["transcript"], processing_mode: "full_video" } });
  const job = await f.engine.video.start(S, "profile-mode", { source_id: f.source.id, profile_id: profile.id, profile_version: profile.version });
  const saved = (await f.db.query("SELECT input FROM flow_video_jobs WHERE id=$1", [job.video_job_id])).rows[0];
  assert.equal(saved.input.processing_mode, "full_video");
});

test("QA K017: unavailable required embedding blocks; optional worker completion is not trusted index proof", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const required = await f.engine.video.saveProfile(S, { name: "Required embedding fixture", config: { required_capabilities: ["transcript", "embedding"] } });
  await assert.rejects(f.engine.video.start(S, "required-embedding", { source_id: f.source.id, profile_id: required.id, profile_version: required.version }), (e: any) => e.status === 503 && e.reason === "EMBEDDING_UNAVAILABLE");
  const optional = await f.engine.video.saveProfile(S, { id: f.profile.id, expected_version: 1, name: "Optional embedding fixture", config: { required_capabilities: ["transcript"], optional_capabilities: ["embedding"] } });
  await f.engine.updateSource(S, f.source.id, { expected_revision: 1, config: { profile_version: optional.version } });
  const input = await f.start(), processing = await f.process(input);
  processing.manifest.coverage.completed.push("embedding");
  const ready = await f.engine.video.importManifest(S, input.receipt.video_job_id, processing.manifest, processing.st);
  assert.equal(ready.state, "completed_with_gaps");
  const job = await f.engine.video.get(S, input.receipt.video_job_id);
  assert.ok(job.coverage.optional_missing.includes("embedding"));
  assert.ok(!job.available_capabilities.includes("embedding"));
});

for (const backend of ["PGlite", "PostgreSQL"] as const) test(`QA K017 ${backend}: coordinator required embedding gates FTS, vectors and ready event on verified host receipt`, {
  skip: backend === "PostgreSQL" && !process.env.FLOW_VIDEO_TEST_PG_URL ? "FLOW_VIDEO_TEST_PG_URL not configured" : false,
}, async t => {
  let database: Db | undefined, maintenance: Db | undefined, databaseName: string | undefined;
  if (backend === "PostgreSQL") {
    maintenance = await pgDb(process.env.FLOW_VIDEO_TEST_PG_URL!); databaseName = `qa_embedding_${process.pid}_${Date.now()}`;
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(process.env.FLOW_VIDEO_TEST_PG_URL!); url.pathname = `/${databaseName}`; database = await pgDb(url.toString());
  }
  const f = await fixture(database, () => new Date(), {
    required_capabilities: ["transcript", "embedding"], embedding_model_id: "fixture-embedding", embedding_budget_micro: 10000, embedding_dimensions: 3,
  });
  t.after(async () => { await f.db.close(); if (maintenance) { await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await maintenance.close(); } });
  if (backend === "PostgreSQL") assert.equal((await f.db.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, false);
  const input = await f.start(`embedding-${backend}`), processing = await f.process(input, [{ text: "Indexed proof 😀 ".repeat(180), start_ms: 0, end_ms: 1000 }]);
  const queued = await f.engine.video.importManifest(S, input.receipt.video_job_id, processing.manifest, processing.st);
  assert.equal(queued.stage, "embedding"); assert.equal(queued.state, "queued");
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_documents d JOIN flow_video_jobs j ON j.asset_id=d.video_asset_id WHERE j.id=$1", [input.receipt.video_job_id])).rows[0].n, 0);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_outbox WHERE type='video.knowledge_ready' AND job_id=$1", [input.receipt.video_job_id])).rows[0].n, 0);
  // Explicit synthetic budget parent: this tests the coordinator's persisted receipt
  // barrier, not host billing. The separate Go cross-layer test owns real metering.
  await f.db.query("UPDATE flow_video_jobs SET budget_reservation_id='qa-synthetic-parent' WHERE id=$1", [input.receipt.video_job_id]);
  let called = 0;
  configureVideoKnowledge(f.engine, { modelTask: async (scope, jobId, purpose, request) => {
    called++; assert.equal(scope.tenant_id, S.tenant_id); assert.equal(jobId, input.receipt.video_job_id); assert.equal(purpose, "video_embedding");
    assert.ok(request.stage_attempt! > 0); assert.ok(request.fencing_token! > 0);
    assert.ok(request.input.texts.every((x: any) => sha(x.text) === x.sha256));
    return { task_id: `fixture-${request.key}`, status: "succeeded", reservation_id: "qa-synthetic-child", cost_micro: 1,
      model_config_hash: "a".repeat(64), input_hash: canonicalHash(request.input), usage_ref: `model_task:fixture-${request.key}`,
      output: { model: "fixture-embedding", dimensions: 3, vectors: request.input.texts.map((x: any) => ({ chunk_id: x.chunk_id, sha256: x.sha256, vector: [0.1, 0.2, 0.3] })) } };
  } });
  const ready = await f.engine.video.workOnce("qa-embedding-worker");
  assert.ok(called > 0); assert.equal(ready.state, "completed"); assert.equal(ready.completion_level, "knowledge_ready");
  assert.ok(ready.available_capabilities.includes("embedding"));
  const chunks = (await f.db.query("SELECT * FROM flow_document_chunks WHERE document_id=$1 ORDER BY chunk_index", [ready.document_id])).rows;
  const vectors = (await f.db.query("SELECT * FROM flow_document_embeddings WHERE document_id=$1 ORDER BY chunk_index", [ready.document_id])).rows;
  assert.ok(chunks.length > 1); assert.equal(vectors.length, chunks.length);
  assert.equal(chunks.map(x => x.text).join(""), canonicalTranscript("测试🧪", [{ text: "Indexed proof 😀 ".repeat(180), start_ms: 0, end_ms: 1000 }]).text);
  for (const vector of vectors) assert.deepEqual(vector.vector.map(Math.fround), [0.1, 0.2, 0.3].map(Math.fround));
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_outbox WHERE type='video.knowledge_ready' AND job_id=$1", [ready.video_job_id])).rows[0].n, 1);
  assert.equal(await f.engine.video.workOnce("qa-no-duplicate"), null);
  t.diagnostic(`actual ${backend} migrations/coordinator/stage/index/outbox; explicitly fixture vectors and parent, not model quality or production billing`);
});

test("QA COL017: file-backed PGlite restart preserves job and rejects pre-restart expired fence", async t => {
  const directory = await mkdtemp(join(tmpdir(), "weavesense-video-qa-"));
  let db = await openDisk(directory), now = new Date("2026-10-20T00:00:00Z");
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  const f = await fixture(db, () => now), input = await f.start();
  await db.close(); db = await openDisk(directory);
  const restarted = new Engine(db, async () => [], () => now); restarted.video.enabled = true;
  configureVideoRetentionJournal(restarted, f.journalConfig, (q, event) => applyVideoRetention(restarted, q, event, event));
  assert.equal((await restarted.video.get(S, input.receipt.video_job_id)).state, "running");
  assert.equal(await restarted.video.claim("qa-second"), null);
  now = new Date("2026-10-20T00:02:00Z");
  const takeover = await restarted.video.claim("qa-second");
  assert.equal(takeover.video_job_id, input.receipt.video_job_id);
  assert.ok(Number(takeover.fencing_token) > Number(input.st.fencing_token));
  await assert.rejects(restarted.video.heartbeat(input.st), (e: any) => e.status === 409);
  await assert.rejects(restarted.video.get(FOREIGN, input.receipt.video_job_id), (e: any) => e.status === 404);
});

test("QA IF010: verified bytes cannot be relabelled with forged input or parent identity", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const input = await f.start();
  await assert.rejects(f.engine.video.importManifest(S, input.receipt.video_job_id, { ...input.manifest, input_hash: "a".repeat(64) }, input.st), (e: any) => e.status >= 400);
  const processing = await f.process(input);
  await assert.rejects(f.engine.video.importManifest(S, input.receipt.video_job_id, { ...processing.manifest, input_hash: "b".repeat(64) }, processing.st), (e: any) => e.status >= 400);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM flow_outbox WHERE type='video.knowledge_ready'")).rows[0].n, 0);
});

test("QA AC09/12/13: 2101 segments >400001 chars, fixed evidence, FTS tail and atomic index retry", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const input = await f.start();
  const segments = Array.from({ length: 2101 }, (_, i) => ({ text: `${i} 中文😀e\u0301 ${"材料".repeat(100)} ${i === 2100 ? "UNIQUEQAENDTOKEN" : ""}`, start_ms: i * 1000, end_ms: (i + 1) * 1000 }));
  const canonical = canonicalTranscript("测试🧪", segments); assert.ok(canonical.text.length > 400001);
  const processing = await f.process(input, segments);
  const ready = await f.engine.video.importManifest(S, input.receipt.video_job_id, processing.manifest, processing.st);
  assert.equal(ready.completion_level, "knowledge_ready");
  const revision = await f.engine.getRevision(S, ready.document_id, 1);
  assert.equal(revision.body, canonical.body);
  const evidence = (await f.db.query("SELECT * FROM flow_evidence WHERE document_id=$1 ORDER BY char_start", [ready.document_id])).rows;
  assert.equal(evidence.length, 2101);
  for (const e of evidence) { assert.equal(canonical.text.slice(e.char_start, e.char_end), e.quote); assert.equal(sha(e.quote), e.snippet_hash); }
  const tail = (await f.db.query("SELECT text FROM flow_document_chunks WHERE document_id=$1 AND text LIKE '%UNIQUEQAENDTOKEN%'", [ready.document_id])).rows;
  assert.ok(tail.length > 0, "tail must exist in the host index");
  const second = await f.start("v2"), secondProcessing = await f.process(second, [{ text: "新版本🧪", start_ms: 0, end_ms: 1000 }]);
  const index = f.engine.indexChunks;
  f.engine.indexChunks = async () => { throw new Error("QA injected index failure"); };
  await assert.rejects(f.engine.video.importManifest(S, second.receipt.video_job_id, secondProcessing.manifest, secondProcessing.st), /QA injected index failure/);
  assert.equal((await f.engine.getRevision(S, ready.document_id, 1)).body, canonical.body);
  assert.equal((await f.db.query("SELECT current_revision FROM flow_documents WHERE id=$1", [ready.document_id])).rows[0].current_revision, 1);
  f.engine.indexChunks = index;
  const retried = await f.engine.video.importManifest(S, second.receipt.video_job_id, secondProcessing.manifest, secondProcessing.st);
  assert.equal(retried.revision, 2);
  await f.engine.video.importManifest(S, second.receipt.video_job_id, secondProcessing.manifest, secondProcessing.st);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM flow_outbox WHERE type='video.knowledge_ready'")).rows[0].n, 2);
  assert.equal(canonicalHash(processing.manifest), canonicalHash(structuredClone(processing.manifest)));
});

test("QA K009: human correction uses CAS, preserves old UTF16 evidence and reuses atomic index barrier", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const input = await f.start(), processing = await f.process(input);
  const ready = await f.engine.video.importManifest(S, input.receipt.video_job_id, processing.manifest, processing.st);
  const old = await f.engine.getRevision(S, ready.document_id, ready.revision);
  const ev = (await f.db.query("SELECT * FROM flow_evidence WHERE document_id=$1 AND revision=1", [ready.document_id])).rows[0];
  const reviewer = { ...S, scopes: ["intel.knowledge.review"] };
  const patch = { expected_revision: 1, expected_content_hash: old.content_hash, reason: "Synthetic human correction fixture, not industry review", patches: [{ evidence_id: ev.id, text: "人工修订😀完整材料" }] };
  await assert.rejects(f.engine.video.correct(S, input.receipt.video_job_id, "no-review-scope", patch), (e: any) => e.status === 403);
  await assert.rejects(f.engine.video.correct(reviewer, input.receipt.video_job_id, "stale", { ...patch, expected_content_hash: "a".repeat(64) }), (e: any) => e.status === 409);
  await assert.rejects(f.engine.video.correct(reviewer, input.receipt.video_job_id, "outside-duration", { ...patch, patches: [{ ...patch.patches[0], start_ms: 0, end_ms: 60000 }] }), (e: any) => e.status === 422);
  const index = f.engine.indexChunks;
  f.engine.indexChunks = async () => { throw new Error("QA correction index fault"); };
  await assert.rejects(f.engine.video.correct(reviewer, input.receipt.video_job_id, "correct", patch), /QA correction index fault/);
  assert.equal((await f.db.query("SELECT current_revision FROM flow_documents WHERE id=$1", [ready.document_id])).rows[0].current_revision, 1);
  f.engine.indexChunks = index;
  const corrected = await f.engine.video.correct(reviewer, input.receipt.video_job_id, "correct", patch);
  assert.equal(corrected.document_id, ready.document_id); assert.equal(corrected.revision, 2);
  assert.equal((await f.engine.getRevision(S, ready.document_id, 1)).body, old.body);
  assert.equal((await f.engine.getRevision(S, ready.document_id, 2)).body, "人工修订😀完整材料");
  const oldAgain = (await f.db.query("SELECT quote,snippet_hash FROM flow_evidence WHERE id=$1", [ev.id])).rows[0];
  assert.equal(oldAgain.quote, ev.quote); assert.equal(oldAgain.snippet_hash, ev.snippet_hash);
  assert.equal((await f.engine.video.correct(reviewer, input.receipt.video_job_id, "correct", patch)).video_job_id, corrected.video_job_id);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_corrections")).rows[0].n, 1);
});

test("QA cross-language media: real signed Python HTTP/SQLite/FFmpeg through Loom input and ready barriers", { timeout: 45_000 }, async t => {
  const key = "qa-cross-language-key-32-characters", token = "qa-only-service-token";
  const process = spawn("python3", ["-u", "../video-knowledge/qa_fixture_service.py"], { env: { ...globalThis.process.env, VIDEO_QA_SIGNING_KEY: key, VIDEO_QA_SERVICE_TOKEN: token, VIDEO_QA_CHANGE_ON_SECOND_REFRESH: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; process.stderr.on("data", b => { stderr += b.toString(); });
  t.after(async () => {
    if (process.exitCode === null) { process.kill("SIGTERM"); await new Promise<void>(resolve => process.once("exit", () => resolve())); }
  });
  const lines = createInterface({ input: process.stdout });
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Python startup deadline: ${stderr}`)), 10_000);
    lines.once("line", line => { clearTimeout(timer); resolve(line); });
    process.once("exit", code => { clearTimeout(timer); reject(new Error(`Python exited ${code}: ${stderr}`)); });
  });
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  let now = new Date(); const f = await fixture(undefined, () => now, { processing_mode: "full_video", required_capabilities: ["transcript", "vision", "ocr", "vlm"], frame_interval_ms: 1000, max_frames: 10 }); t.after(() => f.db.close());
  f.engine.video.provider = new HTTPVideoProvider(endpoint, token, key);
  const receipt = await f.engine.video.start(S, "cross-language", { source_id: f.source.id });
  const states: string[] = []; let job: any;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await f.engine.video.workOnce("cross-language-worker");
    job = await f.engine.video.get(S, receipt.video_job_id); states.push(`${job.state}:${job.completion_level}`);
    if (["completed", "completed_with_gaps", "failed", "blocked_auth", "reconciliation_required"].includes(job.state)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
    now = new Date(now.getTime() + 6_000);
  }
  assert.equal(job?.completion_level, "knowledge_ready", `${JSON.stringify(job)} states=${states.join(",")} stderr=${stderr}`);
  assert.ok(states.some(s => s.endsWith(":input_ready")), "input stage is separately observable before processing");
  const revision = await f.engine.getRevision(S, job.document_id, job.revision);
  assert.ok(revision.body.includes("跨语言契约夹具😀"));
  assert.ok(revision.body.includes("视觉夹具".repeat(600)), "full long OCR must survive canonical evidence import");
  const objects = (await f.db.query("SELECT content_type FROM flow_video_objects WHERE video_job_id=$1", [job.video_job_id])).rows;
  assert.ok(objects.some(x => x.content_type === "video/mp4"));
  const event = (await f.db.query("SELECT payload FROM flow_outbox WHERE type='video.knowledge_ready' AND job_id=$1", [job.video_job_id])).rows;
  assert.equal(event.length, 1);
  const http = createServer(handler(f.engine, { signingKey: key, audience: "loom-engine", issuer: "flow-platform" }));
  http.listen(0, "127.0.0.1"); await once(http, "listening"); t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const base = `http://127.0.0.1:${(http.address() as any).port}`;
  const get = (path: string, scope = S, extra: Record<string, string> = {}, scopes = ["intel.video.read"]) => fetch(base + path, { headers: { authorization: "Bearer " + sign(key, { ...scope, iss: "flow-platform", aud: "loom-engine", scopes }), ...extra } });
  const visual: any[] = []; let cursor: string | null = "0";
  while (cursor !== null) {
    const response = await get(`/v1/video/jobs/${job.video_job_id}/result?kind=visual&cursor=${cursor}&limit=2`);
    const raw = await response.text(); assert.equal(response.status, 200, raw);
    const page = JSON.parse(raw).data; assert.ok(page.items.length <= 2); assert.ok(Buffer.byteLength(raw) <= 6500, "bounded visual result page");
    visual.push(...page.items); assert.notEqual(page.next_cursor, cursor); cursor = page.next_cursor;
  }
  for (const kind of ["frame", "ocr", "model_observation", "model_inference", "alignment"]) assert.ok(visual.some(item => item.type === kind), `missing typed visual ${kind}`);
  assert.equal(new Set(visual.map(item => item.record_id)).size, visual.length, "no duplicate records across pages");
  assert.ok(visual.some(item => item.type === "ocr" && item.text_complete === false && item.review_status === "unreviewed"));
  const longOCR = visual.find(item => item.type === "ocr" && item.text_complete === false);
  let restoredOCR = longOCR.text, textOffset = longOCR.next_text_offset;
  while (textOffset !== null) {
    const response = await get(`/v1/video/jobs/${job.video_job_id}/result?kind=visual&cursor=${longOCR.read_ref.cursor}&limit=1&text_offset=${textOffset}`);
    const raw = await response.text(); assert.equal(response.status, 200, raw);
    const item = JSON.parse(raw).data.items[0]; assert.equal(item.record_id, longOCR.record_id); assert.equal(item.text_offset, textOffset);
    restoredOCR += item.text; assert.notEqual(item.next_text_offset, textOffset); textOffset = item.next_text_offset;
  }
  assert.equal(restoredOCR, "视觉夹具".repeat(600), "bounded fixed-record continuation must preserve the full OCR tail");
  for (const item of visual.filter(item => item.type.startsWith("model_"))) { assert.equal(item.derived, true); assert.equal(item.review_status, "unreviewed"); }
  assert.ok(visual.some(item => item.type === "alignment" && item.relation === "unaligned" && item.semantic_relation === "not_assessed"));
  const mediaResponse = await get(`/v1/video/jobs/${job.video_job_id}/result?kind=media`);
  assert.equal(mediaResponse.status, 200); const mediaPage = (await mediaResponse.json()).data;
  const video = mediaPage.items.find((item: any) => item.content_type === "video/mp4"); assert.ok(video);
  assert.ok(!JSON.stringify(mediaPage).includes("tenants/"), "public media descriptors must not expose internal object keys");
  const mediaPath = `/v1/video/jobs/${job.video_job_id}/media/${video.object_id}`;
  const full = await get(mediaPath); assert.equal(full.status, 200); const fullBytes = new Uint8Array(await full.arrayBuffer()); assert.equal(fullBytes.length, video.bytes);
  const ranged = await get(mediaPath, S, { range: "bytes=0-15" }); assert.equal(ranged.status, 206); assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), fullBytes.slice(0, 16));
  const suffix = await get(mediaPath, S, { range: "bytes=-16" }); assert.equal(suffix.status, 206); assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), fullBytes.slice(-16));
  for (const range of ["bytes=0-1,3-4", "bytes=-0", `bytes=${video.bytes}-`]) assert.equal((await get(mediaPath, S, { range })).status, 416);
  assert.equal((await get(mediaPath, FOREIGN)).status, 404);
  assert.equal((await get(mediaPath, S, {}, [])).status, 403);
  const frameItem = visual.find(item => item.type === "frame" && item.frame_media?.available);
  assert.ok(frameItem?.frame_media?.object_id, "visual frame must resolve to an authorized lazy media descriptor");
  const imageObject = (await f.db.query("SELECT * FROM flow_video_objects WHERE video_job_id=$1 AND object_id=$2", [job.video_job_id, frameItem.frame_media.object_id])).rows[0];
  await f.engine.video.provider.deleteObject!(S, job.video_job_id, imageObject.object_key, imageObject.sha256);
  const missingPath = `/v1/video/jobs/${job.video_job_id}/media/${frameItem.frame_media.object_id}`;
  assert.equal((await get(missingPath)).status, 404, "physically missing immutable object must not pretend to stream");
  assert.equal((await f.db.query("SELECT state FROM flow_video_objects WHERE video_job_id=$1 AND object_id=$2", [job.video_job_id, frameItem.frame_media.object_id])).rows[0].state, "missing");
  const afterMissing = await get(`/v1/video/jobs/${job.video_job_id}/result?kind=media`);
  assert.ok(!(await afterMissing.json()).data.items.some((item: any) => item.object_id === frameItem.frame_media.object_id), "missing object must not retain an advertised download link");
  const repair = await f.engine.video.repair(S, job.video_job_id, "qa-repair-missing-frame");
  assert.notEqual(repair.video_job_id, job.video_job_id, "repair is explicit new work, not mutation of historical processing receipts");
  assert.equal((await f.engine.video.repair(S, job.video_job_id, "qa-repair-missing-frame")).video_job_id, repair.video_job_id);
  assert.equal((await f.engine.video.repair(S, job.video_job_id, "qa-repair-other-click")).video_job_id, repair.video_job_id, "same missing immutable objects deduplicate repeated clicks");
  let repaired: any; const repairDeadline = Date.now() + 20_000;
  while (Date.now() < repairDeadline) {
    await f.engine.video.workOnce("qa-explicit-repair-worker");
    repaired = await f.engine.video.get(S, repair.video_job_id);
    if (["completed", "completed_with_gaps", "failed", "blocked_auth", "reconciliation_required"].includes(repaired.state)) break;
    await new Promise(resolve => setTimeout(resolve, 200)); now = new Date(now.getTime() + 6_000);
  }
  assert.equal(repaired.completion_level, "knowledge_ready", JSON.stringify(repaired));
  assert.equal(repaired.coverage.repair.status, "restored"); assert.equal(repaired.coverage.repair.restored, 1);
  const fixed = await get(missingPath); assert.equal(fixed.status, 200); assert.equal(sha(new Uint8Array(await fixed.arrayBuffer())), imageObject.sha256, "old opaque frame reference only accepts an exact hash/size/type replica");
  assert.equal((await f.engine.getRevision(S, job.document_id, job.revision)).body, revision.body, "repair cannot rewrite an old cited revision");
  const secondFrame = visual.find(item => item.type === "frame" && item.frame_media?.available && item.frame_media.object_id !== frameItem.frame_media.object_id);
  assert.ok(secondFrame);
  const secondObject = (await f.db.query("SELECT * FROM flow_video_objects WHERE video_job_id=$1 AND object_id=$2", [job.video_job_id, secondFrame.frame_media.object_id])).rows[0];
  await f.engine.video.provider.deleteObject!(S, job.video_job_id, secondObject.object_key, secondObject.sha256);
  const secondPath = `/v1/video/jobs/${job.video_job_id}/media/${secondFrame.frame_media.object_id}`;
  assert.equal((await get(secondPath)).status, 404);
  const changed = await f.engine.video.repair(S, job.video_job_id, "qa-repair-changed-media");
  let changedJob: any; const changedDeadline = Date.now() + 20_000;
  while (Date.now() < changedDeadline) {
    await f.engine.video.workOnce("qa-changed-source-repair-worker");
    changedJob = await f.engine.video.get(S, changed.video_job_id);
    if (["completed", "completed_with_gaps", "failed", "blocked_auth", "reconciliation_required"].includes(changedJob.state)) break;
    await new Promise(resolve => setTimeout(resolve, 200)); now = new Date(now.getTime() + 6_000);
  }
  assert.equal(changedJob.completion_level, "knowledge_ready", JSON.stringify(changedJob));
  assert.equal(changedJob.coverage.repair.status, "changed_media"); assert.equal(changedJob.coverage.repair.restored, 0);
  assert.equal((await get(secondPath)).status, 404, "changed source media must never rebind an old immutable frame reference");
  assert.equal((await f.engine.getRevision(S, job.document_id, job.revision)).body, revision.body);
  const originalJob = await f.engine.video.job(S, job.video_job_id);
  const external = (await f.db.query("SELECT external_task_id FROM flow_video_submission_intents WHERE video_job_id=$1 AND stage='process'", [job.video_job_id])).rows[0].external_task_id;
  const reviewer = { ...S, scopes: ["intel.sources.write"] } as any;
  await new VideoKnowledgeService(f.engine).retention(reviewer, "qa-real-worker-erasure", { action: "erased", asset_id: job.asset_id, reason: "Synthetic erasure integration" });
  assert.equal((await get(mediaPath)).status, 403, "previously issued media path must recheck current grant");
  await f.engine.video.maintain(100);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_objects WHERE video_job_id=$1 AND state<>'deleted'", [job.video_job_id])).rows[0].n, 0);
  assert.ok((await f.db.query("SELECT execution_erased_at FROM flow_video_jobs WHERE id=$1", [job.video_job_id])).rows[0].execution_erased_at, "actual worker erase receipt must precede host cleanup completion");
  await assert.rejects(f.engine.getRevision(S, job.document_id, job.revision), (e: any) => e.status === 404);
  await assert.rejects(f.engine.video.provider.poll(originalJob, { attempt: 99, fencing_token: 99 }, external), (e: any) => [404, 410].includes(e.status));
  t.diagnostic(`mode=fixture-platform-ASR-OCR-VLM; actual Python execution/SQLite/FFmpeg and Loom HTTP typed visual/media pagination/Range/authorization; not model quality/billing; operation_id=${receipt.operation_id}, video_job_id=${job.video_job_id}`);
});

test("QA R25/K025 PostgreSQL: pre-erasure backup cannot resurrect data before latest external journal replay", {
  skip: !process.env.FLOW_VIDEO_TEST_PG_URL || process.env.FLOW_VIDEO_RESTORE_TEST !== "1" ? "isolated PostgreSQL and explicit restore fixture opt-in required" : false,
}, async t => {
  const journal = await import("./video-journal.ts");
  const { applyVideoRetention } = await import("./video-knowledge.ts");
  const directory = await mkdtemp(join(tmpdir(), "knowhow-restore-qa-"));
  const objectDirectory = join(directory, "objects"), objectBackup = join(directory, "backup-objects");
  await mkdir(objectDirectory);
  const sourceURL = process.env.FLOW_VIDEO_TEST_PG_URL!;
  const source = await pgDb(sourceURL);
  const cloneName = `qa_restore_${Date.now()}_${process.pid}`;
  const targetURL = new URL(sourceURL); targetURL.pathname = `/${cloneName}`;
  let restored: Db | undefined;
  t.after(async () => {
    if (restored) await restored.close();
    await source.query(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`);
    await source.close(); await rm(directory, { recursive: true, force: true });
  });
  const f = await fixture(source);
  const journalConfig = f.journalConfig;
  await journal.replayVideoRetentionJournal(f.engine);
  const input = await f.start("restore-pre-erase"), processing = await f.process(input, [{ text: "PRIVATE_RESTORE_CANARY 😀", start_ms: 0, end_ms: 1000 }]);
  const ready = await f.engine.video.importManifest(S, input.receipt.video_job_id, processing.manifest, processing.st);
  const actualJob = (await source.query("SELECT * FROM flow_video_jobs WHERE id=$1", [ready.video_job_id])).rows[0];
  for (const [key, bytes] of f.bytes) await writeFile(join(objectDirectory, sha(key)), bytes);
  f.provider.readObject = async (_scope, _job, key) => readFile(join(objectDirectory, sha(key)));
  f.provider.deleteObject = async (_scope, _job, key, digest) => { await unlink(join(objectDirectory, sha(key))).catch((e: any) => { if (e.code !== "ENOENT") throw e; }); return { deleted: true, sha256: digest }; };
  f.provider.eraseJob = async (_scope, jobId) => ({ erased: true, video_job_id: jobId });
  const context: any = { ...S, scopes: ["intel.sources.write", "intel.documents.read", "intel.evidence.read", "intel.video.read", "intel.knowledge.read", "intel.knowledge.research", "intel.knowledge.write", "intel.knowledge.review", "intel.knowledge.publish", "intel.research"] };
  const method = { id: "video-knowledge-core", version: "1.0.0", hash: "a".repeat(64) };
  configureVideoKnowledge(f.engine, { resolveBase: async () => ({ ...method, required_tools: ["intel_search_knowledge"] }) });
  const knowledge = new VideoKnowledgeService(f.engine);
  const evidence = (await source.query("SELECT id,revision,snippet_hash FROM flow_evidence WHERE document_id=$1 AND revision=$2", [ready.document_id, ready.revision])).rows[0];
  const ref = { evidence_id: evidence.id, revision: evidence.revision, snippet_hash: evidence.snippet_hash };
  let unit = await knowledge.create(context, "restore-candidate", { profile_id: f.profile.id, profile_version: f.profile.version, method,
    unit: { type: "fact", title: "Synthetic restore fixture", domain_tags: ["qa-only"], statement: "PRIVATE_RESTORE_CANARY", claim_kind: "source_statement", evidence: [ref],
      applicability: [], conditions: [], steps: [], parameters: [], boundaries: [], counterexamples: [], missing_fields: ["real_industry_review"] } });
  const expected = () => ({ expected_version: unit.version, expected_hash: unit.content_hash, reason: "Synthetic review, not human business acceptance" });
  unit = await knowledge.review(context, unit.id, "restore-submit", { ...expected(), decision: "submit" });
  unit = await knowledge.review(context, unit.id, "restore-approve", { ...expected(), decision: "approve", checks: { evidence_support: true, critical_fields: true } });
  unit = await knowledge.publish(context, unit.id, "restore-publish", expected());
  const reader = { ...context, actor: { type: "service_principal", id: "video-skill-reader" }, job_id: "qa-restored-run" };
  const snapshot = await knowledge.pinSnapshot(reader, { run_id: reader.job_id, method });
  assert.equal((await knowledge.get(context, unit.id, true, snapshot.id)).id, unit.id);
  // A fixture installed row exercises the real current-dependency check; it is
  // deliberately not evidence of an actual deployment or human skill approval.
  const pin = { skill_id: "qa-restored-skill", version: "1.0.0", hash: "b".repeat(64) };
  const dependency = { release_id: unit.release_id, knowledge_id: unit.id, version: unit.version, content_hash: unit.content_hash };
  await source.query(`INSERT INTO flow_video_skill_candidates(id,tenant_id,workspace_id,skill_id,skill_version,candidate_hash,native_skill_hash,proposal,state,created_by)
    VALUES('qa_restore_candidate',$1,$2,$3,$4,$5,$6,$7,'workspace_installed','qa-fixture')`, [S.tenant_id, S.workspace_id, pin.skill_id, pin.version, "c".repeat(64), pin.hash, JSON.stringify({ knowledge_releases: [dependency], evidence: [ref] })]);
  await source.query(`INSERT INTO flow_video_skill_dependencies(tenant_id,workspace_id,candidate_id,release_id,knowledge_id,version,content_hash) VALUES($1,$2,'qa_restore_candidate',$3,$4,$5,$6)`, [S.tenant_id, S.workspace_id, unit.release_id, unit.id, unit.version, unit.content_hash]);
  assert.equal((await new VideoKnowledgeSkills(knowledge).checkPin(reader, pin)).available, true);
  const rssSource = await f.engine.createSource(S, { kind: "rss", url: "https://example.invalid/qa-rss.xml" });
  const previousFetcher = f.engine.fetcher;
  f.engine.fetcher = async () => [{ external_id: "qa-rss-independent", title: "RSS baseline", body: "RSS_BASELINE_CANARY", url: "https://example.invalid/qa-rss-item", published_at: new Date().toISOString() }];
  await f.engine.requestCollection(S, "restore-rss-baseline", { source_ids: [rssSource.id] });
  await f.engine.workOnce("qa-rss-worker"); f.engine.fetcher = previousFetcher;
  const rssDocument = (await f.engine.listDocuments(S, { source_id: rssSource.id })).find((d: any) => d.source_id === rssSource.id);
  assert.ok(rssDocument); assert.equal((await f.engine.getRevision(S, rssDocument.id, 1)).body, "RSS_BASELINE_CANARY");
  const reports = new Reports(f.engine);
  const videoResearch: any = await reports.startResearch(S, "restore-video-research", { parent_run_id: "qa-restore-parent", question: "PRIVATE_RESTORE_CANARY", evidence_scope: { document_ids: [ready.document_id] } });
  const rssResearch: any = await reports.startResearch(S, "restore-rss-research", { parent_run_id: "qa-restore-parent", question: "RSS_BASELINE_CANARY", evidence_scope: { document_ids: [rssDocument.id] } });
  assert.equal(videoResearch.status, "succeeded"); assert.equal(rssResearch.status, "succeeded");
  assert.ok(videoResearch.output.claims.length > 0); assert.ok(rssResearch.output.claims.length > 0);
  const videoReport = await reports.saveReport(S, "user:qa_reviewer", "restore-video-report", { title: "PRIVATE_RESTORE_CANARY report", body: "PRIVATE_RESTORE_CANARY", material_scope: { document_ids: [ready.document_id] }, claims: videoResearch.output.claims, research_run_id: videoResearch.id });
  const rssReport = await reports.saveReport(S, "user:qa_reviewer", "restore-rss-report", { title: "RSS report", body: "RSS_BASELINE_CANARY", material_scope: { document_ids: [rssDocument.id] }, claims: rssResearch.output.claims, research_run_id: rssResearch.id });
  const pendingSource = await f.engine.createSource(S, { kind: "bilibili", title: "Unfinished restore fixture", url: "https://www.bilibili.com/video/BV1PENDING001",
    config: { source_type: "video", native_id: "BV1PENDING001", profile_id: f.profile.id, profile_version: f.profile.version,
      usage_basis: "Self-authored recovery fixture; no platform", allowed_uses: ["knowledge"] } });
  const pendingJob = await f.engine.video.start(S, "pending-before-real-backup", { source_id: pendingSource.id });
  const pendingLease = await f.engine.video.claim("worker-before-backup");
  assert.equal(pendingLease.video_job_id, pendingJob.video_job_id);
  const execute = promisify(execFile), scripts = fileURLToPath(new URL("../../../deploy/flow/backup/", import.meta.url));
  const scriptEnvironment = { ...process.env, VIDEO_DELETION_JOURNAL_DIR: journalConfig.directory, VIDEO_DELETION_JOURNAL_ID: journalConfig.journalId,
    VIDEO_DELETION_JOURNAL_KEY: journalConfig.key, VIDEO_JOURNAL_OFFLINE_ACK: "ALL_JOURNAL_CLIENTS_STOPPED" };
  const backup = await execute("bash", [join(scripts, "backup.sh"), sourceURL, join(directory, "db-backup")], { env: scriptEnvironment });
  const dump = backup.stdout.trim().split("\n").at(-1)!;
  assert.ok(dump.endsWith(".dump"));
  assert.equal(JSON.parse(await readFile(dump.replace(/\.dump$/, ".video-journal.json"), "utf8")).sequence, 0);
  await cp(objectDirectory, objectBackup, { recursive: true });
  await knowledge.retention(context, "erase-after-backup", { action: "erased", asset_id: actualJob.asset_id, reason: "QA authoritative deletion after old backup" });
  assert.equal((await source.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='flow_video_deletion_journal_receipts'::regclass")).rows[0].relforcerowsecurity, true);
  await withTenant("qa_foreign_journal_tenant", async () => {
    assert.equal((await source.query("SELECT count(*)::int n FROM flow_video_deletion_journal_receipts")).rows[0].n, 0, "FORCE RLS hides authoritative receipt metadata from another tenant even when the application role owns the table");
  });
  await f.engine.video.maintain(100);
  await assert.rejects(f.engine.getRevision(context, ready.document_id, ready.revision), (e: any) => e.status === 404);
  await assert.rejects(readFile(join(objectDirectory, sha(processing.manifest.objects[0].object_key))), (e: any) => e.code === "ENOENT");
  await source.query(`CREATE DATABASE "${cloneName}"`);
  await assert.rejects(execute("bash", [join(scripts, "restore.sh"), dump, targetURL.toString()], { env: { ...scriptEnvironment, VIDEO_JOURNAL_OFFLINE_ACK: "" } }), (e: any) => e.code === 2, "operator restore must require stopped-client acknowledgement");
  const checkpointFile = dump.replace(/\.dump$/, ".video-journal.json");
  await rename(checkpointFile, checkpointFile + ".hidden");
  await assert.rejects(execute("bash", [join(scripts, "restore.sh"), dump, targetURL.toString()], { env: scriptEnvironment }), (e: any) => e.code === 2, "missing authoritative sidecar must reject before restoring data");
  await rename(checkpointFile + ".hidden", checkpointFile);
  const untouchedTarget = await pgDb(targetURL.toString());
  assert.equal((await untouchedTarget.query("SELECT to_regclass('public.flow_documents') AS name")).rows[0].name, null);
  await untouchedTarget.close();
  const restoration = await execute("bash", [join(scripts, "restore.sh"), dump, targetURL.toString()], { env: scriptEnvironment });
  assert.match(restoration.stdout, /VIDEO QUARANTINED/);
  await cp(objectBackup, objectDirectory, { recursive: true });
  restored = await pgDb(targetURL.toString());
  // Negative control: the old snapshot genuinely contains data and no later
  // tombstone. We do not mistake a backup made after erase for this requirement.
  assert.equal((await restored.query("SELECT body FROM flow_document_revisions WHERE document_id=$1 AND revision=$2", [ready.document_id, ready.revision])).rows[0].body, "PRIVATE_RESTORE_CANARY 😀");
  assert.equal((await restored.query("SELECT count(*)::int n FROM flow_video_deletion_tombstones WHERE document_id=$1", [ready.document_id])).rows[0].n, 0);
  assert.ok((await readFile(join(objectDirectory, sha(processing.manifest.objects[0].object_key)))).includes(Buffer.from("PRIVATE_RESTORE_CANARY")));
  const engine = new Engine(restored, undefined, () => new Date(Date.now() + 120000)); engine.video.enabled = true; engine.video.provider = f.provider;
  configureVideoKnowledge(engine, { resolveBase: async () => ({ ...method, required_tools: ["intel_search_knowledge"] }) });
  journal.configureVideoRetentionJournal(engine, journalConfig, (q, event) => applyVideoRetention(engine, q, event, event));
  const signingKey = "s".repeat(48), server = createServer(handler(engine, { signingKey, audience: "loom-engine", issuer: "flow-platform" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (path: string, body?: any) => fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${sign(signingKey, { ...context, iss: "flow-platform", aud: "loom-engine" })}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const revisionPath = `/v1/documents/${ready.document_id}/revisions/${ready.revision}`;
  const offline = journalConfig.directory + ".offline";
  await rename(journalConfig.directory, offline);
  const quarantined = await request(revisionPath);
  assert.ok([404, 503].includes(quarantined.status), "restored process must deny video when latest journal cannot be consulted before its first read");
  assert.ok(!(await quarantined.text()).includes("PRIVATE_RESTORE_CANARY"));
  assert.equal((await request(`/v1/video/jobs/${ready.video_job_id}/artifacts`)).status, 503, "video-specific route reports unavailable authoritative history");
  const rssResponse = await request(`/v1/documents/${rssDocument.id}/revisions/1`);
  assert.equal(rssResponse.status, 200, "quarantining restored video must not disable unrelated RSS material");
  assert.equal((await rssResponse.json() as any).data.body, "RSS_BASELINE_CANARY");
  assert.equal((await request(`/v1/reports/${videoReport.report_id}`)).status, 404);
  assert.equal((await request(`/v1/research-runs/${videoResearch.id}`)).status, 404);
  assert.equal((await request(`/v1/reports/${rssReport.report_id}`)).status, 200);
  assert.equal((await request(`/v1/research-runs/${rssResearch.id}`)).status, 200);
  await assert.rejects(journal.replayVideoRetentionJournal(engine));
  assert.equal((await request(`/v1/video/jobs/${ready.video_job_id}/artifacts`)).status, 503, "unavailable authoritative journal cannot be replaced by old DB watermark");
  await rename(offline, journalConfig.directory);
  await journal.replayVideoRetentionJournal(engine);
  assert.equal((await request(revisionPath)).status, 404);
  const restoredKnowledge = new VideoKnowledgeService(engine);
  assert.equal((await restoredKnowledge.list(context, { q: "PRIVATE_RESTORE_CANARY" }, true)).items.length, 0);
  assert.equal((await restoredKnowledge.research(context, { document_ids: [ready.document_id] })).items.length, 0);
  await assert.rejects(restoredKnowledge.get(context, unit.id, true, snapshot.id), (e: any) => e.status === 404);
  await assert.rejects(restoredKnowledge.resolveEvidence(context, [ref]));
  await assert.rejects(new VideoKnowledgeSkills(restoredKnowledge).checkPin(reader, pin), (e: any) => e.status === 409);
  await assert.rejects(engine.video.rawObject(context, ready.video_job_id, processing.manifest.objects[0].object_key), (e: any) => [403, 404].includes(e.status));
  assert.equal((await request(`/v1/reports/${videoReport.report_id}`)).status, 404);
  assert.equal((await request(`/v1/research-runs/${videoResearch.id}`)).status, 404);
  assert.equal((await restored.query("SELECT body FROM flow_reports WHERE id=$1", [videoReport.report_id])).rows[0].body, "");
  assert.equal((await restored.query("SELECT output FROM flow_research_runs WHERE id=$1", [videoResearch.id])).rows[0].output, null);
  const obsoleteNotices = (await restored.query("SELECT payload,delivered_at FROM flow_outbox WHERE job_id=ANY($1::text[]) AND type IN ('report.completed','research.completed')", [[videoReport.report_id, videoResearch.id]])).rows;
  assert.ok(obsoleteNotices.length > 0);
  for (const event of obsoleteNotices) { assert.ok(event.delivered_at); assert.ok(!JSON.stringify(event.payload).includes("PRIVATE_RESTORE_CANARY")); }
  assert.equal((await restored.query("SELECT body FROM flow_document_revisions WHERE document_id=$1 AND revision=$2", [ready.document_id, ready.revision])).rows[0].body, "");
  const revocations = (await restored.query("SELECT payload FROM flow_outbox WHERE type='knowledge.dependencies_revoked'")).rows;
  assert.ok(revocations.some(x => x.payload.video_job_ids.includes(ready.video_job_id)), "replay must notify host/worker derived caches, not only scrub Loom");
  await engine.video.maintain(100);
  await assert.rejects(readFile(join(objectDirectory, sha(processing.manifest.objects[0].object_key))), (e: any) => e.code === "ENOENT");
  await journal.replayVideoRetentionJournal(engine);
  assert.equal((await request(revisionPath)).status, 404, "replay must be idempotent");
  const resumedLease = await engine.video.claim("worker-after-real-restore");
  assert.equal(resumedLease.video_job_id, pendingJob.video_job_id);
  assert.ok(Number(resumedLease.fencing_token) > Number(pendingLease.fencing_token));
  await assert.rejects(engine.video.heartbeat(pendingLease), (e: any) => e.reason === "STALE_FENCE");
  const restoredObject = async (name: string, value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value)), digest = sha(raw), key = `tenants/${S.tenant_id}/workspaces/${S.workspace_id}/video/${pendingJob.video_job_id}/${digest}/${name}`;
    await writeFile(join(objectDirectory, sha(key)), raw);
    return { object_key: key, sha256: digest, bytes: raw.length, content_type: "application/json" };
  };
  const resumedSegments = [{ text: "Self-authored pending job resumed after restore 😀", start_ms: 0, end_ms: 1000 }];
  const resumedInput = await restoredObject("input.json", { kind: "manual", language: "en", segments: resumedSegments });
  const resumedInputManifest: VideoManifest = { schema_version: 1, artifact_stage: "input_ready", video_job_id: pendingJob.video_job_id,
    stage_attempt: resumedLease.attempt, fencing_token: Number(resumedLease.fencing_token), input_kind: "platform_subtitles", input_hash: resumedInput.sha256,
    media_sha256: null, availability: "not_acquired", objects: [resumedInput], coverage: { required: [], completed: [], missing: [] }, processors: { version: "restore-fixture-v1" } };
  const inputReceipt = await engine.video.importManifest(S, pendingJob.video_job_id, resumedInputManifest, resumedLease);
  const resumedProcess = await engine.video.claim("process-after-real-restore");
  assert.equal(resumedProcess.video_job_id, pendingJob.video_job_id);
  const resumedText = await restoredObject("segments.json", { segments: resumedSegments });
  const resumedManifest: VideoManifest = { ...resumedInputManifest, artifact_stage: "processing_complete", stage_attempt: resumedProcess.attempt,
    fencing_token: Number(resumedProcess.fencing_token), parent_manifest_sha256: inputReceipt.manifest_sha256, objects: [resumedText],
    transcript: { parts: [{ object_key: resumedText.object_key, sha256: resumedText.sha256, segment_count: 1, start_ms: 0, end_ms: 1000 }] },
    coverage: { required: ["transcript"], completed: ["transcript"], missing: [], duration_ms: 1000 } };
  const resumedReady = await engine.video.importManifest(S, pendingJob.video_job_id, resumedManifest, resumedProcess);
  assert.equal(resumedReady.completion_level, "knowledge_ready");
  assert.equal((await engine.getRevision(S, resumedReady.document_id, resumedReady.revision)).body, resumedSegments[0].text);
  assert.equal((await request(revisionPath)).status, 404, "resuming unrelated work cannot resurrect erased historical text");
  t.diagnostic("actual non-superuser pg_dump before erase + pg_restore; actual filesystem object snapshot restore; external journal quarantine/replay; pre-backup unfinished lease reclaimed/fenced and completed after restore; synthetic source/model/review only");
});

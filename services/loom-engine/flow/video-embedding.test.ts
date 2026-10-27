import { test } from "node:test";
import assert from "node:assert/strict";
import { pgliteDb, migrate } from "./db.ts";
import { Engine } from "./engine.ts";
import { canonicalHash, canonicalTranscript, sha } from "./video-contract.ts";
import { configureVideoKnowledge } from "./video-knowledge-runtime.ts";
import { VideoEmbeddingService, enqueueVideoEmbedding, loadVideoEmbedding, commitVideoEmbeddings, retryVideoEmbedding } from "./video-embedding.ts";

const scope = { tenant_id: "tenant", workspace_id: "workspace" };
async function setup(required = true, text = "Bounded development fixture 😀. ".repeat(100), config: any = {}) {
  const db = await pgliteDb(); await migrate(db);
  const engine = new Engine(db, async () => [], () => new Date("2026-10-26T00:00:00Z"));
  const profile = { required_capabilities: required ? ["transcript", "embedding"] : ["transcript"], optional_capabilities: required ? [] : ["embedding"], embedding_model_id: "fixture-embedding", embedding_budget_micro: 10000, embedding_dimensions: 3, ...config };
  await db.query(`INSERT INTO flow_video_profiles(id,tenant_id,workspace_id,version,name,config,content_hash,created_by) VALUES('profile',$1,$2,1,'Fixture',$3,$4,'fixture')`, [scope.tenant_id, scope.workspace_id, JSON.stringify(profile), canonicalHash(profile)]);
  await db.query(`INSERT INTO flow_sources(id,tenant_id,workspace_id,kind,url,config) VALUES('source',$1,$2,'bilibili','https://www.bilibili.com/video/BVfixture','{"allowed_uses":["knowledge","transcript"]}')`, [scope.tenant_id, scope.workspace_id]);
  await db.query(`INSERT INTO flow_video_assets(id,tenant_id,workspace_id,platform,native_id,canonical_url) VALUES('asset',$1,$2,'bilibili','BVfixture','https://www.bilibili.com/video/BVfixture')`, [scope.tenant_id, scope.workspace_id]);
  await db.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,grant_actor,policy_version,budget_reservation_id)
    VALUES('job','operation',$1,$2,'source','asset','profile',1,'fingerprint',$3,'user:reviewer','fixture','media-parent')`, [scope.tenant_id, scope.workspace_id, JSON.stringify({ title: "Fixture", required_capabilities: profile.required_capabilities })]);
  const job = (await db.query(`SELECT * FROM flow_video_jobs WHERE id='job'`)).rows[0];
  const transcript = canonicalTranscript("Fixture", [{ text, start_ms: 0, end_ms: 1000 }]);
  const manifest: any = { schema_version: 1, artifact_stage: "processing_complete", video_job_id: "job", stage_attempt: 1, fencing_token: 1, input_kind: "platform_subtitles", input_hash: sha("input"), media_sha256: null, availability: "not_acquired", objects: [], coverage: { required: profile.required_capabilities, completed: ["transcript"], missing: [] }, processors: {} };
  const payload = { job, manifest, manifestHash: canonicalHash(manifest), transcript };
  await db.tx(q => enqueueVideoEmbedding(q, scope, payload));
  const claim = async (attempt = 1) => {
    await db.query(`UPDATE flow_video_jobs SET state='running' WHERE id='job'`);
    return (await db.query(`UPDATE flow_video_stages SET state='running',attempt=$1::integer,fencing_token=$1::integer,lease_owner='fixture-worker',lease_expires_at='2026-10-26T01:00:00Z' WHERE video_job_id='job' RETURNING *`, [attempt])).rows[0];
  };
  const service = new VideoEmbeddingService(engine), st = await claim();
  const receipt = (r: any, changes: any = {}) => ({ task_id: `task-${r.key}`, status: "succeeded", reservation_id: "child", cost_micro: 1, model_config_hash: "a".repeat(64), input_hash: canonicalHash(r.input), usage_ref: `model_task:task-${r.key}`,
    output: { model: "fixture-embedding", dimensions: 3, vectors: r.input.texts.map((x: any) => ({ chunk_id: x.chunk_id, sha256: x.sha256, vector: [0.1, 0.2, 0.3] })) }, ...changes });
  const index = async (mutate = false) => db.tx(async q => {
    await q.query(`INSERT INTO flow_documents(id,tenant_id,workspace_id,source_id,external_id,url,title,video_asset_id,video_ready) VALUES('doc',$1,$2,'source','fixture','https://www.bilibili.com/video/BVfixture','Fixture','asset',false) ON CONFLICT DO NOTHING`, [scope.tenant_id, scope.workspace_id]);
    await engine.indexChunks(q, scope, "source", "doc", 1, transcript.text + (mutate ? "tampered" : ""), null);
    return commitVideoEmbeddings(q, scope, job, "doc", 1);
  });
  return { db, engine, job, transcript, payload, st, claim, service, receipt, index };
}

test("K017 embedding fixture: host receipt stages vectors then atomically indexes exact UTF16 chunks", async () => {
  const s = await setup();
  try {
    configureVideoKnowledge(s.engine, { modelTask: async (_, id, purpose, r) => { assert.equal(id, "job"); assert.equal(purpose, "video_embedding"); assert.ok(r.input.texts.length <= 32); return s.receipt(r); } });
    assert.deepEqual(await loadVideoEmbedding(s.db, scope, s.job), { manifest: s.payload.manifest, manifestHash: s.payload.manifestHash, transcript: s.transcript });
    assert.equal(await s.service.workClaim(s.job, s.st), "completed");
    assert.equal((await s.db.query(`SELECT count(*)::int n FROM flow_document_embeddings`)).rows[0].n, 0);
    await assert.rejects(s.index(true), /EMBEDDING_CHUNKS_CHANGED/);
    assert.equal((await s.db.query(`SELECT count(*)::int n FROM flow_document_chunks`)).rows[0].n, 0);
    assert.deepEqual(await s.index(), { completed: true, optional_missing: false });
    assert.equal((await s.db.query(`SELECT count(*)::int n FROM flow_document_embeddings`)).rows[0].n, s.engine.chunkText(s.transcript.text).length);
    assert.deepEqual(await s.db.tx(q => commitVideoEmbeddings(q, scope, s.job, "doc", 1)), { completed: true, optional_missing: false });
    await assert.rejects(loadVideoEmbedding(s.db, { ...scope, workspace_id: "foreign" }, s.job), /EMBEDDING_INPUT_CHANGED/);
    await assert.rejects(s.db.tx(q => enqueueVideoEmbedding(q, scope, { ...s.payload, transcript: { ...s.transcript, text: "changed" } })), /EMBEDDING_INPUT_CHANGED/);
  } finally { await s.db.close(); }
});

test("K017 required stays invisible while pending; invalid vectors and stale lease cannot commit", async () => {
  const s = await setup();
  try {
    configureVideoKnowledge(s.engine, { modelTask: async (_, __, ___, r) => s.receipt(r, { status: "running", output: undefined }) });
    assert.equal(await s.service.workClaim(s.job, s.st), "pending");
    await assert.rejects(s.index(), /EMBEDDING_NOT_VERIFIED/);
    configureVideoKnowledge(s.engine, { modelTask: async (_, __, ___, r) => { const out = s.receipt(r); out.output.vectors[0].sha256 = "0".repeat(64); return out; } });
    await assert.rejects(s.service.workClaim(s.job, s.st), /EMBEDDING_VECTOR_INVALID/);
    await s.claim(2);
    await assert.rejects(s.service.workClaim(s.job, s.st), /STALE_FENCE/);
    assert.equal((await s.db.query(`SELECT count(*)::int n FROM flow_document_embeddings`)).rows[0].n, 0);
  } finally { await s.db.close(); }
});

test("K017 batches cover all chunks and reconcile same-key lost response across lease takeover", async () => {
  const s = await setup(true, "😀".repeat(24000));
  try {
    const requests: any[] = []; let lost = true;
    configureVideoKnowledge(s.engine, { modelTask: async (_, __, ___, r) => { requests.push(structuredClone(r)); if (lost) { lost = false; throw new Error("fixture lost response"); } return s.receipt(r); } });
    await assert.rejects(s.service.workClaim(s.job, s.st), /PROVIDER_UNAVAILABLE/);
    const newer = await s.claim(2);
    assert.equal(await s.service.workClaim(s.job, newer), "pending");
    assert.equal(requests[0].key, requests[1].key);
    assert.equal(canonicalHash(requests[0].input), canonicalHash(requests[1].input));
    assert.equal(requests[0].stage_attempt, 1); assert.equal(requests[1].stage_attempt, 2);
    assert.equal(await s.service.workClaim(s.job, newer), "completed");
    assert.equal(requests[1].input.texts.length, 32);
    assert.ok(requests[2].input.texts.length > 0);
    assert.deepEqual(await s.index(), { completed: true, optional_missing: false });
    const batches = (await s.db.query(`SELECT request FROM flow_video_embedding_batches ORDER BY batch_index`)).rows;
    assert.equal(batches.flatMap(x => x.request.input.texts).map(x => x.text).join(""), s.transcript.text);
    assert.ok(batches.reduce((n, x) => n + x.request.budget_micro, 0) <= 10000);
  } finally { await s.db.close(); }
});

test("K017 optional unavailable is explicit gap, but unknown outcome and model drift never masquerade as success", async () => {
  const optional = await setup(false);
  try {
    assert.equal(await optional.service.workClaim(optional.job, optional.st), "completed");
    assert.deepEqual(await optional.index(), { completed: false, optional_missing: true });
  } finally { await optional.db.close(); }
  const s = await setup(false, "x".repeat(40000));
  try {
    configureVideoKnowledge(s.engine, { modelTask: async (_, __, ___, r) => s.receipt(r, { status: "reconciliation_required" }) });
    await assert.rejects(s.service.workClaim(s.job, s.st), /EXTERNAL_OUTCOME_UNKNOWN/);
    configureVideoKnowledge(s.engine, { modelTask: async (_, __, ___, r) => s.receipt(r) });
    assert.equal(await s.service.workClaim(s.job, s.st), "pending");
    configureVideoKnowledge(s.engine, { modelTask: async (_, __, ___, r) => s.receipt(r, { model_config_hash: "b".repeat(64) }) });
    await assert.rejects(s.service.workClaim(s.job, s.st), /EMBEDDING_MODEL_CHANGED/);
    await s.db.query(`UPDATE flow_sources SET status='revoked' WHERE id='source'`);
    await assert.rejects(s.service.workClaim(s.job, s.st), /AUTH_REQUIRED/);
  } finally { await s.db.close(); }
});

test("K017 explicit retry changes key only after durable definitive failure; unknown stays same task", async () => {
  const s = await setup();
  try {
    configureVideoKnowledge(s.engine, { modelTask: async (_, __, ___, r) => s.receipt(r, { status: "reconciliation_required" }) });
    await assert.rejects(s.service.workClaim(s.job, s.st), /EXTERNAL_OUTCOME_UNKNOWN/);
    assert.equal(await s.db.tx(q => retryVideoEmbedding(q, scope, s.job)), 0);
    const original = (await s.db.query(`SELECT request FROM flow_video_embedding_batches`)).rows[0].request;
    configureVideoKnowledge(s.engine, { modelTask: async (_, __, ___, r) => s.receipt(r, { status: "failed" }) });
    await assert.rejects(s.service.workClaim(s.job, s.st), /EMBEDDING_TASK_FAILED/);
    assert.equal(await s.db.tx(q => retryVideoEmbedding(q, scope, s.job)), 1);
    const batch = (await s.db.query(`SELECT * FROM flow_video_embedding_batches`)).rows[0];
    assert.notEqual(batch.request.key, original.key); assert.deepEqual(batch.request.input, original.input);
    assert.equal(batch.prior_receipts[0].status, "failed"); assert.equal(batch.generation, 1);
    configureVideoKnowledge(s.engine, { modelTask: async (_, __, ___, r) => s.receipt(r) });
    assert.equal(await s.service.workClaim(s.job, s.st), "completed");
  } finally { await s.db.close(); }
});

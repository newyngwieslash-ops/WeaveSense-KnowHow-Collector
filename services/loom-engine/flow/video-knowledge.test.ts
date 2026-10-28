import { test } from "node:test";
import assert from "node:assert/strict";
import { pgliteDb, migrate } from "./db.ts";
import { Engine } from "./engine.ts";
import { VideoKnowledgeService, revokeVideoDependencies, applyVideoRetention } from "./video-knowledge.ts";
import { VideoKnowledgeSkills } from "./video-knowledge-skills.ts";
import { knowledgeHash, nativeSkillHash, EVAL_KINDS } from "./video-knowledge-contract.ts";
import { sha } from "./video-contract.ts";
import type { ExecutionContext } from "./auth.ts";
import { configureVideoKnowledge } from "./video-knowledge-runtime.ts";
import { VideoKnowledgeExtractor, enqueueVideoKnowledgeReady } from "./video-knowledge-extractor.ts";
import { VideoKnowledgeEvaluator } from "./video-knowledge-evaluator.ts";
import { readFileSync } from "node:fs";
import { closeKnowledgeBudget } from "./video-knowledge-budget.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reports } from "./reports.ts";
import { withVideoAccess } from "./video-access.ts";
import { VideoOriginCandidates, enqueueVideoOriginCheck, videoOriginFingerprint, videoOriginSimilarity, VIDEO_ORIGIN_BASELINE } from "./video-origin-candidates.ts";

const scopes = ["intel.knowledge.read", "intel.knowledge.research", "intel.knowledge.write", "intel.knowledge.review", "intel.knowledge.publish", "intel.sources.write", "intel.skills.release", "intel.skills.evaluate", "intel.skills.deploy", "intel.skills.install"];
const A = { tenant_id: "tn_test", workspace_id: "ws_test", actor: { type: "user", id: "reviewer" }, scopes, policy_version: "test-v1" } as ExecutionContext;
const B = { ...A, workspace_id: "foreign" };
const service = { ...A, actor: { type: "service_principal", id: "video-model-evaluator" } };
const method = { id: "video-knowledge-core", version: "1.0.0", hash: "a".repeat(64) };
const expected = (row: any) => ({ expected_version: row.version, expected_hash: row.content_hash, reason: "Fixture review only; not real industry approval" });

test("COL020 curation/evaluation budget close keeps unknown held and persists authoritative receipt", async () => {
  const db = await pgliteDb(); await migrate(db);
  try {
    const engine = new Engine(db); let calls = 0;
    await db.query(`INSERT INTO flow_video_skill_candidates(id,tenant_id,workspace_id,skill_id,skill_version,candidate_hash,native_skill_hash,proposal,state,created_by) VALUES('fixture',$1,$2,'fixture','1','hash','hash','{}','rejected','fixture')`, [A.tenant_id, A.workspace_id]);
    configureVideoKnowledge(engine, { closeModelBudget: async () => { calls++; throw Object.assign(new Error("unknown child"), { status: 409 }); } });
    await closeKnowledgeBudget(engine, "video_skill_evaluate");
    let row = (await db.query(`SELECT * FROM flow_video_skill_candidates WHERE id='fixture'`)).rows[0];
    assert.equal(row.budget_closed_at, null); assert.equal(row.budget_close_receipt.status, "pending");
    await closeKnowledgeBudget(engine, "video_skill_evaluate"); assert.equal(calls, 1);
    await db.query(`UPDATE flow_video_skill_candidates SET budget_close_next_at=now()`);
    configureVideoKnowledge(engine, { closeModelBudget: async () => { calls++; return { reservation_id: "authoritative-parent", status: "settled", cost_micro: 123 }; } });
    await closeKnowledgeBudget(engine, "video_skill_evaluate");
    row = (await db.query(`SELECT * FROM flow_video_skill_candidates WHERE id='fixture'`)).rows[0];
    assert.ok(row.budget_closed_at); assert.equal(row.budget_close_receipt.cost_micro, 123);
    await closeKnowledgeBudget(engine, "video_skill_evaluate"); assert.equal(calls, 2);
  } finally { await db.close(); }
});

async function setup() {
  const db = await pgliteDb(); await migrate(db);
  const engine = new Engine(db, async () => [], () => new Date("2026-10-26T00:00:00Z"));
  engine.video.enabled = true;
  const directory = await mkdtemp(join(tmpdir(), "knowledge-journal-fixture-"));
  const journal = { directory: join(directory, "journal"), journalId: "knowledge-fixture", key: "fixture-only-signing-key-not-a-production-secret" };
  await initializeVideoDeletionJournal(journal);
  configureVideoRetentionJournal(engine, journal, (q, e) => applyVideoRetention(engine, q, e, e));
  await replayVideoRetentionJournal(engine);
  const close = db.close;
  db.close = async () => { try { await close(); } finally { await rm(directory, { recursive: true, force: true }); } };
  configureVideoKnowledge(engine, { resolveBase: async () => ({ ...method, required_tools: ["intel_search_knowledge"] }) });
  const k = new VideoKnowledgeService(engine), skills = new VideoKnowledgeSkills(k);
  await db.query(`INSERT INTO flow_video_profiles(id,tenant_id,workspace_id,version,name,config,content_hash,created_by) VALUES('profile',$1,$2,1,'Development generic research','{}',$3,'fixture')`, [A.tenant_id, A.workspace_id, sha("profile")]);
  const seed = async (suffix = "1", origin: string | null = "original", bodyOverride?: string) => {
    const source = `src_${suffix}`, asset = `asset_${suffix}`, doc = `doc_${suffix}`, evidence = `ev_${suffix}`;
    const title = "开发样例 😀", body = bodyOverride ?? "温度范围为 20 °C。仅适用于演示材料，不是行业建议。";
    await db.query(`INSERT INTO flow_sources(id,tenant_id,workspace_id,kind,url,config) VALUES($1,$2,$3,'bilibili',$4,'{"allowed_uses":["knowledge"]}')`, [source, A.tenant_id, A.workspace_id, `https://www.bilibili.com/video/BV${suffix}`]);
    await db.query(`INSERT INTO flow_video_assets(id,tenant_id,workspace_id,platform,native_id,canonical_url,origin_cluster) VALUES($1,$2,$3,'bilibili',$4,$5,$6)`, [asset, A.tenant_id, A.workspace_id, suffix, `https://www.bilibili.com/video/BV${suffix}`, origin]);
    await db.query(`INSERT INTO flow_video_asset_sources(tenant_id,workspace_id,asset_id,source_id) VALUES($1,$2,$3,$4)`, [A.tenant_id, A.workspace_id, asset, source]);
    await db.query(`INSERT INTO flow_documents(id,tenant_id,workspace_id,source_id,external_id,url,title,video_asset_id,video_text_access_expires_at,video_text_max_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2030-01-01','2030-01-01')`, [doc, A.tenant_id, A.workspace_id, source, suffix, `https://www.bilibili.com/video/BV${suffix}`, title, asset]);
    await db.query(`INSERT INTO flow_document_revisions(document_id,revision,tenant_id,content_hash,title,body,collected_by_run,material_type) VALUES($1,1,$2,$3,$4,$5,'fixture','platform_subtitles')`, [doc, A.tenant_id, sha(title + "\n\n" + body), title, body]);
    await db.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url) VALUES($1,$2,$3,$4,1,$5,$6,$7,'fixture',$8,$9)`, [evidence, A.tenant_id, A.workspace_id, doc, title.length + 2, title.length + 2 + body.length, body, sha(body), `https://www.bilibili.com/video/BV${suffix}`]);
    return { source, asset, doc, title, body, ref: { evidence_id: evidence, revision: 1, snippet_hash: sha(body) } };
  };
  const material = await seed();
  const unit = (changes: any = {}) => ({ type: "fact", title: "Development fact", domain_tags: ["development-only"], statement: "温度范围为 20 °C。", claim_kind: "source_statement",
    applicability: [], conditions: [], steps: [], parameters: [{ name: "temperature", value: "20", unit: "°C", conditions: [] }], boundaries: [], counterexamples: [], missing_fields: ["real_industry_scope"], evidence: [material.ref], valid_from: null, valid_until: null, conflict_key: "temperature", ...changes });
  const create = (key: string, changes: any = {}) => k.create(A, key, { profile_id: "profile", profile_version: 1, method, unit: unit(changes) });
  const publish = async (row: any) => {
    row = await k.review(A, row.id, `submit:${row.id}:${row.version}`, { ...expected(row), decision: "submit" });
    row = await k.review(A, row.id, `approve:${row.id}:${row.version}`, { ...expected(row), decision: "approve", checks: { evidence_support: true, critical_fields: true } });
    return k.publish(A, row.id, `publish:${row.id}:${row.version}`, expected(row));
  };
  return { db, engine, k, skills, seed, material, unit, create, publish, journal };
}

test("K021/023/024: durable versioned approval, publication, no fallback, idempotency and isolation", async () => {
  const { db, k, create, publish, unit } = await setup();
  try {
    let row = await create("a");
    assert.equal(row.state, "candidate");
    assert.equal((await create("a")).id, row.id);
    await assert.rejects(create("a", { title: "different" }), /idempotency_conflict/);
    assert.equal((await k.list(A, {}, true)).items.length, 0);
    assert.equal((await k.research(A)).items[0].review_status, "unreviewed_material");
    await assert.rejects(k.get(B, row.id), /knowledge_not_found/);
    await assert.rejects(k.publish(A, row.id, "premature", expected(row)), /current_approval_required/);
    await assert.rejects(k.review(service, row.id, "model-self-approval", { ...expected(row), decision: "approve" }), /human_review_required/);
    row = await publish(row);
    assert.equal((await k.list(A, { q: "温度" }, true)).items.length, 1);
    assert.equal((await k.list(A, { q: "unavailable-answer" }, true)).fallback_used, false);
    const old = row;
    row = await k.edit(A, row.id, "edit", { ...expected(row), unit: unit({ title: "Revised title" }) });
    assert.equal(row.version, 2); assert.equal(row.state, "candidate"); assert.equal(row.approval, null);
    await assert.rejects(k.publish(A, row.id, "stale", expected(old)), /knowledge_version_conflict/);
    assert.equal((await k.list(A, {}, true)).items.length, 0);
    assert.equal((await db.query(`SELECT count(*)::int n FROM flow_knowledge_versions`)).rows[0].n, 2);
    assert.equal((await db.query(`SELECT count(*)::int n FROM flow_outbox WHERE type='knowledge.published'`)).rows[0].n, 1);
    assert.equal((await migrate(db)).length, 0);
  } finally { await db.close(); }
});

test("K021/022: exact evidence, UTF16, source provenance, unsupported numbers and units fail closed", async () => {
  const { db, k, create, material } = await setup();
  try {
    await assert.rejects(create("no-ev", { evidence: [] }), /evidence_required/);
    await assert.rejects(create("forged-ev", { evidence: [{ ...material.ref, revision: 2 }] }), /evidence_unavailable/);
    await assert.rejects(create("forged-hash", { evidence: [{ ...material.ref, snippet_hash: "0".repeat(64) }] }), /evidence_unavailable/);
    await assert.rejects(create("number", { statement: "温度 99 °C" }), /unsupported_numeric_claim/);
    await assert.rejects(create("unit", { parameters: [{ name: "power", value: "20", unit: "MW", conditions: [] }] }), /unsupported_parameter/);
    const resolved = await k.resolveEvidence(A, [material.ref]); assert.equal(resolved[0].char_start, material.title.length + 2);
    await db.query(`UPDATE flow_document_revisions SET material_type='model_summary' WHERE document_id=$1`, [material.doc]);
    await assert.rejects(create("self-source"), /derived_conclusion_not_source/);
    await db.query(`UPDATE flow_document_revisions SET material_type='platform_subtitles' WHERE document_id=$1`, [material.doc]);
    await db.query(`UPDATE flow_evidence SET quote='tampered' WHERE id=$1`, [material.ref.evidence_id]);
    await assert.rejects(create("tamper"), /evidence_unavailable/);
  } finally { await db.close(); }
});

test("K008/K016 fixed temporal media identity never follows mutable asset hash; repost origins do not verify each other", async () => {
  const { db, k, engine, material, seed, create, publish } = await setup();
  try {
    await db.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,grant_actor,policy_version)
      VALUES('fixed-media','fixture-operation',$1,$2,$3,$4,'profile',1,'fixed-media-fingerprint','{}','user:reviewer','fixture')`, [A.tenant_id, A.workspace_id, material.source, material.asset]);
    await db.query(`INSERT INTO flow_video_temporal_evidence(evidence_id,tenant_id,workspace_id,video_job_id,start_ms,end_ms,alignment_method,media_sha256,material_type)
      VALUES($1,$2,$3,'fixed-media',0,1000,'segment',$4,'platform_subtitles')`, [material.ref.evidence_id, A.tenant_id, A.workspace_id, "a".repeat(64)]);
    await db.query(`UPDATE flow_video_assets SET media_sha256=$1 WHERE id=$2`, ["b".repeat(64), material.asset]);
    assert.equal((await k.resolveEvidence(A, [material.ref]))[0].media_sha256, "a".repeat(64));
    const pgRows = { query: async (sql: string, params?: unknown[]) => {
      const result = await db.query(sql, params);
      return { ...result, rows: result.rows.map(row => ({ ...row, start_ms: "0", end_ms: "1000" })) };
    } };
    const numeric = (await k.resolveEvidence(A, [material.ref], pgRows))[0];
    assert.equal(numeric.start_ms, 0); assert.equal(numeric.end_ms, 1000);
    const candidate = await create("temporal-snapshot");
    const legacy = candidate.evidence_snapshot.map((ev: any) => ({ ...ev, start_ms: "0", end_ms: "1000" }));
    await db.query(`UPDATE flow_knowledge_versions SET evidence_snapshot=$1 WHERE knowledge_id=$2`, [JSON.stringify(legacy), candidate.id]);
    const current = await k.get(A, candidate.id, false);
    assert.equal(current.evidence_snapshot[0].start_ms, 0); assert.equal(current.evidence_snapshot[0].end_ms, 1000);
    assert.equal(current.content_hash, candidate.content_hash);
    assert.equal((await db.query(`SELECT evidence_snapshot FROM flow_knowledge_versions WHERE knowledge_id=$1`, [candidate.id])).rows[0].evidence_snapshot[0].start_ms, "0", "read projection must not rewrite immutable snapshots");
    const released = await publish(candidate);
    const corrupt = legacy.map((ev: any) => ({ ...ev, start_ms: "9007199254740992", end_ms: "9007199254740992" }));
    await db.query(`UPDATE flow_knowledge_versions SET evidence_snapshot=$1 WHERE knowledge_id=$2`, [JSON.stringify(corrupt), candidate.id]);
    await assert.rejects(k.get(A, candidate.id), /INVALID_EVIDENCE_TIME/);
    const withdrawn = await k.withdraw(A, candidate.id, "withdraw-corrupt-time", expected(released));
    assert.equal(withdrawn.state, "withdrawn"); assert.equal(withdrawn.unavailable, true);
    assert.equal(withdrawn.evidence_snapshot, undefined);
    assert.equal((await k.withdraw(A, candidate.id, "withdraw-corrupt-time", expected(released))).unavailable, true);
    assert.ok((await db.query(`SELECT revoked_at FROM flow_knowledge_releases WHERE id=$1`, [released.release_id])).rows[0].revoked_at);
    const stored = (await db.query(`SELECT content_hash,evidence_snapshot FROM flow_knowledge_versions WHERE knowledge_id=$1`, [candidate.id])).rows[0];
    assert.equal(stored.content_hash, candidate.content_hash); assert.deepEqual(stored.evidence_snapshot, corrupt);
    await db.query(`UPDATE flow_video_temporal_evidence SET media_sha256=NULL WHERE evidence_id=$1`, [material.ref.evidence_id]);
    assert.equal((await k.resolveEvidence(A, [material.ref]))[0].media_sha256, null);
    const repost = await seed("repost-media", "original"), reports = new Reports(engine);
    const review = await reports.review(A, [{ text: material.body, kind: "cross_source_verified", citations: [material.ref, repost.ref] }]);
    assert.equal(review.claims.length, 0); assert.match(review.review.rejected[0].reason, /independent origins/);
  } finally { await db.close(); }
});

test("K020 bounded near-duplicate fingerprints create human origin candidates, gate corroboration, and allow audited split", async () => {
  const { db, engine, k, seed, unit } = await setup();
  try {
    const body = Array.from({ length: 40 }, (_, i) => `授权开发样例编号${i}：温度范围为 20 °C。必须先确认材料和边界，然后记录异常与复核结果。`).join("\n");
    const near = body.replace("开发样例编号3", "开发演示编号3"), different = "unrelated music rhythm instruments jazz melody performance ".repeat(50);
    const a = await seed("similar-a", null, body), b = await seed("similar-b", null, near), c = await seed("different", null, different);
    const signature = videoOriginFingerprint(body);
    assert.equal(videoOriginSimilarity(signature, videoOriginFingerprint(body)), 1);
    assert.ok(videoOriginSimilarity(signature, videoOriginFingerprint(near)) >= VIDEO_ORIGIN_BASELINE.threshold);
    assert.ok(videoOriginSimilarity(signature, videoOriginFingerprint(different)) < VIDEO_ORIGIN_BASELINE.threshold);
    assert.throws(() => videoOriginFingerprint("汉".repeat(300001)), /origin_fingerprint_input_limit/);
    for (const material of [a, b, c]) await db.tx(q => enqueueVideoOriginCheck(q, A, { document_id: material.doc, revision: 1, grant_actor: "user:reviewer" }));
    const worker = new VideoOriginCandidates(engine);
    for (let i = 0; i < 3; i++) assert.equal(await worker.workOnce(`fixture-${i}`), true);
    assert.equal(await worker.workOnce("none"), false);
    const result = await worker.list(A, { state: "pending" }); assert.equal(result.items.length, 1);
    const candidate = result.items[0]; assert.equal(candidate.proposal.baseline.calibration, "suggested_uncalibrated_baseline");
    assert.equal((await worker.list(B)).items.length, 0);
    const verified = { profile_id: "profile", profile_version: 1, method, unit: unit({ claim_kind: "cross_source_verified", evidence: [a.ref, b.ref] }) };
    await assert.rejects(k.create(A, "pending-near-origin", verified), /origin_independence_review_pending/);
    const review = await worker.review(A, candidate.id, "fixture-same-origin", { expected_hash: candidate.content_hash, decision: "same_origin", origin_cluster: "fixture-shared-origin", reason: "Fixture reviewer confirms repost; not real industry validation" });
    assert.equal(review.state, "same_origin"); assert.equal(review.review.actor, "user:reviewer");
    assert.equal((await db.query(`SELECT count(DISTINCT source_id)::int n FROM flow_documents WHERE id=ANY($1::text[])`, [[a.doc, b.doc]])).rows[0].n, 2);
    await assert.rejects(k.create(A, "duplicate-corroboration", verified), /independent_origins_required/);
    await k.origins(A, "fixture-human-split", { assets: [{ asset_id: b.asset, expected_origin_cluster: "fixture-shared-origin" }], origin_cluster: "fixture-split-origin", reason: "Fixture correction after reviewing a false merge" });
    assert.equal((await k.create(A, "after-human-split", verified)).state, "candidate");
    await k.retention(A, "erase-fingerprint", { action: "erased", asset_id: a.asset, reason: "Fixture erasure" });
    assert.equal((await db.query(`SELECT count(*)::int n FROM flow_video_origin_fingerprints WHERE document_id=$1`, [a.doc])).rows[0].n, 0);
    assert.equal((await worker.list(A)).items[0].unavailable, true);
  } finally { await db.close(); }
});

test("K020/029: repost origin does not corroborate; conflicts retain both versions; batch partial failure", async () => {
  const { db, k, seed, create, material, publish } = await setup();
  try {
    const repost = await seed("2", "original");
    await assert.rejects(create("repost", { claim_kind: "cross_source_verified", evidence: [material.ref, repost.ref] }), /independent_origins_required/);
    const independent = await seed("3", "independent");
    const row = await create("independent", { claim_kind: "cross_source_verified", evidence: [material.ref, independent.ref] });
    const other = await create("conflict", { statement: "来源中的温度 20 °C 仅为演示。" });
    assert.equal((await db.query(`SELECT count(*)::int n FROM flow_knowledge_conflicts`)).rows[0].n, 1);
    const batch = await k.batchReview(A, { items: [{ id: row.id, idempotency_key: "batch1", ...expected(row), decision: "submit" }, { id: other.id, idempotency_key: "batch2", ...expected(other), expected_version: 99, decision: "submit" }] });
    assert.equal(batch.results[0].ok, true); assert.equal(batch.results[1].ok, false);
    let checked = await k.review(A, row.id, "approve-origins", { ...expected(row), decision: "approve", checks: { evidence_support: true, critical_fields: true } });
    checked = await k.publish(A, row.id, "publish-origins", expected(checked));
    const merged = await k.origins(A, "merge-repost", { assets: [{ asset_id: independent.asset, expected_origin_cluster: "independent" }], origin_cluster: "original", reason: "Fixture repost identified" });
    assert.deepEqual(merged.invalidated_knowledge_ids, [row.id]);
    assert.equal((await k.list(A, {}, true)).items.length, 0);
  } finally { await db.close(); }
});

test("current source authorization expiry blocks both published knowledge and research without a fallback", async () => {
  const { db, k, create, publish, material } = await setup();
  try {
    const row = await publish(await create("expires"));
    await db.query(`UPDATE flow_sources SET config=config || '{"authorization_expires_at":"2001-01-01T00:00:00Z"}'::jsonb WHERE id=$1`, [material.source]);
    assert.equal((await k.list(A, {}, true)).items.length, 0);
    assert.equal((await k.research(A, { query: "温度" })).items.length, 0);
    await assert.rejects(k.get(A, row.id), /evidence_unavailable/);
  } finally { await db.close(); }
});

test("K022: ready event queues one persistent independent extraction; gateway output creates candidates only", async () => {
  const { db, engine, k, material, unit } = await setup();
  try {
    await db.query(`UPDATE flow_video_profiles SET config=$1 WHERE id='profile'`, [JSON.stringify({ knowledge_model_id: "fixture-model", knowledge_budget_micro: 1000 })]);
    await db.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,state,grant_actor,policy_version,document_id,revision)
      VALUES('ready_job','fixture_operation',$1,$2,$3,$4,'profile',1,'fixture-fingerprint','{}','completed','user:reviewer','test-v1',$5,1)`, [A.tenant_id, A.workspace_id, material.source, material.asset, material.doc]);
    const ready = { video_job_id: "ready_job", document_id: material.doc, revision: 1, profile_id: "profile", profile_version: 1, grant_actor: "user:reviewer", policy_version: "test-v1" };
    const first = await db.tx(q => enqueueVideoKnowledgeReady(q, A, ready)), replay = await db.tx(q => enqueueVideoKnowledgeReady(q, A, ready));
    assert.equal(first.id, replay.id);
    let calls = 0;
    configureVideoKnowledge(engine, { resolveBase: async () => ({ ...method, required_tools: [] }), modelTask: async (_ctx, id, purpose, request, taskId) => {
      assert.equal(id, first.id); assert.equal(purpose, "video_knowledge_extract"); calls++;
      if (!taskId) { assert.equal(request.input.evidence[0].quote, material.body); return { task_id: "fixture-task", status: "queued" }; }
      return { task_id: taskId, status: "succeeded", usage_ref: `model_task:${taskId}`, reservation_id: "fixture-child", cost_micro: 1, input_hash: "b".repeat(64), model_config_hash: "c".repeat(64), output: { profile_id: "profile", profile_version: 1, relevance: "relevant", knowledge_units: [unit()], missing_information: [], coverage_limitations: [] } };
    } });
    const extractor = new VideoKnowledgeExtractor(engine);
    assert.equal(await extractor.workOnce("first-worker"), true);
    assert.equal((await extractor.get(A, first.id)).state, "submitted");
    await db.query(`UPDATE flow_video_knowledge_runs SET next_poll_at=now()-interval '1 second' WHERE id=$1`, [first.id]);
    assert.equal(await new VideoKnowledgeExtractor(engine).workOnce("restarted-worker"), true);
    const result = await extractor.get(A, first.id); assert.equal(result.state, "completed"); assert.equal(result.candidate_ids.length, 1); assert.equal(calls, 2);
    assert.equal((await k.list(A, {}, true)).items.length, 0); assert.equal((await k.list(A)).items[0].state, "candidate");
    assert.equal(await extractor.workOnce("replay-worker"), false);
    assert.equal((await db.query(`SELECT count(*)::int n FROM flow_outbox WHERE type='video.knowledge_curated'`)).rows[0].n, 1);
  } finally { await db.close(); }
});

test("K028 runner executes base/no-skill/candidate separately and computes scores, not model approval", async () => {
  const { db, engine, skills, create, publish, material } = await setup();
  try {
    const knowledge = await publish(await create("eval-knowledge"));
    const baseSkill = { ...method, name: "Fixture base", method: "Fixture instruction", steps: [], references: [], output_schema: { type: "object", required: [] } };
    const variants: string[] = [];
    configureVideoKnowledge(engine, { resolveBase: async () => ({ ...method, required_tools: ["intel_search_knowledge"], skill: baseSkill }), modelTask: async (_ctx, _id, purpose, request) => {
      assert.equal(purpose, "video_skill_evaluate"); variants.push(request.input.variant);
      assert.equal(request.input.method === null, request.input.variant === "without_skill");
      return { task_id: `fixture-${variants.length}`, status: "succeeded", usage_ref: `model_task:fixture-${variants.length}`, reservation_id: "fixture-child", cost_micro: 1, input_hash: "c".repeat(64), model_config_hash: "b".repeat(64), output: { case_id: request.input.case_id, output: "fixture expected", unsupported_claims: [], permission_violations: [], missing_evidence: [], limitations: [] } };
    } });
    let candidate = await skills.create(A, "runtime-eval", { base: { ...method, required_tools: ["intel_search_knowledge"] }, pack: { id: "runtime-fixture", version: "1.1.0", name: "Fixture", required_tools: ["intel_search_knowledge"], mcp_requirements: [], skills: [{ ...baseSkill, id: "runtime-fixture", version: "1.1.0" }] },
      evidence: [material.ref], knowledge_releases: [{ knowledge_id: knowledge.id, version: knowledge.version, release_id: knowledge.release_id, content_hash: knowledge.content_hash }],
      rule_evidence: [{ rule: "method", evidence_ids: [material.ref.evidence_id] }],
      eval_spec: { dataset_version: "fixture-v1", model_config: { model: "fixture-model", budget_micro: 1500 }, cases: EVAL_KINDS.map((kind, i) => ({ id: `c${i}`, kind, input: "fixture", expected: "fixture expected" })) } });
    candidate = await skills.requestEvaluation(A, candidate.id, "run-eval", { expected_hash: candidate.candidate_hash });
    const evaluator = new VideoKnowledgeEvaluator(engine);
    for (let i = 0; i < 15; i++) assert.equal(await evaluator.workOnce(`worker-${i}`), true);
    candidate = await skills.get(A, candidate.id);
    assert.equal(candidate.state, "passed"); assert.equal(candidate.eval_result.scorer, "exact_expected_output_v1");
    assert.equal(variants.filter(x => x === "base").length, 5); assert.equal(variants.filter(x => x === "without_skill").length, 5); assert.equal(variants.filter(x => x === "candidate").length, 5);
    assert.equal(candidate.approval, null); assert.equal(candidate.release_package, null);
    assert.equal(await evaluator.workOnce("after"), false);
  } finally { await db.close(); }
});

test("K022: more than100 evidence segments are covered by persistent batches, not a sliced success", async () => {
  const { db, engine, material, unit } = await setup();
  try {
    await db.query(`UPDATE flow_video_profiles SET config=$1 WHERE id='profile'`, [JSON.stringify({ knowledge_model_id: "fixture-model", knowledge_budget_micro: 1000 })]);
    for (let i = 0; i < 100; i++) await db.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url)
      SELECT $1,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url FROM flow_evidence WHERE id=$2`, [`ev_long_${String(i).padStart(3, "0")}`, material.ref.evidence_id]);
    await db.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,state,grant_actor,policy_version,document_id,revision)
      VALUES('long_ready','long_operation',$1,$2,$3,$4,'profile',1,'long-fixture','{}','completed','user:reviewer','test-v1',$5,1)`, [A.tenant_id, A.workspace_id, material.source, material.asset, material.doc]);
    const run = await db.tx(q => enqueueVideoKnowledgeReady(q, A, { video_job_id: "long_ready", document_id: material.doc, revision: 1, profile_id: "profile", profile_version: 1, grant_actor: "user:reviewer" }));
    const seen: string[] = [], keys: string[] = [];
    configureVideoKnowledge(engine, { resolveBase: async () => ({ ...method, required_tools: [] }), modelTask: async (_ctx, _id, _purpose, request) => {
      keys.push(request.key); seen.push(...request.input.evidence.map((e: any) => e.evidence_id));
      const ev = request.input.evidence[0];
      return { task_id: `fixture-long-${keys.length}`, status: "succeeded", usage_ref: `model_task:fixture-long-${keys.length}`, reservation_id: "fixture-child", cost_micro: 1, input_hash: "b".repeat(64), model_config_hash: "c".repeat(64), output: { profile_id: "profile", profile_version: 1, relevance: "relevant", knowledge_units: [unit({ evidence: [{ evidence_id: ev.evidence_id, revision: ev.revision, snippet_hash: ev.snippet_hash }] })], missing_information: [], coverage_limitations: [] } };
    } });
    const extractor = new VideoKnowledgeExtractor(engine);
    await extractor.workOnce("batch1");
    assert.equal((await extractor.get(A, run.id)).state, "queued");
    await new VideoKnowledgeExtractor(engine).workOnce("batch2-restarted");
    const result = await extractor.get(A, run.id);
    assert.equal(result.state, "completed"); assert.equal(result.candidate_ids.length, 2);
    assert.equal(seen.length, 101); assert.equal(new Set(seen).size, 101); assert.equal(new Set(keys).size, 2);
  } finally { await db.close(); }
});

test("K027 development profile is explicitly generic, zero-cost, and contains missing/conflicting review examples", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../docs/video-ingestion/development-domain-profile.json", import.meta.url), "utf8"));
  assert.equal(fixture.fixture_only, true); assert.equal(fixture.not_a_confirmed_industry_profile, true);
  assert.equal(fixture.config.knowledge_budget_micro, 0); assert.equal(fixture.config.review_policy.human_required, true);
  assert.equal(fixture.review_examples.length, 3); assert.ok(fixture.config.terms[0].aliases.length);
});

test("K026 run pins freeze published releases while current revocation still wins", async () => {
  const { db, k, create, publish } = await setup();
  try {
    const first = await publish(await create("snapshot-first"));
    const pinCtx = { ...A, actor: { type: "service_principal", id: "video-skill-reader" }, job_id: "fixture-run" };
    const snap = await k.pinSnapshot(pinCtx, { run_id: "fixture-run", method });
    assert.equal(snap.knowledge_releases.length, 1); assert.equal(snap.knowledge_releases[0].release_id, first.release_id);
    const second = await publish(await create("snapshot-second", { title: "Second published knowledge" }));
    const replay = await k.pinSnapshot(pinCtx, { run_id: "fixture-run", method });
    assert.equal(replay.id, snap.id); assert.equal(replay.knowledge_releases.length, 1);
    assert.equal((await k.list(A, { snapshot_id: snap.id }, true)).items.length, 1);
    await assert.rejects(k.get(A, second.id, true, snap.id), /knowledge_outside_run_snapshot/);
    await assert.rejects(k.pinSnapshot(A, { run_id: "fixture-run", method }), /trusted_run_pin_required/);
    await assert.rejects(k.list(B, { snapshot_id: snap.id }, true), /knowledge_snapshot_not_found/);
    await k.withdraw(A, first.id, "snapshot-withdraw", expected(first));
    assert.equal((await k.list(A, { snapshot_id: snap.id }, true)).items.length, 0);
    assert.equal((await k.list(A, {}, true)).items.length, 1);
    assert.equal((await k.pinSnapshot(pinCtx, { run_id: "fixture-run", method })).hash, snap.hash);
  } finally { await db.close(); }
});

test("K025: pause, expiry, remote unavailable retain text; revocation and erasure invalidate knowledge and replay", async () => {
  const { db, k, create, publish, material } = await setup();
  try {
    let row = await publish(await create("retained"));
    await db.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,grant_actor,policy_version)
      VALUES('pre-ready','fixture-operation',$1,$2,$3,$4,'profile',1,'pre-ready-fingerprint','{"title":"sensitive pre-ready title"}','user:reviewer','fixture')`, [A.tenant_id, A.workspace_id, material.source, material.asset]);
    await db.query(`INSERT INTO flow_video_embedding_staging(tenant_id,workspace_id,video_job_id,manifest_hash,input_hash,profile_hash,config,payload,required)
      VALUES($1,$2,'pre-ready','audit','audit','audit','{}','{"transcript":"sensitive text"}',false)`, [A.tenant_id, A.workspace_id]);
    await db.query(`INSERT INTO flow_video_embedding_batches(tenant_id,workspace_id,video_job_id,batch_index,request_hash,request,vectors)
      VALUES($1,$2,'pre-ready',0,'audit','{"texts":["sensitive text"]}','[1]')`, [A.tenant_id, A.workspace_id]);
    for (const action of ["subscription_paused", "media_expired", "remote_unavailable"]) {
      const result = await k.retention(A, action, { source_id: material.source, action, reason: "Fixture policy" });
      assert.equal(result.knowledge_revoked, false); assert.equal((await k.list(A, {}, true)).items.length, 1);
    }
    await k.retention(A, "erase", { asset_id: material.asset, action: "erased", reason: "Fixture erasure" });
    assert.equal((await k.list(A, {}, true)).items.length, 0); assert.equal((await k.research(A)).items.length, 0);
    assert.equal((await k.get(A, row.id, false)).unavailable, true);
    assert.equal((await create("retained")).unavailable, true);
    assert.equal((await db.query(`SELECT body FROM flow_document_revisions WHERE document_id=$1`, [material.doc])).rows[0].body, "");
    assert.equal((await db.query(`SELECT unit FROM flow_knowledge_versions WHERE knowledge_id=$1`, [row.id])).rows[0].unit.statement, undefined);
    assert.deepEqual((await db.query(`SELECT payload FROM flow_video_embedding_staging WHERE video_job_id='pre-ready'`)).rows[0].payload, {});
    const erasedBatch = (await db.query(`SELECT request,vectors FROM flow_video_embedding_batches WHERE video_job_id='pre-ready'`)).rows[0];
    assert.deepEqual(erasedBatch.request, {}); assert.equal(erasedBatch.vectors, null);
    assert.ok((await db.query(`SELECT 1 FROM flow_outbox WHERE type='knowledge.dependencies_revoked' AND payload->'video_job_ids' ? 'pre-ready'`)).rows.length);
    await db.tx(q => revokeVideoDependencies(q, A, [material.doc], "erased", true));
    assert.equal((await db.query(`SELECT count(*)::int n FROM flow_video_deletion_tombstones`)).rows[0].n, 1);
    await assert.rejects(k.retention(B, "foreign", { asset_id: material.asset, action: "erased", reason: "tamper" }), /asset_not_found/);
  } finally { await db.close(); }
});

test("R25 journal unavailable denies deletion acknowledgment and direct knowledge reads", async () => {
  const { db, engine, k, material, create, publish, journal } = await setup();
  try {
    const row = await publish(await create("journal-protected"));
    configureVideoRetentionJournal(engine, { ...journal, directory: join(journal.directory, "unavailable") }, (q, e) => applyVideoRetention(engine, q, e, e));
    await assert.rejects(k.retention(A, "must-journal-first", { action: "erased", asset_id: material.asset, reason: "Fixture deletion" }), /video_journal_missing/);
    assert.equal((await db.query(`SELECT body FROM flow_document_revisions WHERE document_id=$1`, [material.doc])).rows[0].body, material.body);
    await assert.rejects(k.get(A, row.id), /video_journal_missing/);
    await assert.rejects(k.research(A), /video_journal_missing/);
  } finally { await db.close(); }
});

test("R25 quarantine preserves RSS reports but denies derived video caches; erasure scrubs research output", async () => {
  const { db, engine, k, material } = await setup();
  try {
    const reports = new Reports(engine);
    for (const id of ["video-report", "rss-report"]) await db.query(`INSERT INTO flow_reports(id,tenant_id,workspace_id,title,body,created_by,idempotency_key,request_hash) VALUES($1,$2,$3,$1,'fixture body','fixture',$1,'fixture')`, [id, A.tenant_id, A.workspace_id]);
    await db.query(`INSERT INTO flow_claims(id,tenant_id,report_id,idx,text,kind,citations) VALUES('video-claim',$1,'video-report',0,'fixture quote','source_statement',$2)`, [A.tenant_id, JSON.stringify([{ document_id: material.doc, evidence_id: material.ref.evidence_id, revision: 1 }])]);
    for (const id of ["video-research", "rss-research"]) await db.query(`INSERT INTO flow_research_runs(id,tenant_id,workspace_id,parent_run_id,kind,question,status,output,idempotency_key) VALUES($1,$2,$3,'fixture-parent','research','fixture question','succeeded',$4,$1)`, [id, A.tenant_id, A.workspace_id, JSON.stringify(id.startsWith("video") ? { claims: [{ citations: [{ document_id: material.doc, quote: material.body }] }] } : { claims: [] })]);
    await db.tx(q => engine.emit(q, A, "video-report", "video-report", "report.completed", { report_id: "video-report", title: material.body }));
    await withVideoAccess(engine, false, async () => {
      assert.deepEqual((await reports.listReports(A)).map(x => x.id), ["rss-report"]);
      await assert.rejects(reports.getReport(A, "video-report"), /report not found/);
      await assert.rejects(reports.getResearch(A, "video-research"), /research run not found/);
      assert.equal((await reports.getResearch(A, "rss-research")).id, "rss-research");
      assert.equal((await reports.resolveEvidence(A, [material.ref.evidence_id])).length, 0);
    });
    await k.retention(A, "erase-derived-fixture", { action: "erased", asset_id: material.asset, reason: "Fixture erasure" });
    await assert.rejects(reports.getReport(A, "video-report"), /report not found/);
    await assert.rejects(reports.getResearch(A, "video-research"), /research run not found/);
    assert.equal((await db.query(`SELECT output FROM flow_research_runs WHERE id='video-research'`)).rows[0].output, null);
    const notice = (await db.query(`SELECT payload,delivered_at FROM flow_outbox WHERE job_id='video-report'`)).rows[0];
    assert.equal(notice.payload.title, undefined); assert.match(notice.payload.original_payload_hash, /^[a-f0-9]{64}$/); assert.ok(notice.delivered_at);
    assert.equal((await reports.getReport(A, "rss-report")).id, "rss-report");
  } finally { await db.close(); }
});

test("R25 host projection feed replays delivered tombstones with stable scoped checkpoints, never material text", async () => {
  const { db, k, material, seed } = await setup();
  try {
    const second = await seed("projection2");
    await k.retention(A, "projection-one", { action: "erased", asset_id: material.asset, reason: "Fixture erasure" });
    await k.retention(A, "projection-two", { action: "revoked", asset_id: second.asset, reason: "Fixture revocation" });
    await db.query(`UPDATE flow_outbox SET delivered_at=now()`);
    const reader = { ...A, actor: { type: "service_principal", id: "video-projection-reader" }, scopes: ["intel.video.read"] };
    await assert.rejects(k.projectionFeed(A), /missing scope|trusted_projection_reader_required/);
    const first = await k.projectionFeed(reader, { limit: 1 });
    assert.equal(first.items.length, 1); assert.ok(first.next_cursor); assert.equal(first.head_sequence, 2);
    assert.equal(first.items[0].payload_version, 1); assert.equal(first.items[0].tenant_id, A.tenant_id);
    assert.equal(JSON.stringify(first).includes(material.body), false);
    const expected = { journal_id: first.journal_id, genesis_hash: first.genesis_hash, head_sequence: first.head_sequence, head_hash: first.head_hash, projection_sequence: first.projection_sequence };
    const page2 = await k.projectionFeed(reader, { ...expected, cursor: first.next_cursor, limit: 1 });
    assert.equal(page2.items.length, 1); assert.equal(page2.next_cursor, null);
    assert.deepEqual((await k.projectionFeed(reader, { ...expected, cursor: first.projection_sequence })).items, []);
    await assert.rejects(k.projectionFeed(reader, { ...expected, genesis_hash: "0".repeat(64), cursor: first.projection_sequence }), /projection_checkpoint_changed/);
    assert.deepEqual((await k.projectionFeed({ ...reader, workspace_id: "foreign" })).items, []);
    const third = await seed("projection3");
    await k.retention(A, "projection-three", { action: "erased", asset_id: third.asset, reason: "Fixture erasure" });
    await assert.rejects(k.projectionFeed(reader, { ...expected, cursor: first.projection_sequence }), /projection_checkpoint_changed/);
    await assert.rejects(k.projectionFeed(reader, { cursor: Number.MAX_SAFE_INTEGER }), /projection_history_rollback/);
  } finally { await db.close(); }
});

test("COL029 expired material immediately closes knowledge, research and derived report caches without maintenance", async () => {
  const { db, engine, k, material, create, publish } = await setup();
  try {
    const row = await publish(await create("ttl-published")), reports = new Reports(engine);
    await db.query(`INSERT INTO flow_reports(id,tenant_id,workspace_id,title,body,created_by,idempotency_key,request_hash) VALUES('ttl-report',$1,$2,'fixture','cached secret','fixture','ttl-report','fixture')`, [A.tenant_id, A.workspace_id]);
    await db.query(`INSERT INTO flow_claims(id,tenant_id,report_id,idx,text,kind,citations) VALUES('ttl-claim',$1,'ttl-report',0,'fixture','source_statement',$2)`, [A.tenant_id, JSON.stringify([{ document_id: material.doc, evidence_id: material.ref.evidence_id, revision: 1 }])]);
    await db.query(`INSERT INTO flow_research_runs(id,tenant_id,workspace_id,parent_run_id,kind,question,status,output,idempotency_key) VALUES('ttl-research',$1,$2,'parent','research','fixture','succeeded',$3,'ttl-research')`, [A.tenant_id, A.workspace_id, JSON.stringify({ citations: [{ document_id: material.doc }] })]);
    await db.query(`UPDATE flow_documents SET video_text_access_expires_at='2000-01-01' WHERE id=$1`, [material.doc]);
    assert.equal((await k.list(A, {}, true)).items.length, 0); assert.equal((await k.research(A)).items.length, 0);
    await assert.rejects(k.get(A, row.id), /evidence_unavailable/);
    assert.deepEqual(await reports.resolveEvidence(A, [material.ref.evidence_id]), []);
    assert.deepEqual(await reports.listReports(A), []);
    await assert.rejects(reports.getReport(A, "ttl-report"), /report not found/);
    await assert.rejects(reports.getResearch(A, "ttl-research"), /research run not found/);
  } finally { await db.close(); }
});

test("K028: frozen eval, human release, real receipt stages, install pins and revoked dependencies", async () => {
  const { db, k, skills, create, publish, material } = await setup();
  try {
    const knowledge = await publish(await create("skill-input"));
    const input = { base: { ...method, required_tools: ["intel_search_knowledge"] },
      pack: { id: "fixture-method", version: "1.1.0", name: "Development method", required_tools: ["intel_search_knowledge"], mcp_requirements: [],
        skills: [{ id: "fixture-method", version: "1.1.0", name: "Development", method: "Use authorized published evidence only", steps: ["Return missing when no evidence"], references: ["Fixture evidence"], output_schema: { type: "object", required: ["claims"], properties: { claims: { type: "array" } } } }] },
      knowledge_releases: [{ knowledge_id: knowledge.id, version: knowledge.version, release_id: knowledge.release_id, content_hash: knowledge.content_hash }], evidence: [material.ref],
      rule_evidence: [{ rule: "method", evidence_ids: [material.ref.evidence_id] }, { rule: "step:0", evidence_ids: [material.ref.evidence_id] }],
      eval_spec: { dataset_version: "development-fixture-v1", model_config: { model: "fixture-not-real-model" }, cases: EVAL_KINDS.map((kind, i) => ({ id: `case-${i}`, kind, input: "fixture input", expected: "fixture result" })) } };
    let candidate = await skills.create(A, "candidate", input);
    const pre = { expected_hash: candidate.candidate_hash };
    assert.equal(candidate.state, "draft");
    await assert.rejects(skills.review(A, candidate.id, "premature", { ...pre, decision: "approve", reason: "fixture" }), /passed_evaluation_required/);
    await assert.rejects(skills.create(A, "version-mutation", { ...input, pack: { ...input.pack, name: "changed" } }), /immutable_skill_version_conflict/);
    candidate = await skills.requestEvaluation(A, candidate.id, "request", pre);
    const report = { candidate_hash: candidate.candidate_hash, eval_spec_hash: knowledgeHash(input.eval_spec), model_config_hash: knowledgeHash(input.eval_spec.model_config), actual_model_config_hash: "b".repeat(64), dataset_version: input.eval_spec.dataset_version, base_hash: method.hash,
      cases: input.eval_spec.cases.map(c => ({ id: c.id, input_hash: knowledgeHash({ input: c.input, expected: c.expected }), critical_failure: false,
        base: { score: 1, passed: true, run_id: "fixture-base", usage_ref: "fixture-usage", actual_model_config_hash: "b".repeat(64) }, without_skill: { score: 1, passed: true, run_id: "fixture-without", usage_ref: "fixture-usage", actual_model_config_hash: "b".repeat(64) }, candidate: { score: 1, passed: true, run_id: "fixture-candidate", usage_ref: "fixture-usage", actual_model_config_hash: "b".repeat(64) } })) };
    await assert.rejects(skills.evaluate(A, candidate.id, "browser-eval", { ...pre, report }), /trusted_evaluator_required/);
    candidate = await skills.evaluate(service, candidate.id, "trusted-fixture-eval", { ...pre, report }); assert.equal(candidate.state, "passed");
    candidate = await skills.review(A, candidate.id, "human-fixture-review", { ...pre, decision: "approve", reason: "Test fixture approval, not business acceptance" });
    candidate = await skills.export(A, candidate.id, "export", pre); assert.equal(candidate.state, "release_package_exported");
    const pack = JSON.parse(candidate.release_package.pack_json); assert.equal(nativeSkillHash(pack.skills[0]), candidate.native_skill_hash);
    await assert.rejects(skills.checkPin(A, { skill_id: candidate.skill_id, version: candidate.skill_version, hash: candidate.native_skill_hash }), /deployed_candidate_unavailable/);
    assert.equal(candidate.release_package.manifest.tenant_id, A.tenant_id); assert.equal(candidate.release_package.manifest.workspace_id, A.workspace_id);
    const receipt = { ...pre, skill_id: candidate.skill_id, version: candidate.skill_version, hash: candidate.native_skill_hash, receipt_id: "fixture-receipt", build_revision: "fixture-build-not-production", executable_sha256: "f".repeat(64), release_package_hash: knowledgeHash(candidate.release_package) };
    const deployment = { ...service, actor: { type: "service_principal", id: "video-skill-deployer" } };
    assert.equal((await skills.deploymentCheck(deployment, candidate.id, receipt)).release_package_hash, receipt.release_package_hash);
    await assert.rejects(skills.deploymentCheck(deployment, candidate.id, { ...receipt, release_package_hash: "0".repeat(64) }), /scope_or_hash/);
    await assert.rejects(skills.receipt(A, candidate.id, "fake-deploy", { ...receipt, kind: "deployed" }), /trusted_build_or_install_receipt_required/);
    candidate = await skills.receipt({ ...service, actor: { type: "service_principal", id: "video-skill-deployer" } }, candidate.id, "deployed-fixture", { ...receipt, kind: "deployed" });
    candidate = await skills.receipt({ ...service, actor: { type: "service_principal", id: "video-skill-installer" } }, candidate.id, "installed-fixture", { ...receipt, kind: "workspace_installed" }); assert.equal(candidate.state, "workspace_installed");
    assert.equal((await skills.checkPin(A, { skill_id: candidate.skill_id, version: candidate.skill_version, hash: candidate.native_skill_hash })).available, true);
    await k.withdraw(A, knowledge.id, "withdraw", expected(knowledge));
    await assert.rejects(skills.checkPin(A, { skill_id: candidate.skill_id, version: candidate.skill_version, hash: candidate.native_skill_hash }), /deployed_candidate_unavailable/);
  } finally { await db.close(); }
});

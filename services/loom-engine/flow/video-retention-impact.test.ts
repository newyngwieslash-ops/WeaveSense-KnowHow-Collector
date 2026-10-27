import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pgliteDb, migrate } from "./db.ts";
import { Engine } from "./engine.ts";
import type { ExecutionContext } from "./auth.ts";
import { VideoKnowledgeService, applyVideoRetention } from "./video-knowledge.ts";
import { VideoRetentionImpact } from "./video-retention-impact.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal, videoRetentionCheckpoint } from "./video-journal.ts";
import { sha } from "./video-contract.ts";

test("IF027 scoped impact, CAS before journal, partial batch and retained audit vs current access", async t => {
  const db = await pgliteDb(); t.after(() => db.close()); await migrate(db);
  const engine = new Engine(db, async () => [], () => new Date("2026-10-26T00:00:00Z")); engine.video.enabled = true;
  const directory = await mkdtemp(join(tmpdir(), "retention-impact-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { directory: join(directory, "journal"), journalId: "impact-fixture", key: "synthetic-impact-key-not-a-production-secret" };
  await initializeVideoDeletionJournal(config); configureVideoRetentionJournal(engine, config, (q, e) => applyVideoRetention(engine, q, e, e)); await replayVideoRetentionJournal(engine);
  const ctx = { tenant_id: "impact_t", workspace_id: "impact_w", actor: { type: "user", id: "reviewer" }, policy_version: "fixture", scopes: ["intel.sources.write", "intel.knowledge.read"] } as ExecutionContext;
  const knowledge = new VideoKnowledgeService(engine), impact = new VideoRetentionImpact(knowledge);
  const profile = await engine.video.saveProfile(ctx, { name: "Synthetic", config: { required_capabilities: ["transcript"] } });
  async function seed(suffix: string) {
    const source = await engine.createSource(ctx, { kind: "bilibili", url: `https://space.bilibili.com/${suffix}`, config: { source_type: "account", author_id: suffix, profile_id: profile.id, profile_version: 1, usage_basis: "synthetic", allowed_uses: ["knowledge"] } });
    const job = await engine.video.start(ctx, `seed-${suffix}`, { source_id: source.id, native_id: `BVfixture${suffix}`, canonical_url: `https://www.bilibili.com/video/BVfixture${suffix}` });
    const doc = `doc_${suffix}`, ev = `ev_${suffix}`, kid = `knowledge_${suffix}`, release = `release_${suffix}`, skill = `candidate_${suffix}`;
    await db.query(`INSERT INTO flow_documents(id,tenant_id,workspace_id,source_id,external_id,url,title,video_asset_id,video_text_access_expires_at) VALUES($1,$2,$3,$4,$1,'https://example.invalid','private-title',$5,'2030-01-01')`, [doc, ctx.tenant_id, ctx.workspace_id, source.id, job.asset_id]);
    await db.query(`INSERT INTO flow_document_revisions(document_id,revision,tenant_id,content_hash,title,body,collected_by_run) VALUES($1,1,$2,$3,'private-title','private-body','fixture')`, [doc, ctx.tenant_id, sha("private-body")]);
    await db.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url) VALUES($1,$2,$3,$4,1,0,4,'private-quote','fixture',$5,'https://private.invalid')`, [ev, ctx.tenant_id, ctx.workspace_id, doc, sha("private-quote")]);
    await db.query(`UPDATE flow_video_jobs SET document_id=$2,revision=1,state='completed',completion_level='knowledge_ready' WHERE id=$1`, [job.video_job_id, doc]);
    await db.query(`INSERT INTO flow_video_objects(tenant_id,workspace_id,video_job_id,object_key,sha256,bytes,content_type,retention_class,access_expires_at,max_expires_at) VALUES($1,$2,$3,$4,$5,10,'video/mp4','media','2030-01-01','2030-01-01')`, [ctx.tenant_id, ctx.workspace_id, job.video_job_id, `secret-object-key/${suffix}`, sha("media")]);
    await db.query(`INSERT INTO flow_knowledge_units(id,tenant_id,workspace_id,profile_id,profile_version,content_hash,state,created_by,release_id) VALUES($1,$2,$3,$4,1,$5,'published','fixture',$6)`, [kid, ctx.tenant_id, ctx.workspace_id, profile.id, sha(kid), release]);
    await db.query(`INSERT INTO flow_knowledge_versions(tenant_id,workspace_id,knowledge_id,version,content_hash,unit,method,evidence_snapshot,created_by) VALUES($1,$2,$3,1,$4,'{"statement":"private-claim"}','{}','[]','fixture')`, [ctx.tenant_id, ctx.workspace_id, kid, sha(kid)]);
    await db.query(`INSERT INTO flow_knowledge_evidence_refs(tenant_id,workspace_id,knowledge_id,version,evidence_id,document_id,revision,snippet_hash) VALUES($1,$2,$3,1,$4,$5,1,$6)`, [ctx.tenant_id, ctx.workspace_id, kid, ev, doc, sha("private-quote")]);
    await db.query(`INSERT INTO flow_knowledge_releases(id,tenant_id,workspace_id,knowledge_id,version,content_hash,snapshot,published_by) VALUES($1,$2,$3,$4,1,$5,'{"statement":"private-claim"}','fixture')`, [release, ctx.tenant_id, ctx.workspace_id, kid, sha(kid)]);
    await db.query(`INSERT INTO flow_video_skill_candidates(id,tenant_id,workspace_id,skill_id,skill_version,candidate_hash,native_skill_hash,proposal,state,created_by) VALUES($1,$2,$3,$1,'1',$4,$4,'{"private":"method"}','deployed','fixture')`, [skill, ctx.tenant_id, ctx.workspace_id, sha(skill)]);
    await db.query(`INSERT INTO flow_video_skill_dependencies(tenant_id,workspace_id,candidate_id,release_id,knowledge_id,version,content_hash) VALUES($1,$2,$3,$4,$5,1,$6)`, [ctx.tenant_id, ctx.workspace_id, skill, release, kid, sha(kid)]);
    return { source, job, doc, ev, kid, skill };
  }
  const a = await seed("1"), b = await seed("2");
  const request = (a: Awaited<ReturnType<typeof seed>>, action = "revoked") => ({ asset_id: a.job.asset_id, action });
  const command = (preview: any, key: string) => ({ ...preview.target, action: preview.action, expected_impact_hash: preview.preview_hash, idempotency_key: key, reason: "Synthetic authorized review", confirmation: preview.action });
  await t.test("human source write role and workspace isolate both preview and mutations", async () => {
    await assert.rejects(impact.preview({ ...ctx, scopes: ["intel.video.read"] }, request(a)), /scope/);
    await assert.rejects(impact.preview({ ...ctx, actor: { type: "service_principal", id: "worker" } }, request(a)), /human_review_required/);
    await assert.rejects(impact.preview({ ...ctx, workspace_id: "foreign" }, request(a)), /asset_not_found/);
    engine.authorize = async () => false;
    await assert.rejects(impact.preview(ctx, request(a)), /grant_revoked/); engine.authorize = undefined;
  });
  const first = await impact.preview(ctx, request(a));
  await t.test("inventory includes exact scoped lineage without text, URLs or object keys", () => {
    assert.deepEqual(first.counts, { sources: 1, assets: 1, jobs: 1, objects: 1, documents: 1, evidence: 1, knowledge: 1, skills: 1, reports: 0, research: 0 });
    assert.equal(first.dependencies.evidence[0].id, a.ev); assert.equal(first.dependencies.skills[0].id, a.skill);
    assert.equal(first.current_visibility.published_knowledge, 1); assert.equal(first.after_action.historical_content_access, "denied");
    for (const secret of ["private-title", "private-body", "private-quote", "private-claim", "secret-object-key", "https://"]) assert.ok(!JSON.stringify(first).includes(secret));
    assert.equal(first.physical_cleanup.will_request, 1); assert.equal(first.audit_retained.financial_events, true);
  });
  await t.test("stale graph never appends the authoritative journal or silently expands", async () => {
    await db.query(`UPDATE flow_knowledge_units SET version=2 WHERE id=$1`, [a.kid]);
    const before = await videoRetentionCheckpoint(engine, ctx);
    const result = await impact.batch(ctx, { items: [command(first, "stale")] });
    assert.equal(result.results[0].ok, false); assert.equal(result.results[0].status, 409); assert.equal(result.results[0].reason, "retention_preview_changed");
    assert.deepEqual(await videoRetentionCheckpoint(engine, ctx), before);
    assert.equal((await db.query(`SELECT state FROM flow_knowledge_units WHERE id=$1`, [a.kid])).rows[0].state, "published");
    await db.query(`UPDATE flow_knowledge_units SET version=1 WHERE id=$1`, [a.kid]);
    await db.query(`UPDATE flow_video_objects SET access_expires_at='2029-01-01' WHERE video_job_id=$1`, [a.job.video_job_id]);
    assert.equal((await impact.batch(ctx, { items: [command(first, "changed-deadline")] })).results[0].status, 409, "Date-valued deadlines participate in hash");
    await db.query(`UPDATE flow_video_objects SET access_expires_at='2030-01-01' WHERE video_job_id=$1`, [a.job.video_job_id]);
    await db.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url) SELECT 'new-evidence',tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url FROM flow_evidence WHERE id=$1`, [a.ev]);
    assert.equal((await impact.batch(ctx, { items: [command(first, "expanded-graph")] })).results[0].status, 409, "new dependency requires new preview");
    await db.query(`DELETE FROM flow_evidence WHERE id='new-evidence'`);
    assert.deepEqual(await videoRetentionCheckpoint(engine, ctx), before);
  });
  const second = await impact.preview(ctx, request(b));
  await t.test("batch confirms irreversible action, then reports partial results and stable retries", async () => {
    await assert.rejects(impact.batch({ ...ctx, scopes: [] }, { items: [command(first, "denied")] }), /scope/);
    const foreign = await impact.batch({ ...ctx, workspace_id: "foreign" }, { items: [command(first, "foreign")] });
    assert.equal(foreign.results[0].status, 404);
    await assert.rejects(impact.batch(ctx, { items: [{ ...command(first, "none"), confirmation: undefined }] }), /irreversible_confirmation_required/);
    await db.query(`UPDATE flow_video_assets SET availability='remote_unavailable' WHERE id=$1`, [b.job.asset_id]);
    const input = { items: [command(first, "apply-one"), command(second, "stale-two")] };
    const result = await impact.batch(ctx, input);
    assert.equal(result.partial, true); assert.equal(result.results[0].ok, true); assert.equal(result.results[1].status, 409);
    const head = await videoRetentionCheckpoint(engine, ctx); assert.equal(head.head_sequence, 1);
    assert.deepEqual(await impact.batch(ctx, input), result); assert.deepEqual(await videoRetentionCheckpoint(engine, ctx), head);
  });
  await t.test("revocation denies current and historical access while audits and cleanup pending remain explicit", async () => {
    const after = await impact.preview(ctx, request(a));
    assert.equal(after.current_visibility.published_knowledge, 0); assert.equal(after.current_visibility.active_skill_candidates, 0);
    assert.equal(after.current_visibility.access_revoked_documents, 1); assert.equal(after.physical_cleanup.pending, 1); assert.equal(after.physical_cleanup.deleted, 0);
    assert.equal(after.dependencies.knowledge[0].state, "withdrawn"); assert.equal(after.dependencies.skills[0].state, "retired");
    await assert.rejects(knowledge.get(ctx, a.kid), /knowledge_not_published/);
    assert.equal((await db.query(`SELECT body FROM flow_document_revisions WHERE document_id=$1`, [a.doc])).rows[0].body, "private-body");
    const erase = await impact.preview(ctx, request(a, "erased"));
    assert.equal((await impact.batch(ctx, { items: [command(erase, "erase-one")] })).results[0].ok, true);
    assert.equal((await db.query(`SELECT body FROM flow_document_revisions WHERE document_id=$1`, [a.doc])).rows[0].body, "");
    assert.equal((await db.query(`SELECT count(*) FROM flow_knowledge_versions WHERE knowledge_id=$1`, [a.kid])).rows[0].count, 1);
    assert.equal((await impact.preview(ctx, request(a))).physical_cleanup.pending, 1);
    assert.equal((await videoRetentionCheckpoint(engine, ctx)).head_sequence, 2);
  });
  await t.test("non-destructive pause leaves knowledge available and oversize preview never truncates", async () => {
    const pause = await impact.preview(ctx, { source_id: b.source.id, action: "subscription_paused" });
    assert.equal((await impact.batch(ctx, { items: [command(pause, "pause-only")] })).results[0].ok, true);
    assert.equal((await db.query(`SELECT state FROM flow_knowledge_units WHERE id=$1`, [b.kid])).rows[0].state, "published");
    assert.equal((await videoRetentionCheckpoint(engine, ctx)).head_sequence, 2);
    await db.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url)
      SELECT 'bounded_'||n,e.tenant_id,e.workspace_id,e.document_id,e.revision,e.char_start,e.char_end,e.quote,e.created_by,e.snippet_hash,e.url FROM flow_evidence e CROSS JOIN generate_series(1,500) n WHERE e.id=$1`, [b.ev]);
    await assert.rejects(impact.preview(ctx, request(b)), /retention_impact_too_large_choose_asset/);
  });
});

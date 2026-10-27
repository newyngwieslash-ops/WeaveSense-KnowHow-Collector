import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgliteDb, migrate } from "./db.ts";
import { Engine } from "./engine.ts";
import { canonicalHash, sha } from "./video-contract.ts";
import { VideoKnowledgeService, applyVideoRetention } from "./video-knowledge.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { normalizeVideoRetentionConfig, registerVideoRetention, stampVideoTextRetention, expireVideoObjects } from "./video-retention-policy.ts";

const scope = { tenant_id: "ttl-tenant", workspace_id: "ttl-workspace" };
const policy = () => ({ version: 1, ...Object.fromEntries(["media", "audio", "frame", "transcript", "evidence"].map(x => [x, { access_seconds: ["transcript", "evidence"].includes(x) ? 600 : 60, maximum_seconds: 1200 }])) });
async function fixture() {
  const db = await pgliteDb(); await migrate(db);
  const anchor = new Date(Date.now() - 120000); let now = new Date(anchor.getTime() + 120000);
  const engine = new Engine(db, async () => [], () => now); engine.video.enabled = true;
  const directory = await mkdtemp(join(tmpdir(), "ttl-journal-"));
  const journal = { directory: join(directory, "journal"), journalId: "ttl-fixture", key: "fixture-only-journal-key-never-production" };
  await initializeVideoDeletionJournal(journal); configureVideoRetentionJournal(engine, journal, (q, e) => applyVideoRetention(engine, q, e, e)); await replayVideoRetentionJournal(engine);
  const config = { retention_policy: policy() }; normalizeVideoRetentionConfig(config);
  await db.query(`INSERT INTO flow_video_profiles(id,tenant_id,workspace_id,version,name,config,content_hash,created_by) VALUES('p',$1,$2,1,'TTL fixture',$3,$4,'fixture')`, [scope.tenant_id, scope.workspace_id, JSON.stringify(config), canonicalHash(config)]);
  await db.query(`INSERT INTO flow_sources(id,tenant_id,workspace_id,kind,url,config) VALUES('s',$1,$2,'bilibili','https://www.bilibili.com/video/BVttl','{"allowed_uses":["knowledge"]}')`, [scope.tenant_id, scope.workspace_id]);
  await db.query(`INSERT INTO flow_video_assets(id,tenant_id,workspace_id,platform,native_id,canonical_url) VALUES('a',$1,$2,'bilibili','BVttl','https://www.bilibili.com/video/BVttl')`, [scope.tenant_id, scope.workspace_id]);
  await db.query(`INSERT INTO flow_video_asset_sources(tenant_id,workspace_id,asset_id,source_id) VALUES($1,$2,'a','s')`, [scope.tenant_id, scope.workspace_id]);
  await db.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,grant_actor,policy_version,state,created_at) VALUES('j','op',$1,$2,'s','a','p',1,'fp','{}','user:fixture','fixture','completed',$3)`, [scope.tenant_id, scope.workspace_id, anchor.toISOString()]);
  const job = (await db.query(`SELECT * FROM flow_video_jobs WHERE id='j'`)).rows[0];
  const addObject = async (key: string, content_type: string, retention_class?: string) => {
    const object = { object_key: key, sha256: sha(key), content_type, retention_class };
    await db.query(`INSERT INTO flow_video_objects(tenant_id,workspace_id,video_job_id,object_key,sha256,bytes,content_type) VALUES($1,$2,'j',$3,$4,10,$5)`, [scope.tenant_id, scope.workspace_id, key, object.sha256, content_type]);
    await db.tx(q => registerVideoRetention(q, job, [object], now)); return object;
  };
  const body = "Fixed historical source statement 😀", title = "TTL fixture";
  const material = async () => {
    await db.query(`INSERT INTO flow_documents(id,tenant_id,workspace_id,source_id,external_id,url,title,video_asset_id) VALUES('d',$1,$2,'s','ttl','https://www.bilibili.com/video/BVttl',$3,'a')`, [scope.tenant_id, scope.workspace_id, title]);
    await db.query(`INSERT INTO flow_document_revisions(document_id,revision,tenant_id,content_hash,title,body,collected_by_run,material_type) VALUES('d',1,$1,$2,$3,$4,'fixture','platform_subtitles')`, [scope.tenant_id, sha(title + "\n\n" + body), title, body]);
    await db.query(`UPDATE flow_video_jobs SET document_id='d',revision=1 WHERE id='j'`);
    await db.tx(q => stampVideoTextRetention(q, job, "d", 1, new Date(anchor.getTime() + 1000)));
    // Insert after ready stamping to exercise the DB trigger used by legacy evidence paths.
    await db.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash) VALUES('e',$1,$2,'d',1,$3,$4,$5,'fixture',$6)`, [scope.tenant_id, scope.workspace_id, title.length + 2, title.length + 2 + body.length, body, sha(body)]);
    return { evidence_id: "e", revision: 1, snippet_hash: sha(body) };
  };
  const close = async () => { await db.close(); await rm(directory, { recursive: true, force: true }); };
  return { db, engine, job, config, anchor, journal, addObject, material, close, advance: (seconds: number) => { now = new Date(anchor.getTime() + seconds * 1000); } };
}

test("COL029 typed TTL exposes bounded defaults and rejects impossible or partial policies", () => {
  const cfg: any = {}; const value = normalizeVideoRetentionConfig(cfg);
  assert.equal(value.media.access_seconds, 86400); assert.equal(value.frame.access_seconds, 604800); assert.equal(value.evidence.maximum_seconds, 2592000); assert.deepEqual(cfg.retention_policy, value);
  assert.throws(() => normalizeVideoRetentionConfig({ retention_policy: { version: 1, media: { access_seconds: 1, maximum_seconds: 1 } } }), /INVALID_RETENTION_DURATION/);
  const invalid: any = policy(); invalid.media.maximum_seconds = 100;
  assert.throws(() => normalizeVideoRetentionConfig({ retention_policy: invalid }), /RETENTION_DEPENDENCY_CONFLICT/);
});

test("COL029 media access expiry retains fixed proof/text, respects active jobs, and never renews late objects", async () => {
  const s = await fixture();
  try {
    const media = await s.addObject("media", "video/mp4", "media"), ref = await s.material();
    await s.addObject("audio", "audio/wav", "audio"); await s.addObject("frame", "image/jpeg", "frame"); await s.addObject("transcript", "application/json", "transcript"); await s.addObject("summary", "application/json", "derived");
    await s.db.query(`INSERT INTO flow_video_temporal_evidence(evidence_id,tenant_id,workspace_id,video_job_id,start_ms,end_ms,frame_ref,alignment_method,media_sha256,material_type) VALUES('e',$1,$2,'j',0,1000,'frame','temporal_overlap',$3,'platform_subtitles')`, [scope.tenant_id, scope.workspace_id, media.sha256]);
    await expireVideoObjects(s.engine);
    let objects = (await s.db.query(`SELECT * FROM flow_video_objects ORDER BY object_key`)).rows;
    assert.equal(objects.find(x => x.object_key === "audio").state, "delete_pending");
    for (const key of ["frame", "media"]) { const object = objects.find(x => x.object_key === key); assert.equal(object.state, "accepted"); assert.equal(object.retained_for_evidence, true); assert.ok(object.reference_count > 0); }
    const k = new VideoKnowledgeService(s.engine); assert.equal((await k.resolveEvidence(scope, [ref]))[0].quote, "Fixed historical source statement 😀");
    assert.ok((await s.db.query(`SELECT video_expires_at FROM flow_evidence WHERE id='e'`)).rows[0].video_expires_at);
    await s.db.query(`UPDATE flow_video_jobs SET state='running' WHERE id='j'`);
    s.advance(180); await s.addObject("late-audio", "audio/wav", "audio"); await expireVideoObjects(s.engine);
    const late = (await s.db.query(`SELECT * FROM flow_video_objects WHERE object_key='late-audio'`)).rows[0];
    assert.equal(late.state, "accepted"); assert.equal(late.expiry_reason, "active_job_hold"); assert.equal(new Date(late.access_expires_at).getTime(), s.anchor.getTime() + 60000);
    await assert.rejects(s.addObject("mislabeled", "image/jpeg", "audio"), /INVALID_RETENTION_ARTIFACT_TYPE/);
    await s.db.query(`UPDATE flow_video_profiles SET config=jsonb_set(config,'{retention_policy,media,access_seconds}','120') WHERE id='p'`);
    await assert.rejects(s.db.tx(q => registerVideoRetention(q, s.job, [], new Date())), /FROZEN_RETENTION_POLICY_CHANGED/);
  } finally { await s.close(); }
});

test("COL029 projection feed journals text access revocation, hard cap scrubs lineage without forging physical deletion", async () => {
  const s = await fixture();
  try {
    await s.addObject("transcript", "application/json", "transcript"); await s.material();
    await s.db.query(`INSERT INTO flow_video_embedding_staging(tenant_id,workspace_id,video_job_id,payload,manifest_hash,input_hash,profile_hash,config,required,state) VALUES($1,$2,'j','{"text":"must erase"}','hash','hash','hash','{}',true,'queued')`, [scope.tenant_id, scope.workspace_id]);
    const k = new VideoKnowledgeService(s.engine), reader: any = { ...scope, actor: { type: "service_principal", id: "video-projection-reader" }, scopes: ["intel.video.read"] };
    s.advance(700); const feed = await k.projectionFeed(reader);
    assert.ok(feed.items.some(x => x.payload.action === "revoked"));
    assert.ok((await s.db.query(`SELECT body FROM flow_document_revisions WHERE document_id='d'`)).rows[0].body);
    assert.equal((await s.db.query(`SELECT count(*)::int n FROM flow_video_deletion_journal_receipts`)).rows[0].n, 1);
    s.advance(1300); await expireVideoObjects(s.engine);
    const job = (await s.db.query(`SELECT * FROM flow_video_jobs WHERE id='j'`)).rows[0];
    assert.ok(job.text_retention_erased_at); assert.equal(job.execution_erased_at, null); assert.equal(job.state, "cancelled");
    assert.equal((await s.db.query(`SELECT body FROM flow_document_revisions WHERE document_id='d'`)).rows[0].body, "");
    assert.equal((await s.db.query(`SELECT quote FROM flow_evidence WHERE id='e'`)).rows[0].quote, "");
    assert.deepEqual((await s.db.query(`SELECT payload FROM flow_video_embedding_staging WHERE video_job_id='j'`)).rows[0].payload, {});
    assert.equal((await s.db.query(`SELECT count(*)::int n FROM flow_video_deletion_journal_receipts`)).rows[0].n, 2);
    await expireVideoObjects(s.engine); assert.equal((await s.db.query(`SELECT count(*)::int n FROM flow_video_deletion_journal_receipts`)).rows[0].n, 2);
  } finally { await s.close(); }
});

test("COL029 deadline read guards deny before maintenance and missing journal cannot acknowledge expiry", async () => {
  const s = await fixture();
  try {
    const ref = await s.material();
    await s.db.query(`UPDATE flow_documents SET video_text_access_expires_at='2000-01-01' WHERE id='d'`);
    await assert.rejects(new VideoKnowledgeService(s.engine).resolveEvidence(scope, [ref]), /evidence_unavailable_or_changed/);
    configureVideoRetentionJournal(s.engine, { ...s.journal, directory: join(s.journal.directory, "missing") }, (q, e) => applyVideoRetention(s.engine, q, e, e));
    s.advance(1300); await assert.rejects(expireVideoObjects(s.engine), /video_journal_/);
    const job = (await s.db.query(`SELECT text_retention_erased_at,execution_erased_at FROM flow_video_jobs WHERE id='j'`)).rows[0];
    assert.equal(job.text_retention_erased_at, null); assert.equal(job.execution_erased_at, null);
  } finally { await s.close(); }
});

test("COL029 scoped sweeps preserve foreign workspace and disclose bounded expiry backlog", async () => {
  const s = await fixture();
  try {
    await s.material();
    await s.db.query(`INSERT INTO flow_video_assets(id,tenant_id,workspace_id,platform,native_id,canonical_url) VALUES('b',$1,$2,'bilibili','BVsecond','https://www.bilibili.com/video/BVsecond')`, [scope.tenant_id, scope.workspace_id]);
    await s.db.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,grant_actor,policy_version,state,created_at) VALUES('j2','op2',$1,$2,'s','b','p',1,'fp2','{}','user:fixture','fixture','completed',$3)`, [scope.tenant_id, scope.workspace_id, s.anchor.toISOString()]);
    await s.db.query(`INSERT INTO flow_video_profiles(id,tenant_id,workspace_id,version,name,config,content_hash,created_by) SELECT 'pf',tenant_id,'foreign',version,name,config,content_hash,created_by FROM flow_video_profiles WHERE id='p'`);
    await s.db.query(`INSERT INTO flow_sources(id,tenant_id,workspace_id,kind,url,config) VALUES('sf',$1,'foreign','bilibili','https://www.bilibili.com/video/BVforeign','{}')`, [scope.tenant_id]);
    await s.db.query(`INSERT INTO flow_video_assets(id,tenant_id,workspace_id,platform,native_id,canonical_url) VALUES('af',$1,'foreign','bilibili','BVforeign','https://www.bilibili.com/video/BVforeign')`, [scope.tenant_id]);
    await s.db.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,grant_actor,policy_version,state,created_at) VALUES('jf','opf',$1,'foreign','sf','af','pf',1,'fpf','{}','user:fixture','fixture','completed',$2)`, [scope.tenant_id, s.anchor.toISOString()]);
    s.advance(1300);
    assert.equal((await expireVideoObjects(s.engine, 1, scope)).backlog, true);
    assert.equal((await expireVideoObjects(s.engine, 1, scope)).backlog, false);
    const foreign = (await s.db.query(`SELECT retention_policy_hash,text_retention_erased_at,state FROM flow_video_jobs WHERE id='jf'`)).rows[0];
    assert.equal(foreign.retention_policy_hash, null); assert.equal(foreign.text_retention_erased_at, null); assert.equal(foreign.state, "completed");
    assert.equal((await s.db.query(`SELECT count(*)::int n FROM flow_video_deletion_journal_receipts WHERE workspace_id='foreign'`)).rows[0].n, 0);
  } finally { await s.close(); }
});

test("COL029 expired source authorization journals cache revocation before advertising a projection checkpoint", async () => {
  const s = await fixture();
  try {
    await s.material();
    await s.db.query(`UPDATE flow_sources SET config=config || '{"authorization_expires_at":"2000-01-01T00:00:00Z"}'::jsonb WHERE id='s'`);
    const reader: any = { ...scope, actor: { type: "service_principal", id: "video-projection-reader" }, scopes: ["intel.video.read"] };
    const k = new VideoKnowledgeService(s.engine), feed = await k.projectionFeed(reader);
    assert.ok(feed.items.some(x => x.payload.action === "revoked" && x.payload.document_ids.includes("d")));
    assert.equal((await s.db.query(`SELECT status FROM flow_sources WHERE id='s'`)).rows[0].status, "revoked");
    assert.ok((await s.db.query(`SELECT body FROM flow_document_revisions WHERE document_id='d'`)).rows[0].body);
    await k.projectionFeed(reader);
    assert.equal((await s.db.query(`SELECT count(*)::int n FROM flow_video_deletion_journal_receipts`)).rows[0].n, 1);
  } finally { await s.close(); }
});

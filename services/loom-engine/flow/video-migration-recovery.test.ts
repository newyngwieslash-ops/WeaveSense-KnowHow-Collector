import test from "node:test";
import assert from "node:assert/strict";
import { migrate, pgliteDb, pgDb, type Db } from "./db.ts";
import { Engine } from "./engine.ts";
import { sha } from "./video-contract.ts";

// Fail a real SQL transaction midway through the new migration; the wrapper
// supplies only fault timing, never fabricated rows or transaction outcomes.
async function recovery(db: Db) {
  const interrupted: Db = { ...db, tx: fn => db.tx(q => fn({ query: (sql, params) =>
    q.query(sql.startsWith("ALTER TABLE flow_video_knowledge_runs ADD COLUMN external_task_status") ? "SELECT 1 / 0" : sql, params) })) };
  await assert.rejects(migrate(interrupted), /division by zero/);
  assert.equal((await db.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='flow_video_knowledge_runs' AND column_name='model_generation'`)).rows[0].n, 0);
  const scope = { tenant_id: "migration-tenant", workspace_id: "migration-workspace", actor: { type: "user", id: "migration-reviewer" }, policy_version: "fixture" };
  const engine = new Engine(db); engine.video.enabled = true;
  const profile = await engine.video.saveProfile(scope, { name: "Synthetic migration-only fixture", config: { required_capabilities: ["transcript"] } });
  const source = { id: "migration-source" };
  await db.query(`INSERT INTO flow_sources(id,tenant_id,workspace_id,kind,url,config) VALUES($1,$2,$3,'bilibili','https://www.bilibili.com/video/BV1MIGRATE001',$4)`,
    [source.id, scope.tenant_id, scope.workspace_id, JSON.stringify({ source_type: "video", native_id: "BV1MIGRATE001", profile_id: profile.id, profile_version: profile.version, allowed_uses: ["knowledge"], usage_basis: "Synthetic old-schema migration fixture" })]);
  // A prior revision/reference is intentionally seeded as old-schema data. This
  // test is migration resilience, not proof of media acquisition or model quality.
  await db.query(`INSERT INTO flow_documents(id,tenant_id,workspace_id,source_id,external_id,url,title)
    VALUES('migration-document',$1,$2,$3,'old-material','https://example.invalid/fixture','Historical 😀')`, [scope.tenant_id, scope.workspace_id, source.id]);
  for (const revision of [1, 2]) {
    const body = `Historical source revision ${revision} 😀`;
    await db.query(`INSERT INTO flow_document_revisions(document_id,revision,tenant_id,content_hash,title,body,collected_by_run,material_type)
      VALUES('migration-document',$1,$2,$3,'Historical 😀',$4,'migration-fixture','platform_subtitles')`, [revision, scope.tenant_id, sha(`Historical 😀\n\n${body}`), body]);
    await db.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url)
      VALUES($1,$2,$3,'migration-document',$4,15,$5,$6,'fixture',$7,'https://example.invalid/fixture')`, [`migration-evidence-${revision}`, scope.tenant_id, scope.workspace_id, revision, 15 + body.length, body, sha(body)]);
  }
  const asset = "migration-asset", id = "migration-unfinished";
  await db.query(`INSERT INTO flow_video_assets(id,tenant_id,workspace_id,platform,native_id,canonical_url)
    VALUES($1,$2,$3,'bilibili','BV1MIGRATE001','https://www.bilibili.com/video/BV1MIGRATE001')`, [asset, scope.tenant_id, scope.workspace_id]);
  await db.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,grant_actor,policy_version)
    VALUES($1,'migration-operation',$2,$3,$4,$5,$6,1,'migration-fingerprint','{}','user:migration-reviewer','fixture')`, [id, scope.tenant_id, scope.workspace_id, source.id, asset, profile.id]);
  await db.query(`INSERT INTO flow_video_stages(tenant_id,workspace_id,video_job_id,stage,next_poll_at) VALUES($1,$2,$3,'input',now()-interval '1 second')`, [scope.tenant_id, scope.workspace_id, id]);
  const snapshot = async () => ({
    revisions: (await db.query(`SELECT document_id,revision,content_hash,title,body FROM flow_document_revisions WHERE document_id='migration-document' ORDER BY revision`)).rows,
    evidence: (await db.query(`SELECT id,document_id,revision,snippet_hash,quote FROM flow_evidence WHERE document_id='migration-document' ORDER BY id`)).rows,
  });
  const before = await snapshot();
  await assert.rejects(migrate(interrupted), /division by zero/);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await db.query(`SELECT count(*)::int n FROM flow_schema_migrations WHERE name='0031_video_extraction_retry.sql'`)).rows[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='flow_video_knowledge_runs' AND column_name='model_generation'`)).rows[0].n, 0);
  const applied = await migrate(db);
  assert.ok(applied.includes("0031_video_extraction_retry.sql"));
  assert.ok(applied.includes("0032_video_skill_evaluation_retry.sql"));
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await migrate(db), []);
  // Resume an existing pre-upgrade runnable row, not a newly generated identity.
  const claim = await engine.video.claim("resumed-after-migration");
  assert.equal(claim.video_job_id, id); assert.equal(claim.stage, "input");
  assert.deepEqual(await snapshot(), before);
}

test("AC28 PGlite: failed additive migration rolls back schema/ledger and preserves historical revisions", async () => {
  const db = await pgliteDb(); try { await recovery(db); } finally { await db.close(); }
});

const url = process.env.FLOW_VIDEO_TEST_PG_URL;
test("AC28 PostgreSQL: failed additive migration is atomic and retry preserves references", { skip: !url && "isolated FLOW_VIDEO_TEST_PG_URL required" }, async () => {
  const admin = await pgDb(url!), name = `qa_migration_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const target = new URL(url!); target.pathname = `/${name}`;
  const db = await pgDb(target.toString());
  try { await recovery(db); } finally { await db.close(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.close(); }
});

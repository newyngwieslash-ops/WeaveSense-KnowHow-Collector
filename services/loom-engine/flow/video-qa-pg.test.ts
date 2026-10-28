// Opt-in real PostgreSQL test. Use ONLY an isolated disposable database owned by
// a non-superuser CREATEDB test role. No PGlite substitution is allowed here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgDb, migrate, withTenant } from "./db.ts";
import { Engine } from "./engine.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { applyVideoRetention, VideoKnowledgeService } from "./video-knowledge.ts";
import { sha } from "./video-contract.ts";
import { Reports } from "./reports.ts";
import { closeIsolatedPostgresDatabase } from "../validation/video-knowledge/pg-test-cleanup.ts";

const url = process.env.FLOW_VIDEO_TEST_PG_URL;
test("QA PostgreSQL: real independent connections serialize claims, preserve restart fence and enforce video FORCE RLS", { skip: !url && "FLOW_VIDEO_TEST_PG_URL not configured" }, async t => {
  const maintenance = await pgDb(url!), name = `qa_claims_${process.pid}_${Date.now()}`;
  await maintenance.query(`CREATE DATABASE "${name}"`);
  const databaseURL = new URL(url!); databaseURL.pathname = `/${name}`;
  let db = await pgDb(databaseURL.toString()); await migrate(db);
  const other = await pgDb(databaseURL.toString()); t.after(() => closeIsolatedPostgresDatabase(maintenance, name, [db, other]));
  let now = new Date("2026-10-26T00:00:00Z");
  const first = new Engine(db, async () => [], () => now), second = new Engine(other, async () => [], () => now);
  first.video.enabled = true; second.video.enabled = true;
  const directory = await mkdtemp(join(tmpdir(), "qa-pg-claim-journal-"));
  const journal = { directory: join(directory, "journal"), journalId: "qa-claims", key: "q".repeat(48) };
  await initializeVideoDeletionJournal(journal);
  const configure = (engine: Engine) => configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
  configure(first); configure(second); await replayVideoRetentionJournal(first);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scope = { tenant_id: "pg_qa_a", workspace_id: "pg_qa_w", actor: { type: "user", id: "pg_reviewer" }, policy_version: "qa_v1" };
  const role = (await db.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.equal(role.rolsuper, false, "superuser would invalidate RLS evidence");
  const profile = await first.video.saveProfile(scope, { name: "Real PostgreSQL fixture", config: { required_capabilities: ["transcript"] } });
  const source = await first.createSource(scope, { kind: "bilibili", title: "Synthetic PG source", url: "https://www.bilibili.com/video/BV1PGQA00001", config: { source_type: "video", native_id: "BV1PGQA00001", profile_id: profile.id, profile_version: 1, usage_basis: "Synthetic concurrency test; no platform", allowed_uses: ["knowledge"] } });
  const job = await first.video.start(scope, "pg-claim", { source_id: source.id });
  const claims = await Promise.all([first.video.claim("pg-worker-a"), second.video.claim("pg-worker-b")]);
  const claimed = claims.filter(Boolean);
  assert.equal(claimed.length, 1, "two independent PostgreSQL pools must not both claim one stage");
  assert.equal(claimed[0].video_job_id, job.video_job_id);
  await withTenant("pg_qa_b", async () => {
    assert.equal((await db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 0);
    await assert.rejects(first.video.get({ ...scope, tenant_id: "pg_qa_b" }, job.video_job_id), (e: any) => e.status === 404);
    assert.equal((await db.query("UPDATE flow_video_jobs SET tenant_id='pg_qa_b' WHERE id=$1 RETURNING id", [job.video_job_id])).rows.length, 0, "foreign write is hidden by FORCE RLS");
  });
  const forced = (await db.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='flow_video_jobs'::regclass")).rows[0];
  assert.equal(forced.relforcerowsecurity, true);
  await db.close(); db = await pgDb(databaseURL.toString());
  now = new Date(now.getTime() + 120000);
  const restarted = new Engine(db, async () => [], () => now); restarted.video.enabled = true;
  configure(restarted);
  const recovered = await restarted.video.claim("pg-worker-restarted");
  assert.equal(recovered.video_job_id, job.video_job_id);
  assert.ok(Number(recovered.fencing_token) > Number(claimed[0].fencing_token));
  await assert.rejects(restarted.video.heartbeat(claimed[0]), (e: any) => e.reason === "STALE_FENCE");
  await restarted.video.cancel(scope, job.video_job_id, "Finish first concurrency fixture");
  const interrupted = await restarted.video.start(scope, "pg-process-kill", { source_id: source.id, content_version: "worker-process-v2" });
  const script = `import {pgDb} from ${JSON.stringify(new URL("./db.ts", import.meta.url).href)}; import {Engine} from ${JSON.stringify(new URL("./engine.ts", import.meta.url).href)};
    import {configureVideoRetentionJournal,replayVideoRetentionJournal} from ${JSON.stringify(new URL("./video-journal.ts", import.meta.url).href)};
    import {applyVideoRetention} from ${JSON.stringify(new URL("./video-knowledge.ts", import.meta.url).href)};
    const db=await pgDb(process.env.FLOW_VIDEO_TEST_PG_URL);const e=new Engine(db,async()=>[],()=>new Date(${JSON.stringify(now.toISOString())}));e.video.enabled=true;
    configureVideoRetentionJournal(e,JSON.parse(process.env.VIDEO_QA_JOURNAL),(q,event)=>applyVideoRetention(e,q,event,event));await replayVideoRetentionJournal(e);
    const stage=await e.video.claim('actual-killed-worker');process.stdout.write(JSON.stringify(stage)+'\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, FLOW_VIDEO_TEST_PG_URL: databaseURL.toString(), VIDEO_QA_JOURNAL: JSON.stringify(journal) }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  const line = createInterface({ input: child.stdout });
  let timer: ReturnType<typeof setTimeout>;
  const stage = await Promise.race([once(line, "line").then(([value]) => JSON.parse(value)), once(child, "exit").then(() => { throw new Error("worker exited before claim: " + stderr); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("worker claim deadline: " + stderr)), 10000); timer.unref(); })]).finally(() => clearTimeout(timer));
  assert.equal((stage as any).video_job_id, interrupted.video_job_id);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  now = new Date(now.getTime() + 120000);
  const afterKill = await restarted.video.claim("replacement-after-SIGKILL");
  assert.equal(afterKill.video_job_id, interrupted.video_job_id);
  assert.ok(Number(afterKill.fencing_token) > Number((stage as any).fencing_token));
  await assert.rejects(restarted.video.heartbeat(stage), (e: any) => e.reason === "STALE_FENCE");
  await restarted.video.cancel(scope, interrupted.video_job_id, "Finish isolated killed-worker fixture");
  // Use the real node-postgres int8 decoder, not PGlite's numeric representation.
  const title = "Synthetic temporal fixture", quote = "Self-authored temporal source.";
  const asset = (await db.query(`SELECT asset_id FROM flow_video_jobs WHERE id=$1`, [job.video_job_id])).rows[0].asset_id;
  await db.query(`INSERT INTO flow_documents(id,tenant_id,workspace_id,source_id,external_id,url,title,video_asset_id,video_text_access_expires_at)
    VALUES('pg-temporal-doc',$1,$2,$3,'pg-temporal','https://www.bilibili.com/video/BV1PGQA00001',$4,$5,now()+interval '1 day')`, [scope.tenant_id, scope.workspace_id, source.id, title, asset]);
  await db.query(`INSERT INTO flow_document_revisions(document_id,revision,tenant_id,content_hash,title,body,collected_by_run,material_type)
    VALUES('pg-temporal-doc',1,$1,$2,$3,$4,'fixture','platform_subtitles')`, [scope.tenant_id, sha(title + "\n\n" + quote), title, quote]);
  await db.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,snippet_hash,url)
    VALUES('pg-temporal-ev',$1,$2,'pg-temporal-doc',1,$3,$4,$5,'fixture',$6,'https://www.bilibili.com/video/BV1PGQA00001')`, [scope.tenant_id, scope.workspace_id, title.length + 2, title.length + 2 + quote.length, quote, sha(quote)]);
  await db.query(`INSERT INTO flow_video_temporal_evidence(evidence_id,tenant_id,workspace_id,video_job_id,start_ms,end_ms,alignment_method,material_type)
    VALUES('pg-temporal-ev',$1,$2,$3,0,4000,'segment','platform_subtitles')`, [scope.tenant_id, scope.workspace_id, job.video_job_id]);
  await db.query(`UPDATE flow_video_jobs SET document_id='pg-temporal-doc',revision=1 WHERE id=$1`, [job.video_job_id]);
  assert.equal(typeof (await db.query(`SELECT start_ms FROM flow_video_temporal_evidence WHERE evidence_id='pg-temporal-ev'`)).rows[0].start_ms, "string");
  const knowledge = new VideoKnowledgeService(restarted), reports = new Reports(restarted);
  const projections = [
    (await knowledge.resolveEvidence(scope, [{ evidence_id: "pg-temporal-ev", revision: 1, snippet_hash: sha(quote) }]))[0],
    (await restarted.listEvidence(scope, "pg-temporal-doc"))[0],
    (await restarted.video.artifacts(scope, job.video_job_id)).items[0],
    (await reports.resolveEvidence(scope, ["pg-temporal-ev"]))[0],
  ];
  for (const item of projections) {
    assert.equal(item.start_ms, 0); assert.equal(item.end_ms, 4000);
  }
  assert.equal((await restarted.listEvidence({ ...scope, tenant_id: "pg_qa_b" }, "pg-temporal-doc")).length, 0);
  t.diagnostic("actual PostgreSQL non-superuser FORCE RLS, two pools, close/reopen, real SIGKILL worker replacement and stale-fence rejection; no platform/model calls");
});

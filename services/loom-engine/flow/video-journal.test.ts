import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FileVideoDeletionJournal, configureVideoRetentionJournal, initializeVideoDeletionJournal, replayVideoRetentionJournal,
  appendVideoRetentionIntent, markVideoRetentionApplied, lockVideoRetentionTransaction, videoRetentionCheckpoint, type VideoRetentionEvent } from "./video-journal.ts";
import { pgliteDb, migrate } from "./db.ts";

const run = promisify(execFile);
const event = (id = "event1", workspace = "workspace1"): VideoRetentionEvent => ({ version: 1, event_id: id, tenant_id: "tenant1", workspace_id: workspace,
  action: "erased", asset_id: "asset1", request_hash: "a".repeat(64), actor_hash: "b".repeat(64), requested_at: "2026-10-26T00:00:00.000Z" });
async function fixture(t: any) {
  const parent = await mkdtemp(join(tmpdir(), "video-journal-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const config = { directory: join(parent, "journal"), journalId: "synthetic-journal", key: "synthetic-only-journal-key-000000000000", lockTimeoutMs: 200 };
  await initializeVideoDeletionJournal(config);
  return { config, journal: new FileVideoDeletionJournal(config) };
}

test("external journal fsync acknowledgement, strict non-content contract and idempotency", async t => {
  const { config, journal } = await fixture(t);
  const a = await journal.append(event());
  const retry = await journal.append({ ...event(), requested_at: "2026-10-27T00:00:00.000Z" });
  assert.deepEqual(a, retry);
  assert.equal((await new FileVideoDeletionJournal(config).snapshot()).head.sequence, 1);
  await assert.rejects(journal.append({ ...event(), request_hash: "c".repeat(64) }), /idempotency_conflict/);
  await assert.rejects(journal.append({ ...event("extra"), reason: "must never be persisted" } as any), /invalid_event/);
  await assert.rejects(journal.append({ ...event("invalid"), asset_id: "../bad" }), /invalid_event/);
  assert.equal((await readdir(join(config.directory, "events"))).length, 1);
  await assert.rejects(new FileVideoDeletionJournal({ ...config, key: "different-synthetic-key-000000000000" }).snapshot(), /authentication_failed/);
  await assert.rejects(new FileVideoDeletionJournal({ ...config, journalId: "wrong-journal" }).snapshot(), /identity_mismatch/);
});

test("multi-process duplicate append yields one durable event and separate commands preserve chain", async t => {
  const { config, journal } = await fixture(t);
  config.lockTimeoutMs = 10_000;
  const moduleURL = new URL("./video-journal.ts", import.meta.url).href;
  const append = (e: VideoRetentionEvent) => run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import {FileVideoDeletionJournal} from ${JSON.stringify(moduleURL)}; await new FileVideoDeletionJournal(${JSON.stringify(config)}).append(${JSON.stringify(e)});`]);
  await Promise.all(Array.from({ length: 5 }, () => append(event())));
  assert.equal((await journal.snapshot()).head.sequence, 1);
  await Promise.all(Array.from({ length: 5 }, (_, i) => append(event(`event-${i + 2}`))));
  assert.equal((await journal.snapshot()).head.sequence, 6);
});

test("missing/torn/head-behind journal fails closed; offline recovery only advances valid complete records", async t => {
  const { config, journal } = await fixture(t);
  const empty = await readFile(join(config.directory, "head.json"));
  const record = await journal.append(event());
  await writeFile(join(config.directory, "head.json"), empty);
  await assert.rejects(journal.snapshot(), /watermark_uncertain/);
  await assert.rejects(journal.recoverOffline("wrong"), /acknowledgement_required/);
  const pendingHead = join(config.directory, ".head-00000000-0000-4000-8000-000000000001.tmp");
  await writeFile(pendingHead, JSON.stringify({ ...(await journal.recoverOffline("ALL_JOURNAL_CLIENTS_STOPPED")) }), { mode: 0o600 });
  await writeFile(join(config.directory, "head.json"), empty);
  await assert.rejects(journal.snapshot(), /outcome_unknown/);
  assert.equal((await journal.recoverOffline("ALL_JOURNAL_CLIENTS_STOPPED")).hash, record.hash);
  assert.equal((await journal.snapshot()).head.sequence, 1);
  await mkdir(join(config.directory, ".lock"), { mode: 0o700 });
  await assert.rejects(journal.snapshot(), /locked_or_outcome_unknown/);
  await journal.recoverOffline("ALL_JOURNAL_CLIENTS_STOPPED");
  const file = join(config.directory, "events", "000000000001.json");
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace('"workspace1"', '"workspace2"'));
  await assert.rejects(journal.snapshot(), /authentication_failed/);
  await assert.rejects(journal.recoverOffline("ALL_JOURNAL_CLIENTS_STOPPED"), /authentication_failed/);
  await writeFile(file, original);
  await rm(file);
  await assert.rejects(journal.snapshot(), /watermark_uncertain/);
});

test("checkpoint refuses rollback, missing volume and unexpected temporary HEAD", async t => {
  const { config, journal } = await fixture(t);
  const minimum = (await journal.snapshot()).head;
  await journal.append(event());
  const current = (await journal.snapshot(minimum)).head;
  await writeFile(join(config.directory, ".head-synthetic.tmp"), JSON.stringify(current));
  await assert.rejects(journal.snapshot(), /outcome_unknown/);
  await rm(join(config.directory, ".head-synthetic.tmp"));
  await rm(join(config.directory, "head.json"));
  await assert.rejects(journal.snapshot(), /missing_or_corrupt/);
  await rm(config.directory, { recursive: true });
  await assert.rejects(journal.snapshot(), /video_journal_missing/);
});

test("reinitializing same label and key cannot recreate an old empty checkpoint identity", async t => {
  const { config, journal } = await fixture(t);
  const checkpoint = (await journal.snapshot()).head;
  await rm(config.directory, { recursive: true });
  await initializeVideoDeletionJournal(config);
  await assert.rejects(journal.snapshot(), /identity_reset_detected/);
  await assert.rejects(new FileVideoDeletionJournal(config).snapshot(checkpoint), /behind_backup_watermark/);
});

test("read-only backup snapshots do not acquire writer locks and refuse an active or crashed writer", async t => {
  const { config, journal } = await fixture(t);
  await journal.append(event());
  const prior = await readFile(join(config.directory, "head.json"), "utf8");
  await chmod(config.directory, 0o500);
  await chmod(join(config.directory, "events"), 0o500);
  try {
    const checkpoint = await journal.snapshotReadOnly();
    assert.equal(checkpoint.head.sequence, 1);
    assert.equal(await readFile(join(config.directory, "head.json"), "utf8"), prior);
    assert.deepEqual((await readdir(config.directory)).sort(), ["events", "head.json", "identity.json"]);
  } finally {
    await chmod(config.directory, 0o700);
    await chmod(join(config.directory, "events"), 0o700);
  }
  await mkdir(join(config.directory, ".lock"), { mode: 0o700 });
  await assert.rejects(journal.snapshotReadOnly(), /locked_or_outcome_unknown/);
});

test("maintenance CLI initializes a fresh unpredictable identity and verifies signed checkpoints", async t => {
  const parent = await mkdtemp(join(tmpdir(), "video-journal-cli-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const path = new URL("./video-journal-cli.ts", import.meta.url).pathname;
  const env = { ...process.env, VIDEO_DELETION_JOURNAL_DIR: join(parent, "journal"), VIDEO_DELETION_JOURNAL_KEY: "synthetic-cli-secret-000000000000000000", VIDEO_DELETION_JOURNAL_ID: "must-not-reuse-this-label" };
  const initialized = JSON.parse((await run(process.execPath, ["--experimental-strip-types", path, "init"], { env })).stdout);
  assert.notEqual(initialized.journal_id, env.VIDEO_DELETION_JOURNAL_ID);
  env.VIDEO_DELETION_JOURNAL_ID = initialized.journal_id;
  const checkpoint = join(parent, "snapshot.video-journal.json");
  await run(process.execPath, ["--experimental-strip-types", path, "checkpoint", checkpoint], { env });
  const verified = await run(process.execPath, ["--experimental-strip-types", path, "verify", checkpoint], { env });
  assert.equal(JSON.parse(verified.stdout).verified, true);
  assert.ok(!verified.stdout.includes(env.VIDEO_DELETION_JOURNAL_KEY));
  await assert.rejects(run(process.execPath, ["--experimental-strip-types", path, "init"], { env }));
  await rm(join(env.VIDEO_DELETION_JOURNAL_DIR, "head.json"));
  await assert.rejects(run(process.execPath, ["--experimental-strip-types", path, "verify", checkpoint], { env }), /video_journal_missing_or_corrupt/);
});

test("old snapshot + acknowledged later erase replays scoped read/index/skill deletion and transaction rollback", async t => {
  const { config, journal } = await fixture(t), db = await pgliteDb();
  t.after(() => db.close());
  await migrate(db);
  await db.query("CREATE TABLE journal_fixture_content(tenant_id text, workspace_id text, asset_id text, body text, indexed bool, skill_pin bool)");
  await db.query("INSERT INTO journal_fixture_content VALUES('tenant1','workspace1','asset1','synthetic content',true,true),('tenant1','workspace2','asset1','other workspace',true,true)");
  await db.query("CREATE TABLE journal_fixture_snapshot AS SELECT * FROM journal_fixture_content");
  const engine = { db, video: { enabled: true } } as any;
  let applications = 0;
  configureVideoRetentionJournal(engine, config, async (q, e) => {
    applications++;
    await q.query("UPDATE journal_fixture_content SET body='', indexed=false,skill_pin=false WHERE tenant_id=$1 AND workspace_id=$2 AND asset_id=$3", [e.tenant_id, e.workspace_id, e.asset_id]);
  });
  await replayVideoRetentionJournal(engine);
  await assert.rejects(db.tx(async q => {
    await lockVideoRetentionTransaction(q);
    await appendVideoRetentionIntent(engine, event());
    throw new Error("synthetic transaction abort after external durability");
  }), /synthetic transaction abort/);
  assert.equal((await journal.snapshot()).head.sequence, 1);
  const foreignHead = await videoRetentionCheckpoint(engine, { tenant_id: "tenant1", workspace_id: "workspace2" });
  assert.equal(foreignHead.head_sequence, 1);
  assert.equal(applications, 0, "wrong workspace does not apply another scope's deletion");
  const appliedHead = await videoRetentionCheckpoint(engine, { tenant_id: "tenant1", workspace_id: "workspace1" });
  assert.equal(appliedHead.head_sequence, 1);
  assert.equal(appliedHead.genesis_hash, foreignHead.genesis_hash);
  assert.match(appliedHead.genesis_hash, /^[a-f0-9]{64}$/);
  assert.equal(applications, 1, "exported checkpoint never precedes scoped application");
  await Promise.all([replayVideoRetentionJournal(engine), replayVideoRetentionJournal(engine)]);
  assert.equal(applications, 1);
  assert.equal((await db.query("SELECT body FROM journal_fixture_content WHERE workspace_id='workspace1'")).rows[0].body, "");
  await db.query("TRUNCATE journal_fixture_content,flow_video_deletion_journal_receipts");
  await db.query("INSERT INTO journal_fixture_content SELECT * FROM journal_fixture_snapshot");
  await replayVideoRetentionJournal(engine);
  const rows = (await db.query("SELECT * FROM journal_fixture_content ORDER BY workspace_id")).rows;
  assert.deepEqual(rows.map(x => [x.body, x.indexed, x.skill_pin]), [["", false, false], ["other workspace", true, true]]);
  assert.equal(applications, 2);
  await db.query("UPDATE flow_video_deletion_journal_receipts SET event_hash=$1", ["f".repeat(64)]);
  await assert.rejects(replayVideoRetentionJournal(engine), /database_watermark_uncertain/);
  const record = (await journal.snapshot()).records[0];
  await assert.rejects(db.tx(q => markVideoRetentionApplied(q, record)), /database_receipt_conflict/);
  const reset = { ...config, directory: join(config.directory, "..", "replacement") };
  await initializeVideoDeletionJournal(reset);
  configureVideoRetentionJournal(engine, reset, async () => { throw new Error("must not apply reset journal"); });
  await assert.rejects(replayVideoRetentionJournal(engine), /database_identity_mismatch/);
  configureVideoRetentionJournal(engine, config, async () => { throw new Error("must not adopt legacy database"); });
  await db.query("DELETE FROM flow_video_deletion_journal_identity");
  await db.query("INSERT INTO flow_sources(id,tenant_id,workspace_id,kind,url,config) VALUES('legacy-source','tenant1','workspace1','bilibili','https://www.bilibili.com/video/BVsynthetic','{}')");
  await assert.rejects(replayVideoRetentionJournal(engine), /legacy_database_unbound/);
  await assert.rejects(replayVideoRetentionJournal(engine, { tenant_id: "tenant1", workspace_id: "workspace1" }), /initialization_barrier_required/);
});

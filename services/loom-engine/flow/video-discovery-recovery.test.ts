import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Db } from "./db.ts";
import { Engine } from "./engine.ts";
import { videoError } from "./video-contract.ts";
import type { VideoProvider } from "./video-provider.ts";
import { configureVideoRetentionJournal, initializeVideoDeletionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { applyVideoRetention } from "./video-knowledge.ts";

// No browser/chat process participates. The real scheduler and durable worker
// run against a reopened disk database; both external account feeds are synthetic.
test("AC03/04: two incremental scheduled account windows survive page-two failure and actual database restart", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "video-discovery-restart-"));
  const journal = { directory: join(root, "journal"), journalId: "discovery-restart-fixture", key: "synthetic-discovery-restart-key-not-production" };
  await initializeVideoDeletionJournal(journal);
  const scope = { tenant_id: "discovery_t", workspace_id: "discovery_w", actor: { type: "user", id: "reviewer" }, policy_version: "policy_v1" };
  const initial = Date.now();
  let now = initial, db: Db | undefined, engine: Engine;
  let failed = false;
  const calls: { platform: string; cursor: unknown; window: number }[] = [];
  const provider: VideoProvider = {
    instance: "synthetic-two-account-fixture-not-live-platform",
    discover: async (source, cursor) => {
      const window = now < initial + 120_000 ? 1 : 2;
      calls.push({ platform: source.kind, cursor, window });
      if (source.kind === "bilibili" && cursor === "page-two" && !failed) {
        failed = true;
        throw videoError(503, "PROVIDER_UNAVAILABLE");
      }
      const item = (n: number) => {
        const native_id = source.kind === "bilibili" ? `BV1QA000000${n}` : `726000000000000000${n}`;
        return { native_id, part_id: "1", title: `Synthetic ${source.kind} item ${n}`, canonical_url: `https://www.${source.kind === "bilibili" ? "bilibili.com" : "douyin.com"}/video/${native_id}`,
          published_at: new Date(initial - 1000 + (n === 3 ? 120_000 : 0)).toISOString() };
      };
      return { items: cursor ? window === 1 ? [item(2)] : [item(1), item(2)] : [item(window === 1 ? 1 : 3)],
        next_cursor: cursor ? null : "page-two", complete: !!cursor, watermark: { published_at: new Date(now).toISOString() }, mode: "fixture" };
    },
    submit: async () => { throw new Error("discovery test must not invent media completion"); },
    poll: async () => { throw new Error("discovery test must not invent media completion"); },
    cancel: async () => "unsupported",
    readObject: async () => { throw new Error("no synthetic media objects in discovery-only proof"); },
  };
  async function open() {
    const pg = new PGlite(join(root, "database"));
    db = { query: (sql, params) => pg.query(sql, params as any[]) as any,
      tx: fn => pg.transaction(q => fn({ query: (sql, params) => q.query(sql, params as any[]) as any })), close: () => pg.close() };
    await migrate(db);
    engine = new Engine(db, async () => { throw new Error("no external network in fixture"); }, () => new Date(now));
    engine.video.enabled = true;
    engine.video.provider = provider;
    configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
    await replayVideoRetentionJournal(engine);
  }
  t.after(async () => { await db?.close(); await rm(root, { recursive: true, force: true }); });
  await open();
  const profile = await engine!.video.saveProfile(scope, { name: "Synthetic incremental discovery", config: { required_capabilities: ["transcript"], max_discovery_pages: 2 } });
  const sources = [];
  for (const kind of ["bilibili", "douyin"]) {
    sources.push(await engine!.createSource(scope, { kind, title: `Synthetic ${kind} account`, url: kind === "bilibili" ? "https://space.bilibili.com/123456" : "https://www.douyin.com/user/synthetic-account",
      config: { source_type: "account", author_id: "synthetic-account", profile_id: profile.id, profile_version: profile.version, usage_basis: "Synthetic two-window fault fixture, not licensed platform data", allowed_uses: ["knowledge"] } }));
  }
  const schedule = await engine!.createSchedule(scope, "user:reviewer", "policy_v1", { source_ids: sources.map(x => x.id), interval_seconds: 120, timezone: "UTC" });
  assert.equal(await engine!.schedulerTick(), 2);
  const runs = [await engine!.workOnce("before-restart-1"), await engine!.workOnce("before-restart-2")];
  assert.deepEqual(runs.map(x => x?.status).sort(), ["retry_wait", "succeeded"]);
  const checkpoints = await db!.query("SELECT * FROM flow_video_discovery_checkpoints ORDER BY source_id");
  const partial = checkpoints.rows.find(x => x.source_id === sources[0].id)!;
  assert.equal(partial.partial, true);
  assert.equal(partial.checkpoint, "page-two");
  assert.equal(partial.stable_watermark, null, "failed page must not advance the stable watermark");
  assert.equal((await db!.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 3, "first pages remain durably admitted despite later failure");
  const failedRun = (await db!.query("SELECT * FROM flow_collection_runs WHERE status='retry_wait'")).rows[0];
  const visible = await engine!.getOperation(scope, failedRun.operation_id);
  assert.equal(visible.status, "retrying");
  assert.equal(visible.jobs.find(x => x.job_id === failedRun.id)?.error, "PROVIDER_UNAVAILABLE");
  await db!.close(); db = undefined;
  now += 31_000;
  await open();
  const persisted = (await db!.query("SELECT * FROM flow_video_discovery_checkpoints WHERE source_id=$1", [sources[0].id])).rows[0];
  assert.equal(persisted.checkpoint, "page-two", "reopened database preserves the last committed cursor");
  assert.equal(persisted.generation, partial.generation);
  assert.equal((await engine!.workOnce("after-actual-restart"))?.status, "succeeded");
  assert.equal((await db!.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 4);
  assert.equal((await db!.query("SELECT count(*)::int n FROM flow_collection_runs WHERE status<>'succeeded'")).rows[0].n, 0);
  // A NEW scheduled window discovers one new video on EACH account and sees
  // the overlap again. Stable business fingerprints must retain only six jobs.
  now = initial + 120_000;
  assert.equal(await engine!.schedulerTick(), 2);
  assert.equal((await engine!.workOnce("second-window-1"))?.status, "succeeded");
  assert.equal((await engine!.workOnce("second-window-2"))?.status, "succeeded");
  assert.equal(await engine!.schedulerTick(), 0, "replaying the same clock cannot enqueue a duplicate window");
  assert.equal((await db!.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 6);
  assert.equal((await db!.query("SELECT count(*)::int n FROM flow_collection_windows WHERE schedule_id=$1", [schedule.id])).rows[0].n, 2);
  assert.equal((await db!.query("SELECT count(*)::int n FROM flow_collection_runs WHERE schedule_id=$1 AND status='succeeded'", [schedule.id])).rows[0].n, 4);
  for (const row of (await db!.query("SELECT * FROM flow_video_discovery_checkpoints")).rows) {
    assert.equal(row.partial, false);
    assert.equal(row.checkpoint, null);
    assert.equal(row.pending_watermark, null);
    assert.equal(row.stable_watermark.published_at, new Date(now).toISOString());
  }
  assert.deepEqual(calls.filter(x => x.platform === "bilibili").map(x => x.cursor), [null, "page-two", "page-two", null, "page-two"]);
  assert.deepEqual(calls.filter(x => x.platform === "douyin").map(x => x.cursor), [null, "page-two", null, "page-two"]);
  assert.equal((await db!.query("SELECT count(*)::int n FROM flow_video_jobs WHERE grant_actor='user:reviewer' AND profile_version=1")).rows[0].n, 6);
  t.diagnostic("synthetic provider only: actual disk restart + two scheduler windows + six unique jobs; media/model/knowledge quality not claimed");
});

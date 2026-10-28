// Real migrated disk DB, scheduler and coordinator; external pages are fixtures.
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

const scope = { tenant_id: "atomic_t", workspace_id: "atomic_w", actor: { type: "user", id: "reviewer" }, policy_version: "synthetic-v1" };
async function fixture(t: any, maxPages = 5, maxItems = 200) {
  const root = await mkdtemp(join(tmpdir(), "knowhow-discovery-atomic-"));
  const journal = { directory: join(root, "journal"), journalId: "synthetic-atomic-journal", key: "synthetic-discovery-journal-key-not-production" };
  await initializeVideoDeletionJournal(journal);
  let now = new Date(), db: Db, engine: Engine, open = false;
  const provider: VideoProvider = {
    instance: "synthetic-discovery-pages-only",
    discover: async () => ({ items: [], complete: true, next_cursor: null, mode: "fixture" }),
    submit: async () => { throw new Error("media processing is outside this fixture"); },
    poll: async () => { throw new Error("media processing is outside this fixture"); },
    cancel: async () => "unsupported", readObject: async () => { throw new Error("No media fixture"); },
  };
  async function start() {
    const pg = new PGlite(join(root, "database")); let chain: Promise<unknown> = Promise.resolve();
    db = { query: (sql, params) => pg.query(sql, params as any[]) as any,
      tx: fn => { const result = chain.then(() => pg.transaction(q => fn({ query: (sql, params) => q.query(sql, params as any[]) as any }))); chain = result.catch(() => {}); return result as any; },
      close: async () => { await pg.close(); open = false; } };
    open = true; await migrate(db);
    engine = new Engine(db, async () => { throw new Error("Live calls forbidden"); }, () => now);
    engine.video.enabled = true; engine.video.provider = provider;
    engine.authorize = async ctx => ctx.grant_actor === "user:reviewer";
    configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
    await replayVideoRetentionJournal(engine);
  }
  await start();
  t.after(async () => { if (open) await db.close(); await rm(root, { recursive: true, force: true }); });
  const profile = await engine!.video.saveProfile(scope, { name: "Synthetic atomic discovery", config: { max_discovery_pages: maxPages, max_reconcile_items: 0 } });
  const source = await engine!.createSource(scope, { kind: "bilibili", title: "Synthetic account", url: "https://space.bilibili.com/123456",
    config: { source_type: "account", author_id: "123456", max_items: maxItems, profile_id: profile.id, profile_version: profile.version,
      usage_basis: "Self-authored fixture only, no real account or media", allowed_uses: ["knowledge"] } });
  await engine!.createSchedule(scope, "user:reviewer", "synthetic-v1", { source_ids: [source.id], interval_seconds: 600 });
  const item = (index: number) => ({ native_id: `BV1ATOMIC${index}`, canonical_url: `https://www.bilibili.com/video/BV1ATOMIC${index}`,
    content_version: "synthetic-v1", title: `Synthetic ${index}`, published_at: new Date(now.getTime() - 1000).toISOString() });
  return { get db() { return db; }, get engine() { return engine; }, provider, source, item,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); }, restart: async () => { await db.close(); await start(); } };
}

test("AC04: page-two 429 preserves committed count/cursor across disk restart and honors Retry-After", { timeout: 60000 }, async t => {
  const f = await fixture(t), first = f.item(1), second = f.item(2); let blocked = true;
  f.provider.discover = async (_source, cursor) => {
    if (cursor === null) return { items: [first], complete: false, next_cursor: "page-2", watermark: { published_at: first.published_at }, mode: "fixture" };
    assert.equal(cursor, "page-2");
    if (blocked) throw Object.assign(videoError(429, "RATE_LIMITED"), { retry_after: 120 });
    return { items: [first, second], complete: false, reached_boundary: true, next_cursor: "older", mode: "fixture" };
  };
  await f.engine.schedulerTick();
  assert.equal((await f.engine.workOnce("rate-limited"))?.status, "retry_wait");
  assert.equal((await f.engine.listJobs(scope))[0].items_new, 1);
  const before = (await f.db.query("SELECT * FROM flow_video_discovery_checkpoints")).rows[0];
  assert.equal(before.partial, true); assert.equal(before.checkpoint, "page-2"); assert.equal(before.stable_watermark, null);
  await f.restart(); blocked = false; f.advance(119000);
  assert.equal(await f.engine.workOnce("too-early"), null);
  f.advance(2000); assert.equal((await f.engine.workOnce("retry-after"))?.status, "succeeded");
  const after = (await f.db.query("SELECT * FROM flow_video_discovery_checkpoints")).rows[0];
  assert.equal(after.partial, false); assert.equal(after.checkpoint, null); assert.deepEqual(after.stable_watermark, { published_at: first.published_at });
  assert.equal((await f.engine.listJobs(scope))[0].items_new, 2, "overlap item must not count as new work");
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 2);
});

for (const mode of ["committed-middle", "committed-final", "rolled-back"] as const) test(`AC04: ${mode} page response loss reconciles before another fetch`, { timeout: 60000 }, async t => {
  const f = await fixture(t), first = f.item(1), second = f.item(2), calls: unknown[] = [];
  f.provider.discover = async (_source, cursor) => {
    calls.push(cursor);
    return cursor === null ? { items: [first], complete: mode !== "committed-middle", next_cursor: mode === "committed-middle" ? "page-2" : null, mode: "fixture" }
      : { items: [second], complete: true, next_cursor: null, mode: "fixture" };
  };
  await f.engine.schedulerTick();
  const original = f.db.tx.bind(f.db); let lost = false;
  f.db.tx = async fn => {
    let page = false;
    const result = await original(q => fn({ query: async (sql, params) => {
      page ||= /INSERT INTO flow_video_discovery_pages/.test(sql);
      const value = await q.query(sql, params);
      if (mode === "rolled-back" && /UPDATE flow_collection_runs SET items_new=items_new/.test(sql) && !lost) {
        lost = true; throw new Error("connection lost before page COMMIT; outcome unknown");
      }
      return value;
    } }));
    if (page && !lost) { lost = true; throw new Error("connection lost after page COMMIT; outcome unknown"); }
    return result;
  };
  assert.equal((await f.engine.workOnce("unknown"))?.status, "reconciliation_required");
  assert.deepEqual(calls, [null]);
  for (const table of ["flow_video_jobs", "flow_video_discovery_pages", "flow_video_discovery_checkpoints"])
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, mode === "rolled-back" ? 0 : 1);
  assert.equal((await f.engine.listJobs(scope))[0].items_new, mode === "rolled-back" ? 0 : 1);
  await f.restart(); assert.equal((await f.engine.reconcile())[0].status, "queued");
  assert.equal((await f.engine.workOnce("reconciled"))?.status, "succeeded");
  assert.deepEqual(calls, mode === "committed-middle" ? [null, "page-2"] : mode === "rolled-back" ? [null, null] : [null]);
  assert.equal((await f.engine.listJobs(scope))[0].items_new, mode === "committed-middle" ? 2 : 1);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_outbox WHERE type='collection.completed'")).rows[0].n, 1);
});

test("AC04: oversized buffered pages survive page limits, duplicate/out-of-order entries and restart without false coverage", { timeout: 60000 }, async t => {
  const f = await fixture(t, 1, 2), a = f.item(1), b = { ...f.item(2), published_at: new Date(Date.parse(a.published_at) - 3600000).toISOString() }, c = f.item(3), d = f.item(4);
  let calls = 0;
  f.provider.discover = async () => { calls++; return { items: [a, a, b, c, d], complete: true, next_cursor: null, watermark: { published_at: a.published_at }, mode: "fixture" }; };
  for (let window = 0; window < 3; window++) {
    assert.equal(await f.engine.schedulerTick(), 1);
    assert.equal((await f.engine.workOnce(`bounded-${window}`))?.status, window < 2 ? "partial" : "succeeded");
    const cp = (await f.db.query("SELECT * FROM flow_video_discovery_checkpoints")).rows[0];
    assert.equal(cp.partial, window < 2); assert.deepEqual(cp.stable_watermark, window < 2 ? null : { published_at: a.published_at });
    await f.restart(); f.advance(600000);
  }
  assert.equal(calls, 1, "committed oversized page is resumed without another external call");
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 4);
  assert.equal((await f.db.query("SELECT sum(items_new)::int n FROM flow_collection_runs")).rows[0].n, 4);
});

test("AC04: retry keeps the original item bound and durably buffers the excess", { timeout: 60000 }, async t => {
  const f = await fixture(t, 5, 2), first = f.item(1), second = f.item(2), third = f.item(3); let failed = false;
  f.provider.discover = async (_source, cursor) => {
    if (cursor === null) return { items: [first], complete: false, next_cursor: "page-2", mode: "fixture" };
    if (!failed) { failed = true; throw videoError(503, "PROVIDER_UNAVAILABLE"); }
    return { items: [second, third], complete: true, next_cursor: null, mode: "fixture" };
  };
  await f.engine.schedulerTick(); assert.equal((await f.engine.workOnce("bounded-first"))?.status, "retry_wait");
  await f.restart(); f.advance(31000);
  assert.equal((await f.engine.workOnce("bounded-retry"))?.status, "partial");
  assert.equal((await f.engine.listJobs(scope))[0].items_new, 2);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 2);
  const cp = (await f.db.query("SELECT * FROM flow_video_discovery_checkpoints")).rows[0];
  assert.equal(cp.partial, true); assert.equal(cp.stable_watermark, null);
  assert.equal(cp.checkpoint.loom_buffered_page.items[0].native_id, third.native_id);
});

test("AC04: lost response after the page bound cannot reset the budget during reconciliation", { timeout: 60000 }, async t => {
  const f = await fixture(t, 1, 200), calls: unknown[] = [];
  f.provider.discover = async (_source, cursor) => { calls.push(cursor); return { items: [f.item(1)], complete: false, next_cursor: "page-2", mode: "fixture" }; };
  await f.engine.schedulerTick();
  const original = f.db.tx.bind(f.db); let lost = false;
  f.db.tx = async fn => {
    let page = false;
    const result = await original(q => fn({ query: (sql, params) => { page ||= /INSERT INTO flow_video_discovery_pages/.test(sql); return q.query(sql, params); } }));
    if (page && !lost) { lost = true; throw new Error("connection lost after page COMMIT; outcome unknown"); }
    return result;
  };
  assert.equal((await f.engine.workOnce("bounded-unknown"))?.status, "reconciliation_required");
  await f.restart(); await f.engine.reconcile();
  assert.equal((await f.engine.workOnce("bounded-reconcile"))?.status, "partial");
  assert.deepEqual(calls, [null]);
  assert.equal((await f.db.query("SELECT checkpoint FROM flow_video_discovery_checkpoints")).rows[0].checkpoint, "page-2");
});

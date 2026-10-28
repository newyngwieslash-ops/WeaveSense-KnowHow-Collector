import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, pgliteDb } from "./db.ts";
import { Engine } from "./engine.ts";
import { handler } from "./server.ts";
import { sign } from "./auth.ts";
import { fetchFeed } from "../src/lib/server/rss.ts";
import { initializeVideoDeletionJournal, configureVideoRetentionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { applyVideoRetention } from "./video-knowledge.ts";

const S = { tenant_id: "legacy_compat", workspace_id: "legacy_workspace" };
const KEY = "synthetic-ac24-signing-key-not-production";
const mediaPrefix = `tenants/${S.tenant_id}/workspaces/${S.workspace_id}/telegram/fixture_channel`;

// Only external RSS transport / ASR / OCR are deterministic, self-authored fixtures.
// HTTP routing, signature verification, RSS parsing, migrations, scheduling, collection,
// revisions, FTS and enrichment queues below are the actual implementations.
async function exerciseLegacy(t: TestContext, enabled: boolean) {
  const db = await pgliteDb();
  await migrate(db);
  let now = new Date("2026-10-28T00:00:00Z"), edition = 1;
  const rssRequests: string[] = [], enrichmentCalls: string[] = [];
  const engine = new Engine(db, async (url, sourceId, source) => {
    if (source?.kind === "telegram") return {
      collector: "telethon", mode: "fixture", items: [{ external_id: "11", title: "Legacy media", body: "Self-authored non-video source", url: "https://t.me/fixture_channel/11", published_at: "2026-10-27T00:00:00Z",
        media: [{ url: `${mediaPrefix}/11`, type: "audio", status: "stored", reason: "", content_type: "audio/ogg" },
          { url: `${mediaPrefix}/12`, type: "image", status: "stored", reason: "", content_type: "image/png" }] }],
    };
    const result = await fetchFeed(url, sourceId, "rss", source?.feed_validators, {
      resolver: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } as any,
      transport: async (_url, init) => {
        const etag = `"edition-${edition}"`;
        rssRequests.push(init.headers["If-None-Match"] ?? "");
        return init.headers["If-None-Match"] === etag
          ? { status: 304, headers: { etag }, body: new Response("").body! }
          : { status: 200, headers: { etag }, body: new Response(`<rss><channel><title>Self-authored fixture</title><item><guid>legacy-1</guid><title>Legacy battery report</title><description>Battery source edition ${edition} 保留原文</description><link>https://feed.example/item/1</link><pubDate>Tue, 27 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`).body! };
      },
    });
    return { items: result.items, collector: "rss", mode: "fixture", feed_validators: result.validators, not_modified: result.not_modified, rejected_entries: result.rejected_entries };
  }, () => now);
  engine.video.enabled = enabled;
  engine.objectStore = null; engine.objectStorePut = null; engine.embedder = null;
  engine.asr = async (key, scope) => {
    assert.deepEqual(scope, S); assert.equal(key, `${mediaPrefix}/11`); enrichmentCalls.push("asr");
    return { text: "Legacy speech preserved", seconds: 12, language: "en", digest: "synthetic-asr" };
  };
  engine.ocr = async (key, scope) => {
    assert.deepEqual(scope, S); assert.equal(key, `${mediaPrefix}/12`); enrichmentCalls.push("ocr");
    return { text: "Legacy image text preserved", pages: 1, digest: "synthetic-ocr" };
  };
  const server = createServer(handler(engine, { signingKey: KEY, audience: "loom-engine" }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); });
  const token = sign(KEY, { ...S, iss: "platform", aud: "loom-engine", actor: { type: "user", id: "synthetic-reviewer" }, policy_version: "policy_v1",
    scopes: ["intel.sources.read", "intel.sources.write", "intel.collect", "intel.documents.read", "intel.schedules.write", "intel.video.process", "intel.video.read", "intel.profiles.write"] });
  async function call(method: string, path: string, body?: unknown, key?: string, status = 200) {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "x-idempotency-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const envelope = await response.json();
    assert.equal(response.status, status, `${enabled ? "on" : "off"}: ${method} ${path}: ${JSON.stringify(envelope)}`);
    assert.equal(envelope.code, status >= 400 ? status : 0);
    return status >= 400 ? envelope : envelope.data;
  }

  // No video journal is configured in either mode: ordinary legacy APIs must not depend on it.
  const rss = await call("POST", "/v1/sources", { url: "https://feed.example/fixture.xml", title: "Legacy RSS" }, undefined, 201);
  const telegram = await call("POST", "/v1/sources", { kind: "telegram", config: { handle: "fixture_channel" } }, undefined, 201);
  const preview = await call("POST", "/v1/monitors/preview", { name: "Legacy battery monitor", keywords: ["battery"], source_ids: [rss.id], interval_seconds: 3600 });
  const { monitor } = await engine.applyMonitor(S, "user:synthetic-reviewer", "policy_v1", { preview_id: preview.preview_id, approval_id: "synthetic-recurring-grant", idempotency_key: "legacy-monitor" });
  now = new Date("2026-10-28T01:00:00Z");
  assert.equal(await engine.schedulerTick(), 1);
  assert.equal(await engine.schedulerTick(), 0, "same schedule window is idempotent in both modes");
  assert.equal((await engine.workOnce("legacy-worker"))?.status, "succeeded");
  await call("POST", "/v1/collection-runs", { source_ids: [telegram.id] }, "legacy-media", 202);
  assert.equal((await engine.workOnce("legacy-worker"))?.status, "succeeded");
  const firstDocuments = await call("GET", "/v1/documents");
  assert.equal(firstDocuments.length, 2);
  const rssDocument = firstDocuments.find((d: any) => d.source_id === rss.id), mediaDocument = firstDocuments.find((d: any) => d.source_id === telegram.id);
  assert.ok(rssDocument && mediaDocument);
  const original = await call("POST", "/v1/documents/read", { document_id: rssDocument.id, revision: 1 });
  assert.match(original.text, /edition 1/);
  edition = 2;
  const revised = await call("POST", "/v1/collection-runs", { source_ids: [rss.id] }, "legacy-revision", 202);
  const replay = await call("POST", "/v1/collection-runs", { source_ids: [rss.id] }, "legacy-revision", 202);
  assert.equal(replay.operation_id, revised.operation_id); assert.equal(replay.replayed, true);
  assert.equal((await engine.workOnce("legacy-worker"))?.items_revised, 1);
  await call("POST", "/v1/collection-runs", { source_ids: [rss.id] }, "legacy-304", 202);
  assert.equal((await engine.workOnce("legacy-worker"))?.items_revised, 0);
  const updated = await call("POST", "/v1/documents/read", { document_id: rssDocument.id });
  assert.equal(updated.revision, 2); assert.match(updated.text, /edition 2/);
  assert.equal((await call("POST", "/v1/documents/read", { document_id: rssDocument.id, revision: 1 })).text, original.text);
  const asr = await call("POST", "/v1/documents/asr", { document_id: mediaDocument.id, language: "en" });
  const ocr = await call("POST", "/v1/documents/ocr", { document_id: mediaDocument.id });
  assert.deepEqual([asr.processed[0].status, ocr.processed[0].status], ["succeeded", "succeeded"]);
  for (const kind of ["asr", "ocr"]) assert.deepEqual((await call("POST", `/v1/documents/${kind}`, { document_id: mediaDocument.id })).processed, []);
  assert.deepEqual(enrichmentCalls, ["asr", "ocr"]);
  const enriched = await call("POST", "/v1/documents/read", { document_id: mediaDocument.id });
  assert.equal(enriched.revision, 3); assert.match(enriched.text, /Legacy speech preserved/); assert.match(enriched.text, /Legacy image text preserved/);
  const search = await call("POST", "/v1/documents/search", { query: "battery", vector: false });
  assert.equal(search.items.length, 1); assert.equal(search.items[0].document_id, rssDocument.id); assert.equal(search.items[0].revision, 2);
  const hits = await call("GET", `/v1/monitors/${monitor.id}/hits`);
  assert.equal(hits.items.length, 1); assert.equal(hits.items[0].document_id, rssDocument.id); assert.equal(hits.items[0].revision, 1);
  const completed = (await db.query("SELECT payload FROM flow_outbox WHERE type='collection.completed' ORDER BY sequence")).rows;
  assert.equal(completed.length, 4); assert.equal(completed[0].payload.cycle_complete, true); assert.equal(completed[0].payload.cycle_status, "succeeded");
  assert.equal((await db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM flow_video_deletion_journal_identity")).rows[0].n, 0);

  const unavailable = await call("POST", "/v1/video/profiles", { name: "Synthetic video", config: {} }, undefined, 503);
  assert.equal(unavailable.reason, enabled ? "video_journal_configuration_required" : "VIDEO_DISABLED");
  const snapshot = {
    original: original.text, revised: updated.text, enriched: enriched.text, rssRequests, enrichmentCalls,
    search: search.items.map((r: any) => ({ revision: r.revision, snippet: r.snippet, char_start: r.char_start, char_end: r.char_end })),
    hits: hits.items.map((r: any) => ({ revision: r.revision, title: r.title })),
    collection: (await db.query("SELECT status,items_new,items_revised,not_modified FROM flow_collection_runs ORDER BY created_at")).rows,
    usage: (await db.query("SELECT payload->>'usage_type' AS kind,payload->>'quantity' AS quantity FROM flow_outbox WHERE type='usage.recorded' ORDER BY sequence")).rows,
  };

  // A healthy journal isolates the feature flag from a separate safety failure.
  const root = await mkdtemp(join(tmpdir(), "video-legacy-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = { directory: join(root, "journal"), journalId: "synthetic-ac24-journal", key: KEY };
  await initializeVideoDeletionJournal(journal);
  configureVideoRetentionJournal(engine, journal, (q, event) => applyVideoRetention(engine, q, event, event));
  await replayVideoRetentionJournal(engine);
  if (!enabled) {
    assert.equal((await call("POST", "/v1/video/profiles", { name: "Synthetic video", config: {} }, undefined, 503)).reason, "VIDEO_DISABLED");
    assert.equal((await call("POST", "/v1/video/jobs", {}, "disabled-job", 503)).reason, "VIDEO_DISABLED");
    assert.equal((await db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 0);
  } else {
    const profile = await call("POST", "/v1/video/profiles", { name: "Synthetic video", config: { required_capabilities: ["transcript"] } }, undefined, 201);
    const source = await call("POST", "/v1/sources", { kind: "bilibili", url: "https://www.bilibili.com/video/BV1compatFixture", config: { source_type: "video", native_id: "BV1compatFixture", profile_id: profile.id, profile_version: 1, usage_basis: "Self-authored fixture; no platform request", allowed_uses: ["knowledge"] } }, undefined, 201);
    const queued = await call("POST", "/v1/video/jobs", { source_id: source.id, native_id: "BV1compatFixture", canonical_url: source.url }, "enabled-job", 202);
    assert.equal(queued.state, "queued");
    assert.equal((await call("GET", `/v1/video/jobs/${queued.video_job_id}`)).state, "queued");
    assert.equal((await db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 1);
  }
  return snapshot;
}

test("AC24 video off/on preserves identical legacy RSS, scheduled monitor, search and non-video ASR/OCR without a video journal", { timeout: 60000 }, async t => {
  const off = await exerciseLegacy(t, false);
  const on = await exerciseLegacy(t, true);
  assert.deepEqual(on, off, "the same legacy workflow must be observationally identical across video feature states");
});

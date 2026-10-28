import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { migrate, pgliteDb } from "./db.ts";
import { Engine, connectorFetcher } from "./engine.ts";
import { handler } from "./server.ts";
import { sign } from "./auth.ts";

test("AC24 WeChat gateway parsing, periodic collection, revisions and FTS are identical with video disabled/enabled", { timeout: 60000 }, async t => {
  const snapshots = [];
  for (const enabled of [false, true]) {
    const db = await pgliteDb(); await migrate(db);
    let edition = 1, now = new Date("2026-10-28T00:00:00Z");
    const gatewayCalls: string[] = [];
    const engine = new Engine(db, connectorFetcher({ wechatGatewayUrl: "https://gateway.example", wechatGatewayToken: "synthetic-only-token", mode: "fixture",
      fetchImpl: (async (url, init) => {
        assert.equal(String(url), "https://gateway.example/v1/feeds/synthetic_feed.atom");
        assert.equal(init?.redirect, "error");
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-only-token");
        gatewayCalls.push(`edition-${edition}`);
        return new Response(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Self-authored WeChat fixture</title><entry><id>wechat-item-1</id><title>Battery 微信材料</title><link href="https://example.com/self-authored"/><updated>2026-10-27T00:00:00Z</updated><content type="text">Synthetic battery source edition ${edition} 中文</content></entry></feed>`,
          { headers: { "content-type": "application/atom+xml", "x-loom-provider": "primary" } });
      }) as typeof fetch,
    }), () => now);
    engine.video.enabled = enabled; engine.objectStore = null; engine.objectStorePut = null; engine.embedder = null;
    const key = "synthetic-wechat-compatibility-key-32";
    const server = createServer(handler(engine, { signingKey: key, audience: "loom-engine" }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); });
    const scope = { tenant_id: "wechat_compat", workspace_id: "wechat_compat_workspace" };
    const token = sign(key, { ...scope, iss: "platform", aud: "loom-engine", actor: { type: "user", id: "fixture" }, policy_version: "policy_v1",
      scopes: ["intel.sources.write", "intel.sources.read", "intel.schedules.write", "intel.documents.read", "intel.collect"] });
    async function call(path: string, body?: unknown, status = 200) {
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const envelope = await response.json();
      assert.equal(response.status, status, JSON.stringify(envelope)); assert.equal(envelope.code, 0);
      return envelope.data;
    }
    const source = await call("/v1/sources", { kind: "wechat", config: { gateway_source_id: "synthetic_feed" } }, 201);
    await call("/v1/schedules", { source_ids: [source.id], interval_seconds: 3600, start_at: now.toISOString() }, 201);
    assert.equal(await engine.schedulerTick(), 1); assert.equal(await engine.schedulerTick(), 0);
    assert.equal((await engine.workOnce("wechat-worker"))?.status, "succeeded");
    const [document] = await call("/v1/documents");
    const first = await call("/v1/documents/read", { document_id: document.id });
    assert.match(first.text, /edition 1/);
    now = new Date("2026-10-28T01:00:00Z"); edition = 2;
    assert.equal(await engine.schedulerTick(), 1);
    assert.equal((await engine.workOnce("wechat-worker"))?.items_revised, 1);
    const second = await call("/v1/documents/read", { document_id: document.id });
    assert.equal(second.revision, 2); assert.match(second.text, /edition 2/);
    assert.equal((await call("/v1/documents/read", { document_id: document.id, revision: 1 })).text, first.text);
    const search = await call("/v1/documents/search", { query: "battery", vector: false });
    assert.equal(search.items.length, 1); assert.equal(search.items[0].document_id, document.id); assert.equal(search.items[0].revision, 2);
    const runs = (await db.query("SELECT status,collector,provider,items_new,items_revised FROM flow_collection_runs ORDER BY scheduled_at")).rows;
    assert.deepEqual(runs.map(r => [r.status, r.collector, r.provider]), [["succeeded", "wechat_gateway", "primary"], ["succeeded", "wechat_gateway", "primary"]]);
    assert.equal((await db.query("SELECT count(*)::int n FROM flow_video_deletion_journal_identity")).rows[0].n, 0, "legacy WeChat must not acquire a video journal dependency");
    snapshots.push({ first: first.text, second: second.text, search: search.items.map((r: any) => [r.revision, r.snippet]), runs, gatewayCalls });
  }
  assert.deepEqual(snapshots[1], snapshots[0]);
});

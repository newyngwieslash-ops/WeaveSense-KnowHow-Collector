import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { HTTPVideoProvider } from "./video-provider.ts";
import { platformKnowledgeRuntime } from "./video-knowledge-runtime.ts";

async function listen(t: any, listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
const scope = { tenant_id: "transport_t", workspace_id: "transport_w", actor: { type: "user", id: "reviewer" }, policy_version: "test_v1" };
const source = { ...scope, id: "synthetic-source", kind: "bilibili", config: {}, url: "https://www.bilibili.com/video/BV1TEST001" };
const key = "synthetic-transport-boundary-key-not-production";

test("AC19: actual HTTP video and knowledge internal transports reject every redirect without forwarding credentials", async t => {
  let escaped = 0, authorized = 0;
  const target = await listen(t, (_req, res) => { escaped++; res.writeHead(200); res.end("unexpected credential destination"); });
  let status = 301;
  const origin = await listen(t, (req, res) => {
    if (req.headers.authorization?.startsWith("Bearer ")) authorized++;
    res.writeHead(status, { location: target + "/steal" }); res.end();
  });
  const provider = new HTTPVideoProvider(origin, "synthetic-provider-token", key);
  const knowledge = platformKnowledgeRuntime({ baseURL: origin, signingKey: key, audience: "flow-platform" });
  for (status of [301, 302, 303, 307, 308]) {
    await assert.rejects(provider.discover(source, null, Date.now() + 1000));
    await assert.rejects(knowledge.resolveBase!(scope as any, { id: "video-knowledge-core", version: "1.0.0" }));
  }
  assert.equal(authorized, 10, "actual fixed endpoints receive scoped/authenticated calls");
  assert.equal(escaped, 0, "redirect target never receives a request or credential");
});

test("AC21: actual provider HTTP401 and429 preserve auth/rate-limit reasons and Retry-After", async t => {
  let status = 401;
  const origin = await listen(t, (_req, res) => { res.writeHead(status, { "retry-after": "7", "content-type": "application/json" }); res.end('{"error":"synthetic upstream detail"}'); });
  const provider = new HTTPVideoProvider(origin, "synthetic-provider-token", key);
  await assert.rejects(provider.discover(source, null, Date.now() + 1000), (error: any) => error.status === 401 && error.reason === "AUTH_REQUIRED" && !error.message.includes("upstream detail"));
  status = 429;
  await assert.rejects(provider.discover(source, null, Date.now() + 1000), (error: any) => error.status === 429 && error.reason === "RATE_LIMITED" && error.retry_after === 7 && !error.message.includes("upstream detail"));
});

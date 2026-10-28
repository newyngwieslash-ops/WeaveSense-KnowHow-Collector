// Actual legacy scheduler/WeChat collection events for the Go recurring runner.
// The approved monitor projection is fixture-seeded from Go's persisted plan;
// no collection, completion event or Canvas result is manufactured here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migrate, pgliteDb } from "../../flow/db.ts";
import { Engine, connectorFetcher } from "../../flow/engine.ts";

const plan = JSON.parse(readFileSync(0, "utf8"));
assert.equal(plan.purpose, "monitor_canvas_recurring");
assert.equal(plan.source_ids.length, 1);
assert.ok(["true", "false"].includes(process.env.FLOW_VIDEO_ENABLED ?? ""));
const db = await pgliteDb(); await migrate(db);
try {
  let now = new Date("2026-10-27T00:00:00Z"), edition = 1;
  let gatewayCalls = 0;
  const engine = new Engine(db, connectorFetcher({ wechatGatewayUrl: "https://gateway.example", wechatGatewayToken: "synthetic-only", mode: "fixture",
    fetchImpl: (async (url, init) => {
      assert.equal(String(url), "https://gateway.example/v1/feeds/legacy_cycle.atom"); assert.equal(init?.redirect, "error"); gatewayCalls++;
      return new Response(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>legacy-cycle-${edition}</id><title>Battery source ${edition}</title><link href="https://example.com/self-authored/${edition}"/><updated>2026-10-26T00:00:00Z</updated><content type="text">Self-authored periodic source ${edition}</content></entry></feed>`, { headers: { "x-loom-provider": "primary" } });
    }) as typeof fetch,
  }), () => now);
  assert.equal(engine.video.enabled, process.env.FLOW_VIDEO_ENABLED === "true", "actual coordinator must read the tested flag");
  engine.objectStore = null; engine.objectStorePut = null; engine.embedder = null;
  const scope = { tenant_id: plan.tenant_id, workspace_id: plan.workspace_id };
  const source = await engine.createSource(scope, { kind: "wechat", config: { gateway_source_id: "legacy_cycle" } });
  // Fixed fixture identity matches the independently persisted native approval.
  await db.query("UPDATE flow_sources SET id=$2 WHERE id=$1", [source.id, plan.source_ids[0]]);
  const schedule = await engine.createSchedule(scope, plan.actor, plan.policy_version, { source_ids: plan.source_ids, interval_seconds: plan.interval_seconds,
    timezone: plan.timezone, start_at: now.toISOString(), budget_micro_per_window: plan.budget_micro_per_window });
  await db.query(`INSERT INTO flow_monitors(id,tenant_id,workspace_id,name,keywords,source_ids,interval_seconds,timezone,schedule_id,approval_id,idempotency_key,budget_micro_per_window,version,canvas_id,canvas_auto_run_grant)
    VALUES($1,$2,$3,'Synthetic recurring WeChat',ARRAY['battery'],$4,$5,$6,$7,$8,'legacy-cycle-approval',$9,5,$10,$11)`,
    [plan.monitor_id, plan.tenant_id, plan.workspace_id, plan.source_ids, plan.interval_seconds, plan.timezone, schedule.id, plan.approval_id, plan.budget_micro_per_window, plan.canvas_id, JSON.stringify(plan)]);
  for (edition = 1; edition <= 3; edition++) {
    assert.equal(await engine.schedulerTick(), 1); assert.equal(await engine.schedulerTick(), 0);
    assert.equal((await engine.workOnce("legacy-canvas-worker"))?.status, "succeeded");
    now = new Date(now.getTime() + plan.interval_seconds * 1000);
  }
  const events = (await db.query("SELECT * FROM flow_outbox WHERE type='collection.completed' ORDER BY sequence")).rows;
  assert.equal(events.length, 3); assert.equal(gatewayCalls, 3);
  assert.ok(events.every(event => event.payload.cycle_complete && event.payload.cycle_status === "succeeded" && !event.payload.video_discovery));
  assert.equal((await db.query("SELECT count(*)::int n FROM flow_video_jobs")).rows[0].n, 0);
  console.log(JSON.stringify({ video_enabled: engine.video.enabled, gateway_calls: gatewayCalls, events,
    boundary: "actual Loom WeChat scheduler events; source gateway and persisted recurring approval are explicit fixtures" }));
} finally { await db.close(); }

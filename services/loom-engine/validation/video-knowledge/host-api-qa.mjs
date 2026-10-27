// Real host process integration, not a browser/rendering substitute. All state,
// users and signing keys are disposable synthetic fixtures. No model is invoked.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const output = process.env.VIDEO_QA_OUTPUT ?? "/workspace/shared/knowhow-qa";
const binary = process.env.VIDEO_QA_HOST_BINARY;
if (!binary) throw new Error("VIDEO_QA_HOST_BINARY must be an actual built backend/cmd/server binary");
const dir = await mkdtemp(resolve(tmpdir(), "knowhow-host-api-"));
const children = [], logs = {}, checks = [];
let cookie = "", workspace;
await mkdir(output, { recursive: true });
const port = async () => { const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const p = server.address().port; await new Promise(r => server.close(r)); return p; };
function start(name, command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); logs[name] = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", b => { logs[name] += b.toString(); });
  return child;
}
async function waitUntil(fn, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await fn().catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error("startup timed out: " + description);
}
let base;
async function api(method, path, data, extra = {}, expected = 200) {
  const response = await fetch(base + "/api" + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(workspace ? { "X-Workspace-Id": workspace } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const set = response.headers.getSetCookie(); if (set.length) cookie = set.map(x => x.split(";")[0]).join("; ");
  const body = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(body)}`);
  if (expected < 300) assert.equal(body.code, 0, `${method} ${path}: ${JSON.stringify(body)}`);
  return body.data;
}
try {
  const signingKey = "qa-host-fixture-signing-key-32-characters";
  const backendPort = await port(), webPort = await port(); base = `http://127.0.0.1:${webPort}`;
  start("loom", process.execPath, ["--experimental-strip-types", "validation/video-knowledge/gateway-loom-harness.ts"], resolve(repo, "services/loom-engine"), { VIDEO_QA_SIGNING_KEY: signingKey, VIDEO_QA_HOST_URL: `http://127.0.0.1:${backendPort}`, FLOW_VIDEO_ENABLED: "true" });
  await waitUntil(async () => /http:\/\/127\.0\.0\.1:\d+/.test(logs.loom), "actual Loom handler");
  const loomURL = logs.loom.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  start("backend", binary, [], resolve(repo, "backend"), { CANVAS_BACKEND_DATA_DIR: dir, CANVAS_BACKEND_ADDR: `127.0.0.1:${backendPort}`, CANVAS_CORS_ORIGINS: base, LOOM_ENGINE_URL: loomURL, FLOW_INTERNAL_JWT_SIGNING_KEY: signingKey, FLOW_VIDEO_ENABLED: "true" });
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${backendPort}/api/auth/settings`)).ok, "actual Go host");
  start("vite", process.env.VIDEO_QA_BUN ?? resolve(repo, "../runtime/bun-toolchain/package/bin/bun"), ["run", "dev", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], resolve(repo, "web"), { VITE_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}` });
  await waitUntil(async () => (await fetch(base)).ok, "actual Vite host");
  assert.equal((await api("GET", "/auth/settings")).firstUser, true);
  const password = "SyntheticOnly-" + crypto.randomUUID();
  await api("POST", "/auth/register", { username: "qa_host_fixture", displayName: "Synthetic QA", password, acceptedTerms: true });
  await api("POST", "/auth/logout", {});
  await api("POST", "/auth/login", { username: "qa_host_fixture", password });
  assert.ok((await api("GET", "/auth/session")).user);
  workspace = (await api("GET", "/intelligence/workspaces"))[0].id;
  checks.push("fresh real host register/logout/login/cookie session, workspace resolution through Vite proxy");
  const command = key => ({ "X-Idempotency-Key": key });
  const profile = await api("POST", "/intelligence/video/profiles", { name: "Synthetic host domain", config: { required_capabilities: ["transcript"] } }, command("profile"), 201);
  assert.equal(profile.version, 1);
  await api("POST", "/intelligence/video/profiles", { id: profile.id, name: profile.name, config: profile.config, expected_version: 0 }, command("profile-conflict"), 409);
  const source = await api("POST", "/intelligence/sources", { kind: "bilibili", title: "Synthetic host video", url: "https://www.bilibili.com/video/BV1QA0000001?p=1", config: { source_type: "video", native_id: "BV1QA0000001", part_id: "1", profile_id: profile.id, profile_version: profile.version, usage_basis: "Synthetic fixture only; no platform acquisition", allowed_uses: ["knowledge"] } }, command("source"), 201);
  const schedule = await api("POST", "/intelligence/schedules", { source_ids: [source.id], interval_seconds: 3600, budget_micro_per_window: 100 }, command("schedule"), 201);
  const paused = await api("PATCH", "/intelligence/schedules/" + schedule.id, { enabled: false, expected_revision: schedule.revision }, command("schedule-pause"));
  assert.equal(paused.enabled, false);
  await api("PATCH", "/intelligence/schedules/" + schedule.id, { enabled: true, expected_revision: schedule.revision }, command("schedule-stale"), 409);
  const resumed = await api("PATCH", "/intelligence/schedules/" + schedule.id, { enabled: true, expected_revision: paused.revision }, command("schedule-resume"));
  assert.equal(resumed.enabled, true); assert.equal(resumed.interval_seconds, 3600);
  checks.push("actual schedule pause/resume CAS, stale version rejection and unchanged cadence (not browser toggling)");
  const input = { source_id: source.id, content_version: "qa-v1", profile_id: profile.id, profile_version: profile.version };
  const job = await api("POST", "/intelligence/video/jobs", input, command("job"), 202);
  const replay = await api("POST", "/intelligence/video/jobs", input, command("job"), 202);
  assert.equal(replay.video_job_id, job.video_job_id);
  const recovered = await api("POST", "/intelligence/video/jobs/reconcile", { idempotency_key: "job" }, command("recover"));
  assert.equal(recovered.video_job_id, job.video_job_id);
  await api("POST", "/intelligence/video/jobs", { ...input, tenant_id: "foreign" }, command("forged"), 400);
  await api("GET", "/intelligence/video/jobs/" + job.video_job_id, undefined, { "X-Workspace-Id": "foreign" }, 404);
  await api("POST", "/intelligence/video/jobs/" + job.video_job_id + "/cancel", { reason: "Fixture cancellation" }, command("cancel"));
  assert.equal((await api("GET", "/intelligence/video/jobs/" + job.video_job_id)).state, "cancelled");
  const extractions = await api("GET", "/intelligence/knowledge/extractions?video_job_id=" + job.video_job_id);
  assert.equal(extractions.items.length, 0);
  await api("POST", "/intelligence/video/jobs/" + job.video_job_id + "/corrections", { expected_revision: 1, expected_content_hash: "a".repeat(64), reason: "Not ready fixture must reject", patches: [{ evidence_id: "not-ready", text: "Synthetic correction" }] }, command("not-ready-correction"), 409);
  const origins = await api("POST", "/intelligence/knowledge/origins", { assets: [{ asset_id: job.asset_id, expected_origin_cluster: null }], origin_cluster: "qa-origin", reason: "Explicit synthetic origin association" }, command("origin"));
  assert.equal(origins.origin_cluster, "qa-origin");
  checks.push("actual profile CAS, signed source/job calls, idempotency/reconcile, tenant spoof rejection, foreign workspace denial, durable cancellation");
  checks.push("real host extraction-list, correction readiness guard and scoped origin association routes");
  const target = { action: "revoked", asset_id: job.asset_id };
  const impact = await api("POST", "/intelligence/video/retention/preview", target, command("impact-preview"));
  assert.equal(impact.counts.assets, 1); assert.equal(impact.counts.jobs, 1);
  assert.match(impact.preview_hash, /^[a-f0-9]{64}$/);
  assert.equal(impact.after_action.historical_content_access, "denied");
  assert.equal(impact.audit_retained.financial_events, true);
  assert.ok(!JSON.stringify(impact).includes(source.url));
  const item = { ...target, reason: "Explicit synthetic impact review", confirmation: "revoked", expected_impact_hash: impact.preview_hash, idempotency_key: "impact-apply" };
  const stale = await api("POST", "/intelligence/video/retention/batch", { items: [{ ...item, expected_impact_hash: "a".repeat(64), idempotency_key: "impact-stale" }] }, command("batch-stale"));
  assert.equal(stale.results[0].ok, false); assert.equal(stale.results[0].status, 409);
  const batchInput = { items: [item, { ...item, asset_id: "qa-missing-asset", expected_impact_hash: "b".repeat(64), idempotency_key: "impact-missing" }] };
  const partial = await api("POST", "/intelligence/video/retention/batch", batchInput, command("batch-partial"));
  assert.equal(partial.partial, true); assert.equal(partial.results[0].ok, true); assert.equal(partial.results[1].status, 404);
  const batchReplay = await api("POST", "/intelligence/video/retention/batch", batchInput, command("batch-replay"));
  assert.deepEqual(batchReplay, partial);
  checks.push("actual cookie-authenticated retention impact preview, stale graph CAS denial, partial batch per-target errors and stable replay; no physical deletion inferred");
  const catalog = await api("GET", "/intelligence/skills");
  assert.ok(catalog.packs.some(p => p.id === "video-knowledge-core"));
  const installed = await api("POST", "/intelligence/skills/install", { packId: "video-knowledge-core" });
  assert.equal(installed.length, 1);
  const conv = await api("POST", "/agent/conversations", { subject: { kind: "intelligence_workspace", id: workspace }, title: "Synthetic native skill load" }, {}, 201);
  const loaded = await api("POST", "/agent/conversations/" + conv.id + "/tool-calls", { callId: "load-native", name: "intel_load_skill", arguments: { skill_id: "video-knowledge-core" } });
  assert.equal(loaded.status, "succeeded"); assert.notEqual(loaded.truncated, true);
  assert.ok(JSON.stringify(loaded).includes("knowledge_units"));
  assert.ok(JSON.stringify(loaded).includes("1.0.0"));
  assert.ok(loaded.output.knowledge_snapshot.id);
  assert.match(loaded.output.knowledge_snapshot.content_hash, /^[a-f0-9]{64}$/);
  const loadedAgain = await api("POST", "/agent/conversations/" + conv.id + "/tool-calls", { callId: "load-native-again", name: "intel_load_skill", arguments: { skill_id: "video-knowledge-core" } });
  assert.equal(loadedAgain.output.knowledge_snapshot.id, loaded.output.knowledge_snapshot.id);
  assert.equal(loadedAgain.output.knowledge_snapshot.content_hash, loaded.output.knowledge_snapshot.content_hash);
  checks.push("actual native JSON pack install and conversation skill load with real Loom→host registry callback, frozen knowledge snapshot and stable reload (not model output)");
  const published = await api("POST", "/intelligence/knowledge/search", { q: "synthetic", limit: 10 });
  assert.equal(published.items.length, 0);
  checks.push("published knowledge search remains empty; queued raw video not promoted");
  for (const route of ["domains", "sources", "video-jobs", "video-knowledge", "video-skills"]) {
    const page = await fetch(base + "/intelligence/" + route);
    assert.equal(page.status, 200); assert.match(await page.text(), /type="module"/);
  }
  checks.push("actual Vite SPA route documents served; browser execution NOT claimed");
  const result = { mode: "actual-Go-host-cookie-session-Vite-proxy-Loom-PGlite", checks, workspace_id: workspace, operation_id: job.operation_id, video_job_id: job.video_job_id, browser: "blocked-before-launch-by-executor-IPC-policy", not_executed: ["live platform acquisition", "real model quality", "human industry review", "seven-day pilot", "deployment"] };
  await writeFile(resolve(output, "host-api-qa.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error); for (const [name, log] of Object.entries(logs)) console.error(name + " tail: " + log.slice(-5000)); throw error;
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : Promise.race([once(child, "exit"), new Promise(r => setTimeout(r, 3000))])));
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
}

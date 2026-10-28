// Loom Engine (WeaveSense-Flow) entrypoint. LOOM_ROLE=api|scheduler|enrich|research|all.
//  enrich:    attachment retry + OCR loops only (compose profile "extract")
//  research:  periodic briefs only (compose profile "research")
// With LOOM_SPLIT_ROLES=true the api/scheduler roles leave those loops to the dedicated roles.
//  api:       internal HTTP API + collection worker + outbox dispatcher
//  scheduler: the single due-window scanner (guarded by a PG advisory lock)
import { derivedTick, embedderFromEnv } from "./gaps9.ts";
import { pgDb, migrate } from "./db.ts";
import { Engine } from "./engine.ts";
import { createApiServer } from "./server.ts";
import { Reports } from "./reports.ts";
import { sign } from "./auth.ts";
import { hostname } from "node:os";
import { configureVideoKnowledge, platformKnowledgeRuntime } from "./video-knowledge-runtime.ts";
import { VideoKnowledgeExtractor } from "./video-knowledge-extractor.ts";
import { VideoOriginCandidates } from "./video-origin-candidates.ts";
import { VideoKnowledgeEvaluator } from "./video-knowledge-evaluator.ts";
import { closeKnowledgeBudget } from "./video-knowledge-budget.ts";
import { configureVideoRetentionJournal, replayVideoRetentionJournal } from "./video-journal.ts";
import { applyVideoRetention } from "./video-knowledge.ts";
import { setVideoAccessReady } from "./video-access.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k]?.trim();
  if (v) return v;
  if (d !== undefined) return d;
  throw new Error(`missing env ${k}`);
};
const role = env("LOOM_ROLE", "api");
if (!["api", "scheduler", "enrich", "research", "all"].includes(role)) throw new Error(`invalid LOOM_ROLE ${role}`);
const split = env("LOOM_SPLIT_ROLES", "false") === "true";
const runEnrich = role === "enrich" || role === "all" || (role === "api" && !split);
const runBriefs = role === "research" || role === "all" || (role === "scheduler" && !split);
const db = await pgDb(env("DATABASE_URL"));
if (env("LOOM_AUTO_MIGRATE", "true") === "true") console.log("[loom] migrations applied:", await migrate(db));
const engine = new Engine(db);
const key = env("FLOW_INTERNAL_JWT_SIGNING_KEY");
if (env("VIDEO_DELETION_JOURNAL_DIR", "") || env("VIDEO_DELETION_JOURNAL_ID", "") || env("VIDEO_DELETION_JOURNAL_KEY", "")) {
  try { configureVideoRetentionJournal(engine, { directory: env("VIDEO_DELETION_JOURNAL_DIR"), journalId: env("VIDEO_DELETION_JOURNAL_ID"), key: env("VIDEO_DELETION_JOURNAL_KEY") },
    (q, event) => applyVideoRetention(engine, q, event, event)); }
  catch { console.error("[loom:video-quarantined] video_journal_configuration_required"); }
}
// Quarantine video until independent deletion history is replayed; keep unrelated host/RSS capabilities alive.
setVideoAccessReady(engine, false);
const videoBarrier = async () => {
  try { await replayVideoRetentionJournal(engine); setVideoAccessReady(engine, true); return true; }
  catch (error: any) { setVideoAccessReady(engine, false); console.error("[loom:video-quarantined]", error.reason ?? "video_journal_unavailable"); return false; }
};
await videoBarrier();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });

async function loop(name: string, ms: number, fn: () => Promise<unknown>) {
  while (!stopping) {
    try { await fn(); } catch (e) { console.error(`[loom:${name}]`, e); }
    await sleep(ms);
  }
}

// Platform hooks (re-check grants, LLM brief summarization). Service token, aud = platform issuer.
const platformBase = env("FLOW_PLATFORM_INTERNAL_URL", "");
const platformCall = async (path: string, sc: { tenant_id: string; workspace_id: string }, body: unknown, scopes = ["flow.grants.check"]) => {
  const tok = sign(key, { iss: "loom-engine", aud: env("FLOW_INTERNAL_JWT_ISSUER", "flow-platform"), tenant_id: sc.tenant_id, workspace_id: sc.workspace_id,
    actor: { type: "service_principal", id: "loom-engine" }, scopes, policy_version: "policy_v1" });
  return fetch(`${platformBase}${path}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
};
if (platformBase) {
  configureVideoKnowledge(engine, platformKnowledgeRuntime({ baseURL: platformBase, signingKey: key, audience: env("FLOW_INTERNAL_JWT_ISSUER", "flow-platform") }));
  engine.video.budgetStatus = async job => {
    const token = sign(key, { iss: "loom-engine", aud: env("FLOW_INTERNAL_JWT_ISSUER", "flow-platform"), tenant_id: job.tenant_id, workspace_id: job.workspace_id,
      actor: { type: "service_principal", id: "loom-engine" }, job_id: job.id, scopes: ["intel.video.model"], policy_version: job.policy_version });
    const response = await fetch(`${platformBase}/api/internal/flow/video/budget`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`video budget ${response.status}`);
    const result = await response.json() as any; return result.data ?? result;
  };
  engine.authorize = async (sc, scope) => {
    const r = await platformCall("/api/internal/flow/authorize", sc, { grant_actor: sc.grant_actor, workspace_id: sc.workspace_id, scope });
    if (r.status === 403) return false;
    if (!r.ok) throw new Error(`authorize ${r.status}`);
    return true;
  };
}
// PRD §9.2: scheduled windows reserve budget with the platform ledger; settled/released when the operation ends.
if (platformBase) {
  engine.budget = {
    lookup: async (sc, key, refId) => {
      const r = await platformCall("/api/internal/flow/budget/lookup", sc, { workspace_id: sc.workspace_id, key, ref_id: refId }, ["flow.budget.lookup"]);
      if (!r.ok) throw new Error(`budget lookup ${r.status}`);
      const result = ((await r.json()) as any).data;
      if (result === null) return null;
      if (typeof result?.reservation_id !== "string" || !result.reservation_id) throw new Error("invalid budget lookup receipt");
      return { reservation_id: result.reservation_id };
    },
    reserve: async (sc, key, amount, refId) => {
      const r = await platformCall("/api/internal/flow/budget/reserve", sc, { grant_actor: sc.grant_actor, workspace_id: sc.workspace_id, key, amount_micro: amount, ref_id: refId });
      if (r.status === 402 || r.status === 403) throw Object.assign(new Error(`budget denied ${r.status}`), { status: 402 });
      if (!r.ok) throw new Error(`budget reserve ${r.status}`);
      return { reservation_id: ((await r.json()) as any).data?.reservation_id };
    },
    close: async (sc, id, outcome, actual) => {
      const r = await platformCall("/api/internal/flow/budget/close", sc, { reservation_id: id, outcome, actual_micro: actual });
      if (!r.ok) throw new Error(`budget close ${r.status}`);
    },
  };
}
// LLM brief summarization through the platform (non-blocking). 202: the platform
// enqueued a model task; the brief window stays parked. Completion is pushed
// (POST /v1/briefs/wake when the task finishes); the scheduler tick re-submits
// the same key as fallback.
const summarize: Reports["summarize"] = platformBase ? async (input) => {
  const r = await platformCall("/api/internal/flow/summarize", input, input);
  if (r.status === 403) throw Object.assign(new Error("grant revoked"), { status: 403 });
  if (r.status === 202) return { pending: true, task_id: ((await r.json()) as any).data?.task_id };
  if (!r.ok) throw new Error(`summarize ${r.status}`);
  return ((await r.json()) as any).data ?? null;
} : undefined;
if (role === "api" || role === "all") {
  const port = Number(env("LOOM_PORT", "8080"));
  createApiServer(engine, { signingKey: key, audience: env("FLOW_INTERNAL_JWT_AUDIENCE", "loom-engine"), issuer: env("FLOW_INTERNAL_JWT_ISSUER", "flow-platform"), summarize }).listen(port, () => console.log(`[loom] api on :${port}`));
  const owner = `${hostname()}:${process.pid}`;
  void loop("worker", 1000, async () => { while (!stopping && (await engine.workOnce(owner))); });
  // Same Loom deployment/DB, independent durable stage claims; no chat or HTTP lifetime dependency.
  if (engine.video.enabled) void loop("video-worker", 1000, async () => { if (await videoBarrier()) while (!stopping && (await engine.video.workOnce(owner))); });
  const platform = env("FLOW_PLATFORM_EVENTS_URL", "");
  if (platform) {
    const iss = env("FLOW_INTERNAL_JWT_ISSUER", "flow-platform");
    void loop("outbox", 2000, () => engine.dispatchOutbox(async (ev) => {
      const tok = sign(key, { iss: "loom-engine", aud: iss, tenant_id: ev.tenant_id, workspace_id: ev.workspace_id,
        actor: { type: "service_principal", id: "loom-engine" }, scopes: ["flow.events.write"], policy_version: "policy_v1" });
      const r = await fetch(platform, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(ev) });
      if (!r.ok) throw new Error(`platform ${r.status}`);
    }));
  }
}
if (role === "scheduler" || role === "all") {
  // schedulerTick takes a transaction-scoped advisory lock: one active scanner only.
  void loop("scheduler", Number(env("LOOM_SCHEDULER_TICK_MS", "15000")), () => engine.schedulerTick());
}
if (runBriefs) {
  // Periodic briefs: each (schedule, window) is idempotent, so overlapping ticks produce one report.
  const reports = new Reports(engine);
  reports.summarize = summarize;
  void loop("briefs", Number(env("LOOM_SCHEDULER_TICK_MS", "15000")), () => reports.briefTick());
}
if (runEnrich) {
  if (engine.video.enabled) {
    const extractor = new VideoKnowledgeExtractor(engine), evaluator = new VideoKnowledgeEvaluator(engine), origins = new VideoOriginCandidates(engine);
    const owner = `${hostname()}:${process.pid}:knowledge`;
    void loop("video-knowledge", 2000, async () => { if (await videoBarrier()) while (!stopping && await extractor.workOnce(owner)); });
    void loop("video-skill-evaluation", 2000, async () => { if (await videoBarrier()) while (!stopping && await evaluator.workOnce(owner)); });
    void loop("video-origin-candidates", 2000, async () => { if (await videoBarrier()) while (!stopping && await origins.workOnce(owner)); });
  }
  // Rollback stops new processing, not revocation cleanup or settlement of already incurred work.
  void loop("video-maintenance", 30000, async () => {
    if (!await videoBarrier()) return;
    await engine.video.maintain();
    await closeKnowledgeBudget(engine, "video_knowledge_extract");
    await closeKnowledgeBudget(engine, "video_skill_evaluate");
  });
  // §6.4: attachments not stored during a run are retried separately (bounded attempts), never by re-collecting.
  // PRD §6.2: jobs whose commit outcome was unknown are settled from the outbox.
  void loop("reconcile", Number(env("LOOM_RECONCILE_MS", "30000")), async () => { await engine.reconcile(); await engine.closeBudgets(); });
  void loop("media-retry", Number(env("LOOM_MEDIA_RETRY_MS", "120000")), () => engine.retryMedia());
  if (env("ASR_ENABLED", "false") === "true") void loop("asr", Number(env("LOOM_ASR_TICK_MS", "60000")), () => engine.asrTick());
  // §6.4 embed + analyze run as their own jobs (unique per content hash). Embedding is pluggable (EMBED_PROVIDER=none|hash).
  const embedder = embedderFromEnv();
  void loop("derived", Number(env("LOOM_DERIVED_TICK_MS", "20000")), () => derivedTick(engine.db, embedder));
  if (env("OCR_ENABLED", "false") === "true") void loop("ocr", Number(env("LOOM_OCR_TICK_MS", "30000")), () => engine.ocrTick());
}

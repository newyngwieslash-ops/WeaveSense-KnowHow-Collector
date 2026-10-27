// Internal HTTP API for the Go platform. Every /v1 call needs a verified execution context.
import { metricsText } from "./metrics.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { verify, requireScope, AuthError, type ExecutionContext } from "./auth.ts";
import { Engine, HttpError } from "./engine.ts";
import { Reports } from "./reports.ts";
import { withTenant } from "./db.ts";
import { downloadMedia, downloadRawResponse, listDerivedJobs, getAnalysis } from "./gaps9.ts";
import { videoKnowledgeRoutes } from "./video-knowledge-routes.ts";
import { assertVideoRetentionJournal } from "./video-journal.ts";
import { withVideoAccess } from "./video-access.ts";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { videoMetrics } from "./video-metrics.ts";

export interface ServerConfig {
  signingKey: string;
  audience: string;
  issuer?: string;
  /** Platform Model Gateway hook so a pushed brief wake-up can complete the window here. */
  summarize?: Reports["summarize"];
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > 1 << 20) throw new HttpError(413, "body too large"); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid json"); }
}

function send(res: ServerResponse, status: number, data: unknown, msg = "ok", reason?: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: status >= 400 ? status : 0, data, msg, ...(reason ? { reason } : {}) }));
}

// A normal context token authorizes API access, not a recurring grant. The platform
// attests the exact server-built mutation only after resolving its real approval.
function monitorBody(body: any, authorization?: { key: string; ctx: ExecutionContext; monitorId: string }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid json object");
  if (Object.hasOwn(body, "canvas_authorization")) {
    const denied = () => Object.assign(new HttpError(403, "canvas_authorization_invalid"), { reason: "canvas_authorization_invalid" });
    if (!authorization || Object.keys(body).length !== 1) throw denied();
    const proof = body.canvas_authorization;
    if (typeof proof?.payload !== "string" || typeof proof.signature !== "string" || !/^[a-f0-9]{64}$/.test(proof.signature)) throw denied();
    const expected = createHmac("sha256", authorization.key).update("monitor-canvas-v1\n" + proof.payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(proof.signature, "hex"))) throw denied();
    let attested: any;
    try { attested = JSON.parse(Buffer.from(proof.payload, "base64url").toString("utf8")); } catch { throw denied(); }
    const now = Math.floor(Date.now()/1000), ctx = authorization.ctx;
    if (attested.tenant_id !== ctx.tenant_id || attested.workspace_id !== ctx.workspace_id || attested.actor !== `${ctx.actor.type}:${ctx.actor.id}`
      || attested.monitor_id !== authorization.monitorId || !Number.isSafeInteger(attested.expires_at) || attested.expires_at <= now || attested.expires_at > now+120
      || !attested.mutation?.canvas_auto_run_grant || !Number.isSafeInteger(attested.mutation.expected_version)) throw denied();
    return attested.mutation;
  }
  if (body.canvas_auto_run_grant != null) throw Object.assign(new HttpError(409, "canvas_approval_unavailable"), { reason: "canvas_approval_unavailable" });
  if (Object.hasOwn(body, "canvas_config")) throw Object.assign(new HttpError(400, "canvas_client_snapshot_forbidden"), { reason: "canvas_client_snapshot_forbidden" });
  return body;
}

export function handler(engine: Engine, cfg: ServerConfig) {
  const knowledgeRoute = videoKnowledgeRoutes(engine);
  const rp = new Reports(engine);
  rp.summarize = cfg.summarize;
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://engine");
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname === "/metrics" && req.method === "GET") {
        // Internal network only; optional bearer (METRICS_TOKEN) for scrapers.
        const mt = process.env.METRICS_TOKEN ?? "";
        if (mt && (req.headers.authorization ?? "") !== `Bearer ${mt}`) return send(res, 401, null, "unauthorized");
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        return res.end(await metricsText(engine.db));
      }
      const auth = req.headers.authorization ?? "";
      const ctx: ExecutionContext = verify(cfg.signingKey, auth.replace(/^Bearer /, ""), cfg.audience);
      if (cfg.issuer && ctx.iss !== cfg.issuer) throw new AuthError("invalid issuer");
      // Postgres RLS second layer: every query of this request runs with app.tenant_id = token tenant.
      return await withTenant(ctx.tenant_id, async () => {
        let videoAllowed = true;
        try { await assertVideoRetentionJournal(engine, { tenant_id: ctx.tenant_id, workspace_id: ctx.workspace_id }); }
        catch (e: any) {
          if (typeof e.reason !== "string" || !e.reason.startsWith("video_journal_")) throw e;
          videoAllowed = false;
          if (/^\/v1\/(video|knowledge)(\/|$)/.test(url.pathname)) throw e;
        }
        return withVideoAccess(engine, videoAllowed, () => route(req, res, url, ctx));
      });
    } catch (e: any) {
      if (e instanceof AuthError || e instanceof HttpError) return send(res, e.status, null, e.message, (e as any).reason);
      if ([409, 503].includes(e.status) && typeof e.reason === "string" && e.reason.startsWith("video_journal_")) return send(res, e.status, null, "video material quarantined until deletion history is verified", e.reason);
      console.error("[loom-engine]", e);
      return send(res, 500, null, "internal error");
    }
  };
  async function route(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ExecutionContext) {
    {
      const p = url.pathname, m = req.method;
      let mm: RegExpMatchArray | null;
      const knowledgeResult = await knowledgeRoute(m, url, ctx, () => readJson(req), String(req.headers["x-idempotency-key"] ?? ""));
      if (knowledgeResult) return send(res, knowledgeResult.status, knowledgeResult.data);
      const videoKey = () => String(req.headers["x-idempotency-key"] ?? "");
      const serviceJob = (id: string, scope: string) => {
        requireScope(ctx, scope);
        if (ctx.actor.type !== "service_principal" || ctx.job_id !== id) throw Object.assign(new HttpError(403, "SCOPE_DENIED"), { reason: "SCOPE_DENIED" });
      };
      if (p === "/v1/video/profiles" && m === "GET") { requireScope(ctx, "intel.video.read"); return send(res, 200, await engine.video.listProfiles(ctx, url.searchParams.get("id") ?? undefined, url.searchParams.get("cursor") ?? undefined, Number(url.searchParams.get("limit")) || 100)); }
      if (p === "/v1/video/metrics" && m === "GET") { requireScope(ctx, "intel.video.read"); return send(res, 200, await videoMetrics(engine, ctx, { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined, profile_id: url.searchParams.get("profile_id") ?? undefined })); }
      if (p === "/v1/video/profiles" && m === "POST") { requireScope(ctx, "intel.profiles.write"); return send(res, 201, await engine.video.saveProfile(ctx, await readJson(req))); }
      if (p === "/v1/video/discover" && m === "POST") { requireScope(ctx, "intel.video.read"); return send(res, 202, await engine.video.discover(ctx, videoKey(), await readJson(req))); }
      if (m === "GET" && (mm = p.match(/^\/v1\/video\/discover\/([\w-]+)$/))) { requireScope(ctx, "intel.video.read"); return send(res, 200, await engine.video.discoveryResult(ctx, mm[1], url.searchParams.get("cursor") ?? "0", Number(url.searchParams.get("limit")) || 50)); }
      if (m === "POST" && (mm = p.match(/^\/v1\/video\/sources\/([\w-]+)\/backfill$/))) { requireScope(ctx, "intel.video.process"); const b = await readJson(req); return send(res, 202, await engine.video.discover(ctx, videoKey(), { ...b, source_id: mm[1], window: { from: b.from, to: b.to } }, true)); }
      if (p === "/v1/video/jobs" && m === "POST") { requireScope(ctx, "intel.video.process"); return send(res, 202, await engine.video.start(ctx, videoKey(), await readJson(req))); }
      if (p === "/v1/video/jobs" && m === "GET") { requireScope(ctx, "intel.video.read"); return send(res, 200, await engine.video.list(ctx, url.searchParams.get("cursor") ?? undefined, Number(url.searchParams.get("limit")) || 50, url.searchParams.get("state") ?? undefined)); }
      if (p === "/v1/video/jobs/reconcile" && m === "POST") { requireScope(ctx, "intel.video.process"); return send(res, 200, await engine.video.reconcile(ctx, await readJson(req))); }
      if (m === "PUT" && (mm = p.match(/^\/v1\/video\/jobs\/([\w-]+)\/input$/))) {
        requireScope(ctx, "intel.video.process");
        if (ctx.job_id !== mm[1]) throw Object.assign(new HttpError(403, "SCOPE_DENIED"), { reason: "SCOPE_DENIED" });
        return send(res, 200, await engine.video.uploadInput(ctx, mm[1], req, Number(req.headers["content-length"]), String(req.headers["content-type"] ?? "")));
      }
      if (m === "GET" && (mm = p.match(/^\/v1\/video\/jobs\/([\w-]+)\/media\/([a-f0-9]{32})$/))) {
        requireScope(ctx, "intel.video.read");
        const media = await engine.video.mediaObject(ctx, mm[1], mm[2], req.headers.range);
        const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
        for (const name of ["content-type", "content-length", "content-range", "etag", "accept-ranges"]) { const value = media.headers.get(name); if (value) headers[name] = value; }
        res.writeHead(media.status, headers);
        try { await pipeline(Readable.fromWeb(media.body as any), res); } catch { res.destroy(); }
        return;
      }
      if ((mm = p.match(/^\/v1\/video\/jobs\/([\w-]+)(?:\/(cancel|retry|repair|reconcile|import|artifacts|result|model-authorization|corrections))?$/))) {
        const id = mm[1], action = mm[2];
        if (m === "GET" && !action) { requireScope(ctx, "intel.video.read"); return send(res, 200, await engine.video.get(ctx, id)); }
        if (m === "GET" && action === "model-authorization") { serviceJob(id, "intel.video.model"); return send(res, 200, await engine.video.modelAuthorization(ctx, id,
          { stage_attempt: Number(url.searchParams.get("stage_attempt")), fencing_token: Number(url.searchParams.get("fencing_token")) }, url.searchParams.get("purpose") ?? "video_vision")); }
        if (m === "GET" && (action === "artifacts" || action === "result")) { requireScope(ctx, "intel.video.read"); return send(res, 200, await engine.video.artifacts(ctx, id, url.searchParams.get("cursor") ?? "0", Number(url.searchParams.get("limit")) || 50, url.searchParams.get("kind") ?? "evidence", Number(url.searchParams.get("text_offset")) || 0, Number(url.searchParams.get("conflict_offset")) || 0, url.searchParams.get("text_field") ?? "text")); }
        if (m === "POST" && action === "import") { serviceJob(id, "intel.video.import"); return send(res, 200, await engine.video.importManifest(ctx, id, await readJson(req))); }
        if (m === "POST" && action === "cancel") { requireScope(ctx, "intel.video.process"); return send(res, 200, await engine.video.cancel(ctx, id, (await readJson(req)).reason)); }
        if (m === "POST" && action === "retry") { requireScope(ctx, "intel.video.process"); return send(res, 200, await engine.video.retry(ctx, id)); }
        if (m === "POST" && action === "repair") { requireScope(ctx, "intel.video.process"); return send(res, 202, await engine.video.repair(ctx, id, videoKey())); }
        if (m === "POST" && action === "reconcile") { requireScope(ctx, "intel.video.process"); return send(res, 200, await engine.video.reconcile(ctx, { video_job_id: id })); }
        if (m === "POST" && action === "corrections") { requireScope(ctx, "intel.knowledge.review"); return send(res, 201, await engine.video.correct(ctx, id, videoKey(), await readJson(req))); }
      }
      if (m === "GET" && (mm = p.match(/^\/v1\/video\/jobs\/([\w-]+)\/artifacts\/raw$/))) {
        serviceJob(mm[1], "intel.video.model");
        const obj = await engine.video.rawObject(ctx, mm[1], url.searchParams.get("object_key") ?? "",
          { stage_attempt: Number(url.searchParams.get("stage_attempt")), fencing_token: Number(url.searchParams.get("fencing_token")) });
        res.writeHead(200, { "content-type": obj.content_type, "content-length": obj.bytes.byteLength, "x-content-sha256": obj.sha256, "cache-control": "no-store" }); return res.end(obj.bytes);
      }
      if (m === "GET" && p === "/v1/sources") { requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.listSources(ctx)); }
      if (m === "POST" && p === "/v1/sources") { requireScope(ctx, "intel.sources.write"); return send(res, 201, await engine.createSource(ctx, await readJson(req))); }
      if (m === "GET" && p === "/v1/schedules") { requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.listSchedules(ctx)); }
      if (m === "POST" && p === "/v1/schedules") {
        requireScope(ctx, "intel.schedules.write");
        return send(res, 201, await engine.createSchedule(ctx, `${ctx.actor.type}:${ctx.actor.id}`, ctx.policy_version, await readJson(req)));
      }
      if (m === "PATCH" && (mm = p.match(/^\/v1\/schedules\/([\w-]+)$/))) {
        requireScope(ctx, "intel.schedules.write"); return send(res, 200, await engine.setScheduleEnabled(ctx, mm[1], await readJson(req)));
      }
      if (m === "GET" && p === "/v1/collection-runs") {
        requireScope(ctx, "intel.sources.read");
        return send(res, 200, await engine.listJobs(ctx, { limit: Number(url.searchParams.get("limit")) || undefined, status: url.searchParams.get("status") ?? undefined }));
      }
      if (m === "POST" && p === "/v1/collection-runs") {
        requireScope(ctx, "intel.collect");
        const r = await engine.requestCollection(ctx, String(req.headers["x-idempotency-key"] ?? ""), await readJson(req));
        return send(res, 202, r, "accepted");
      }
      if (m === "GET" && p === "/v1/documents") {
        requireScope(ctx, "intel.documents.read");
        return send(res, 200, await engine.listDocuments(ctx, { q: url.searchParams.get("q") ?? undefined, limit: Number(url.searchParams.get("limit")), source_id: url.searchParams.get("source_id") ?? undefined }));
      }
      if (m === "GET" && (mm = p.match(/^\/v1\/documents\/([\w-]+)\/revisions\/(\d+)$/))) {
        requireScope(ctx, "intel.documents.read"); return send(res, 200, await engine.getRevision(ctx, mm[1], Number(mm[2])));
      }
      if (m === "GET" && (mm = p.match(/^\/v1\/operations\/([\w-]+)$/))) {
        requireScope(ctx, "intel.operations.read"); return send(res, 200, await engine.getOperation(ctx, mm[1]));
      }
      if (m === "POST" && p === "/v1/documents/search") { requireScope(ctx, "intel.documents.read"); return send(res, 200, await engine.searchDocuments(ctx, await readJson(req))); }
      if (m === "POST" && p === "/v1/documents/read") { requireScope(ctx, "intel.documents.read"); return send(res, 200, await engine.readDocument(ctx, await readJson(req))); }
      if (m === "POST" && p === "/v1/evidence") { requireScope(ctx, "intel.documents.read"); return send(res, 201, await engine.createEvidence(ctx, String(req.headers["x-idempotency-key"] ?? ""), await readJson(req))); }
      if (m === "GET" && p === "/v1/evidence") { requireScope(ctx, "intel.documents.read"); return send(res, 200, await engine.listEvidence(ctx, url.searchParams.get("document_id") ?? undefined)); }
      if (m === "GET" && (mm = p.match(/^\/v1\/monitors\/([\w-]+)\/hits$/))) {
        requireScope(ctx, "intel.documents.read");
        return send(res, 200, await engine.listMonitorHits(ctx, mm[1], {
          from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
          offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
        }));
      }
      if (m === "GET" && (mm = p.match(/^\/v1\/schedules\/([\w-]+)\/canvas-binding$/))) {
        requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.getScheduleCanvasBinding(ctx, mm[1]));
      }
      if (m === "GET" && p === "/v1/monitors") { requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.listMonitors(ctx)); }
      if (m === "POST" && p === "/v1/monitors/preview") { requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.previewMonitor(ctx, monitorBody(await readJson(req)))); }
      if (m === "POST" && p === "/v1/monitors") {
        requireScope(ctx, "intel.monitors.write");
        const b = monitorBody(await readJson(req));
        return send(res, 201, await engine.applyMonitor(ctx, `${ctx.actor.type}:${ctx.actor.id}`, ctx.policy_version,
          { ...b, idempotency_key: String(req.headers["x-idempotency-key"] ?? b.idempotency_key ?? "") }));
      }
      if (m === "GET" && (mm = p.match(/^\/v1\/monitors\/previews\/([\w-]+)$/))) { requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.getMonitorPreview(ctx, mm[1])); }
      if (m === "PATCH" && (mm = p.match(/^\/v1\/monitors\/([\w-]+)$/))) {
        requireScope(ctx, "intel.monitors.write");
        return send(res, 200, await engine.updateMonitor(ctx, `${ctx.actor.type}:${ctx.actor.id}`, mm[1], monitorBody(await readJson(req), { key: cfg.signingKey, ctx, monitorId: mm[1] })));
      }
      if (m === "GET" && (mm = p.match(/^\/v1\/monitors\/([\w-]+)\/revisions$/))) { requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.listMonitorRevisions(ctx, mm[1])); }
      if (m === "GET" && (mm = p.match(/^\/v1\/reports\/([\w-]+)\/export$/))) {
        requireScope(ctx, "intel.documents.read"); return send(res, 200, await rp.exportReport(ctx, mm[1], url.searchParams.get("format") ?? "md"));
      }
      if (m === "GET" && p === "/v1/media") {
        requireScope(ctx, "intel.documents.read");
        const mode = url.searchParams.get("mode") === "presign" ? "presign" : "proxy";
        const wantStream = mode === "proxy" && (url.searchParams.get("stream") === "1" || req.headers["x-flow-accept-stream"] === "1");
        const got: any = await downloadMedia(engine.db, engine.objectStore, ctx, {
          document_id: url.searchParams.get("document_id") ?? "",
          object_key: url.searchParams.get("object_key") ?? "",
          mode,
          stream: wantStream,
          expires: Number(url.searchParams.get("expires")) || undefined,
        });
        if (wantStream && Buffer.isBuffer(got.bytes)) {
          res.writeHead(200, {
            "content-type": got.content_type || "application/octet-stream",
            "content-length": String(got.bytes.length),
            "cache-control": "private, no-store",
            "x-flow-media-stream": "1",
            "x-flow-filename": encodeURIComponent(got.filename),
            "x-flow-sha256": got.sha256,
          });
          return res.end(got.bytes);
        }
        return send(res, 200, got);
      }
      if (m === "GET" && (mm = p.match(/^\/v1\/collection-runs\/([\w-]+)\/raw-response$/))) {
        requireScope(ctx, "intel.operations.read");
        return send(res, 200, await downloadRawResponse(engine.db, engine.objectStore, ctx, { run_id: mm[1] }));
      }
      if (m === "GET" && p === "/v1/derived-jobs") { requireScope(ctx, "intel.operations.read"); return send(res, 200, await listDerivedJobs(engine.db, ctx, url.searchParams.get("document_id") ?? undefined)); }
      if (m === "GET" && (mm = p.match(/^\/v1\/documents\/([\w-]+)\/analysis$/))) { requireScope(ctx, "intel.documents.read"); return send(res, 200, await getAnalysis(engine.db, ctx, mm[1])); }
      if (m === "POST" && (mm = p.match(/^\/v1\/operations\/([\w-]+)\/cancel$/))) { requireScope(ctx, "intel.collect"); return send(res, 200, await engine.cancelOperation(ctx, mm[1])); }
      const idem = () => String(req.headers["x-idempotency-key"] ?? "");
      const actor = `${ctx.actor.type}:${ctx.actor.id}`;
      if (m === "POST" && p === "/v1/evidence/resolve") { requireScope(ctx, "intel.documents.read"); return send(res, 200, await rp.resolveEvidence(ctx, (await readJson(req)).evidence_ids ?? [])); }
      if (m === "GET" && p === "/v1/reports/by-key") { requireScope(ctx, "intel.reports.write"); return send(res, 200, await rp.reportByKey(ctx, url.searchParams.get("key") ?? "", url.searchParams.get("request_hash") ?? "")); }
      if (m === "GET" && p === "/v1/reports") { requireScope(ctx, "intel.documents.read"); return send(res, 200, await rp.listReports(ctx)); }
      if (m === "GET" && (mm = p.match(/^\/v1\/reports\/([\w-]+)$/))) { requireScope(ctx, "intel.documents.read"); return send(res, 200, await rp.getReport(ctx, mm[1])); }
      if (m === "POST" && p === "/v1/reports") { requireScope(ctx, "intel.reports.write"); return send(res, 201, await rp.saveReport(ctx, actor, idem(), await readJson(req))); }
      if (m === "POST" && p === "/v1/research-runs") {
        requireScope(ctx, "intel.research");
        // ?async=1 is the §11 REST contract (202 + id); the agent tool keeps the synchronous result.
        if (url.searchParams.get("async") === "1") {
          const b = await readJson(req);
          const r = await rp.startResearch(ctx, idem(), { ...b, capability_snapshot_id: ctx.capability_snapshot_id, parent_run_id: b.parent_run_id || `rest:${ctx.actor.type}:${ctx.actor.id}:${idem()}` }, { async: true });
          return send(res, (r as any).replayed ? 200 : 202, r, "accepted");
        }
        return send(res, 201, await rp.startResearch(ctx, idem(), { ...(await readJson(req)), capability_snapshot_id: ctx.capability_snapshot_id }));
      }
      if (m === "GET" && (mm = p.match(/^\/v1\/research-runs\/([\w-]+)$/))) { requireScope(ctx, "intel.documents.read"); return send(res, 200, await rp.getResearch(ctx, mm[1])); }
      if (m === "POST" && (mm = p.match(/^\/v1\/research-runs\/([\w-]+)\/cancel$/))) { requireScope(ctx, "intel.research"); return send(res, 200, await rp.cancelResearch(ctx, mm[1], String((await readJson(req)).reason ?? "cancelled"))); }
      if (m === "POST" && p === "/v1/research-runs/cancel-children") { requireScope(ctx, "intel.research"); const b = await readJson(req); return send(res, 200, await rp.cancelChildren(ctx, String(b.parent_run_id ?? ""), String(b.reason ?? "parent_cancelled"))); }
      if (m === "POST" && p === "/v1/evidence/compare") { requireScope(ctx, "intel.documents.read"); return send(res, 200, await rp.compareEvidence(ctx, await readJson(req))); }
      if (m === "GET" && p === "/v1/sources/health") { requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.listSourcesHealth(ctx)); }
      if (m === "PATCH" && (mm = p.match(/^\/v1\/sources\/([\w-]+)$/))) { requireScope(ctx, "intel.sources.write"); return send(res, 200, await engine.updateSource(ctx, mm[1], await readJson(req))); }
      if (m === "GET" && (mm = p.match(/^\/v1\/documents\/([\w-]+)\/revisions$/))) { requireScope(ctx, "intel.documents.read"); return send(res, 200, await engine.listRevisions(ctx, mm[1])); }
      if (m === "GET" && p === "/v1/terms") { requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.listTerms(ctx)); }
      if (m === "POST" && p === "/v1/terms") { requireScope(ctx, "intel.sources.write"); return send(res, 201, await engine.addTermAliases(ctx, actor, await readJson(req))); }
      if (m === "POST" && p === "/v1/terms/delete") { requireScope(ctx, "intel.sources.write"); return send(res, 200, await engine.deleteTermAlias(ctx, await readJson(req))); }
      if (m === "POST" && p === "/v1/briefs/wake") {
        // Push from the platform: the model task of a parked brief window finished.
        // Completes just that schedule's due window now (idempotent with the scheduler tick).
        requireScope(ctx, "intel.reports.write");
        const key = String((await readJson(req)).key ?? "");
        const scheduleId = /^brief:([\w-]+):/.exec(key)?.[1];
        if (!scheduleId) throw new HttpError(400, "invalid brief key");
        return send(res, 200, { key, made: await rp.briefTick(5, { tenant_id: ctx.tenant_id, schedule_id: scheduleId }) });
      }
      if (m === "GET" && p === "/v1/brief-schedules") { requireScope(ctx, "intel.sources.read"); return send(res, 200, await rp.listBriefSchedules(ctx)); }
      if (m === "POST" && p === "/v1/brief-schedules/preview") { requireScope(ctx, "intel.sources.read"); return send(res, 200, await rp.previewBrief(ctx, await readJson(req))); }
      if (m === "POST" && p === "/v1/brief-schedules") {
        requireScope(ctx, "intel.schedules.write");
        const b = await readJson(req);
        return send(res, 201, await rp.applyBrief(ctx, actor, ctx.policy_version, { ...b, idempotency_key: idem() || String(b.idempotency_key ?? "") }));
      }
      if (m === "POST" && (mm = p.match(/^\/v1\/sources\/([\w-]+)\/revoke$/))) { requireScope(ctx, "intel.sources.write"); return send(res, 200, await engine.revokeSource(ctx, mm[1], String((await readJson(req)).reason ?? "revoked"))); }
      if (m === "GET" && p === "/v1/connector-samples") { requireScope(ctx, "intel.sources.read"); return send(res, 200, await engine.listConnectorSamples(ctx)); }
      if (m === "POST" && p === "/v1/documents/extract") { requireScope(ctx, "intel.collect"); return send(res, 200, await engine.extractDocument(ctx, await readJson(req))); }
      if (m === "POST" && p === "/v1/documents/ocr") { requireScope(ctx, "intel.collect"); return send(res, 200, await engine.ocrDocument(ctx, await readJson(req))); }
      if (m === "POST" && p === "/v1/documents/asr") { requireScope(ctx, "intel.collect"); return send(res, 200, await engine.asrDocument(ctx, await readJson(req))); }
      if (m === "POST" && p === "/v1/documents/transcript") { requireScope(ctx, "intel.collect"); return send(res, 200, await engine.transcribeDocument(ctx, await readJson(req))); }
      return send(res, 404, null, "not found");
    }
  }
}

export const createApiServer = (engine: Engine, cfg: ServerConfig) => createServer(handler(engine, cfg));

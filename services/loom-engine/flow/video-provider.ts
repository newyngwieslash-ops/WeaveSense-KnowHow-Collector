import { sign } from "./auth.ts";
import { createHash } from "node:crypto";
import { assertVideoObject, videoError, type VideoManifest, type VideoObject, type VideoScope } from "./video-contract.ts";

export type ProviderResult = { task_id: string; state: "pending" | "completed" | "failed" | "reconciliation_required"; manifest?: VideoManifest; error?: { code: string; retry_after?: number }; usage?: Record<string, number>; artifacts?: VideoObject[]; next_artifact_cursor?: string | null };
export type DiscoveryPage = { items: any[]; next_cursor: unknown; complete: boolean; reached_boundary?: boolean; watermark?: unknown; mode?: "live" | "fixture" };
const INPUT_REJECTION_CODES = new Set(["INPUT_HASH_MISMATCH", "INCOMPLETE_ARTIFACT", "NO_SUBTITLES", "INVALID_SUBTITLES", "INVALID_SUBTITLE_TIME", "SUBTITLE_LANGUAGE_MISMATCH"]);
export interface VideoProvider {
  instance: string;
  discover(source: any, checkpoint: unknown, deadline: number): Promise<DiscoveryPage>;
  submit(job: any, stage: any, intentKey: string, profile: any, inputManifest?: VideoManifest): Promise<ProviderResult>;
  poll(job: any, stage: any, taskId: string): Promise<ProviderResult>;
  reconcile?(job: any, stage: any, intentKey: string): Promise<ProviderResult | null>;
  cancel(job: any, taskId: string): Promise<"confirmed" | "unsupported" | "unknown">;
  retry?(job: any, stage: any, taskId: string): Promise<ProviderResult>;
  deleteObject?(scope: VideoScope, jobId: string, key: string, sha256: string): Promise<{ deleted: boolean; sha256: string }>;
  eraseJob?(scope: VideoScope, jobId: string): Promise<{ erased: boolean; video_job_id: string }>;
  artifactPage?(job: any, taskId: string, cursor: string): Promise<{ artifacts: VideoObject[]; next_artifact_cursor: string | null }>;
  uploadInput?(job: any, descriptor: { sha256: string; bytes: number; content_type: string; input_kind: string }, body: AsyncIterable<Uint8Array>): Promise<VideoObject>;
  inputReceipt?(job: any, sha256: string): Promise<VideoObject | null>;
  inventoryPage?(job: any, cursor?: string): Promise<{ artifacts: VideoObject[]; next_artifact_cursor: string | null }>;
  cleanupTemporary?(job: any, before: number): Promise<{ complete: boolean; deleted_temporary_ids: string[]; skipped_active_ids: string[] }>;
  openObject?(scope: VideoScope, jobId: string, key: string, range?: string): Promise<Response>;
  readObject(scope: VideoScope, jobId: string, key: string, maxBytes: number): Promise<Uint8Array>;
  verifyObject?(scope: VideoScope, jobId: string, key: string, maxBytes: number): Promise<{ bytes: number; sha256: string; content_type?: string }>;
}

/** Deployment-fixed transport, separate from public video URL resolution. Redirects never carry credentials. */
export class HTTPVideoProvider implements VideoProvider {
  instance: string;
  readonly serviceToken: string;
  readonly signingKey: string;
  constructor(privateURL: string, serviceToken: string, signingKey: string) {
    this.serviceToken = serviceToken; this.signingKey = signingKey;
    const u = new URL(privateURL);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("invalid VIDEO_WORKER_URL");
    this.instance = u.toString().replace(/\/$/, "");
  }
  private async request(scope: VideoScope, jobId: string | undefined, action: string, path: string, body?: unknown, stage?: any, timeoutMs = 20_000) {
    const token = sign(this.signingKey, { iss: "loom-engine", aud: "video-knowledge", tenant_id: scope.tenant_id, workspace_id: scope.workspace_id,
      actor: { type: "service_principal", id: "loom-engine" }, job_id: jobId, scopes: [`video.${action}`], policy_version: "policy_v1",
      ...(stage ? { stage_attempt: Number(stage.attempt), fencing_token: Number(stage.fencing_token) } : {}) });
    const r = await fetch(this.instance + path, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${this.serviceToken}`, "x-flow-execution-context": token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) {
      const code = r.status === 401 || r.status === 403 ? "AUTH_REQUIRED" : r.status === 429 ? "RATE_LIMITED" : r.status === 404 ? "SOURCE_UNAVAILABLE" : r.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_CONTRACT_CHANGED";
      throw Object.assign(videoError(r.status, code), { retry_after: Number(r.headers.get("retry-after")) || undefined });
    }
    return r;
  }
  private async json(r: Response) {
    const text = Buffer.from(await this.bounded(r, 2_000_000)).toString("utf8");
    try { const v = JSON.parse(text); return v.data ?? v; } catch { throw videoError(502, "PROVIDER_CONTRACT_CHANGED"); }
  }
  async discover(source: any, checkpoint: unknown, deadline: number) {
    return this.json(await this.request(source, undefined, "discover", "/v1/discover", { tenant_id: source.tenant_id, workspace_id: source.workspace_id, source_id: source.id, platform: source.kind, source: source.config, url: source.url, cursor: checkpoint, limit: 50, deadline_ms: deadline }));
  }
  async submit(job: any, stage: any, intent_key: string, profile: any, input_manifest?: VideoManifest) {
    // Embedding is a host-billed, host-verified indexing stage, never a worker capability assertion.
    const workerProfile = { ...profile.config, required_capabilities: profile.config.required_capabilities.filter((x: string) => x !== "embedding"), optional_capabilities: (profile.config.optional_capabilities ?? []).filter((x: string) => x !== "embedding") };
    const asset = { ...job.input, required_capabilities: job.input.required_capabilities.filter((x: string) => x !== "embedding") };
    return this.json(await this.request(job, job.id, "execute", "/v1/jobs", { tenant_id: job.tenant_id, workspace_id: job.workspace_id, video_job_id: job.id,
      stage: stage.stage, stage_attempt: stage.attempt, fencing_token: Number(stage.fencing_token), intent_key, input_manifest, input_manifest_sha256: job.input_manifest_sha256, profile: workerProfile, asset }, stage));
  }
  async poll(job: any, stage: any, taskId: string) {
    return this.json(await this.request(job, job.id, "read", `/v1/jobs/${encodeURIComponent(taskId)}?video_job_id=${encodeURIComponent(job.id)}&stage_attempt=${stage.attempt}&fencing_token=${stage.fencing_token}`, undefined, stage));
  }
  async reconcile(job: any, stage: any, intentKey: string) {
    try { return await this.json(await this.request(job, job.id, "read", `/v1/jobs/reconcile?intent_key=${encodeURIComponent(intentKey)}&video_job_id=${encodeURIComponent(job.id)}&stage_attempt=${stage.attempt}&fencing_token=${stage.fencing_token}`, undefined, stage)); }
    catch (e: any) { if (e.status === 404) return null; throw e; }
  }
  async cancel(job: any, taskId: string) {
    try { const v = await this.json(await this.request(job, job.id, "cancel", `/v1/jobs/${encodeURIComponent(taskId)}/cancel`, { video_job_id: job.id })); return ["confirmed", "unsupported"].includes(v.status) ? v.status : "unknown"; }
    catch { return "unknown" as const; }
  }
  async retry(job: any, stage: any, taskId: string) {
    return this.json(await this.request(job, job.id, "execute", `/v1/jobs/${encodeURIComponent(taskId)}/retry`, { video_job_id: job.id, stage_attempt: stage.attempt, fencing_token: Number(stage.fencing_token) }, stage));
  }
  async deleteObject(scope: VideoScope, jobId: string, key: string, sha256: string) {
    assertVideoObject(scope, key, jobId);
    return this.json(await this.request(scope, jobId, "delete", "/v1/objects/delete", { video_job_id: jobId, object_key: key, sha256 }));
  }
  async eraseJob(scope: VideoScope, jobId: string) {
    return this.json(await this.request(scope, jobId, "delete", "/v1/jobs/erase", { video_job_id: jobId }));
  }
  async artifactPage(job: any, taskId: string, cursor: string) {
    return this.json(await this.request(job, job.id, "read", `/v1/jobs/${encodeURIComponent(taskId)}/artifacts?video_job_id=${encodeURIComponent(job.id)}&cursor=${encodeURIComponent(cursor)}`));
  }
  async uploadInput(job: any, descriptor: { sha256: string; bytes: number; content_type: string; input_kind: string }, body: AsyncIterable<Uint8Array>) {
    const token = sign(this.signingKey, { iss: "loom-engine", aud: "video-knowledge", tenant_id: job.tenant_id, workspace_id: job.workspace_id,
      actor: { type: "service_principal", id: "loom-engine" }, job_id: job.id, scopes: ["video.upload"], policy_version: job.policy_version });
    const query = new URLSearchParams({ video_job_id: job.id, sha256: descriptor.sha256, bytes: String(descriptor.bytes), content_type: descriptor.content_type, input_kind: descriptor.input_kind });
    const response = await fetch(`${this.instance}/v1/inputs?${query}`, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${this.serviceToken}`, "x-flow-execution-context": token, "content-type": descriptor.content_type, "content-length": String(descriptor.bytes) }, body: body as any, duplex: "half" } as any);
    if (!response.ok) {
      let reason = response.status === 413 ? "LIMIT_EXCEEDED" : "INPUT_UPLOAD_FAILED";
      const reader = response.body?.getReader();
      try {
        // Only the worker's bounded, allowlisted validation code may cross the
        // public API boundary. Never relay its body, messages or arbitrary codes.
        if (response.status === 422 && reader && Number(response.headers.get("content-length")) <= 4096) {
          const parts: Uint8Array[] = []; let size = 0;
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > 4096) throw new Error("upload error envelope too large");
            parts.push(value);
          }
          const code = JSON.parse(Buffer.concat(parts, size).toString("utf8"))?.error?.code;
          if (typeof code === "string" && INPUT_REJECTION_CODES.has(code)) reason = code;
        }
      } catch { /* Malformed/unavailable details retain the generic failure. */ }
      finally { try { await reader?.cancel(); } catch { /* Preserve the upload failure. */ } reader?.releaseLock(); }
      throw videoError(response.status, reason);
    }
    return this.json(response);
  }
  async inputReceipt(job: any, sha256: string) {
    try { return await this.json(await this.request(job, job.id, "read", `/v1/inputs?video_job_id=${encodeURIComponent(job.id)}&sha256=${encodeURIComponent(sha256)}`)); }
    catch (error: any) { if (error.status === 404) return null; throw error; }
  }
  async inventoryPage(job: any, cursor = "0") {
    return this.json(await this.request(job, job.id, "read", `/v1/jobs/inventory?video_job_id=${encodeURIComponent(job.id)}&cursor=${encodeURIComponent(cursor)}`));
  }
  async cleanupTemporary(job: any, before: number) {
    return this.json(await this.request(job, job.id, "delete", "/v1/jobs/cleanup", { video_job_id: job.id, temp_before: before }));
  }
  async openObject(scope: VideoScope, jobId: string, key: string, range?: string) {
    assertVideoObject(scope, key, jobId);
    const token = sign(this.signingKey, { iss: "loom-engine", aud: "video-knowledge", tenant_id: scope.tenant_id, workspace_id: scope.workspace_id,
      actor: { type: "service_principal", id: "loom-engine" }, job_id: jobId, scopes: ["video.read"], policy_version: "policy_v1" });
    const response = await fetch(`${this.instance}/v1/objects?key=${encodeURIComponent(key)}&video_job_id=${encodeURIComponent(jobId)}`, { redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${this.serviceToken}`, "x-flow-execution-context": token, ...(range ? { range } : {}) } });
    if (!response.ok) { await response.body?.cancel(); throw videoError(response.status, response.status === 404 ? "OBJECT_NOT_FOUND" : response.status === 416 ? "INVALID_RANGE" : "MEDIA_UNAVAILABLE"); }
    return response;
  }
  async readObject(scope: VideoScope, jobId: string, key: string, maxBytes: number) {
    assertVideoObject(scope, key, jobId);
    const r = await this.request(scope, jobId, "read", `/v1/objects?key=${encodeURIComponent(key)}&video_job_id=${encodeURIComponent(jobId)}`, undefined, undefined, 120_000);
    return this.bounded(r, maxBytes);
  }
  private async bounded(r: Response, maxBytes: number) {
    const length = Number(r.headers.get("content-length"));
    if (length > maxBytes) throw videoError(413, "LIMIT_EXCEEDED");
    const reader = r.body?.getReader();
    if (!reader) throw videoError(502, "INCOMPLETE_ARTIFACT");
    const parts: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) throw videoError(413, "LIMIT_EXCEEDED"); parts.push(value); }
    } catch (e) { await reader.cancel(); throw e; }
    return Buffer.concat(parts, size);
  }
  async verifyObject(scope: VideoScope, jobId: string, key: string, maxBytes: number) {
    assertVideoObject(scope, key, jobId);
    const r = await this.request(scope, jobId, "read", `/v1/objects?key=${encodeURIComponent(key)}&video_job_id=${encodeURIComponent(jobId)}`, undefined, undefined, 120_000);
    if (Number(r.headers.get("content-length")) > maxBytes) throw videoError(413, "LIMIT_EXCEEDED");
    const reader = r.body?.getReader(); if (!reader) throw videoError(502, "INCOMPLETE_ARTIFACT");
    const hash = createHash("sha256"); let bytes = 0, head = Buffer.alloc(0);
    try { while (true) { const part = await reader.read(); if (part.done) break; if (head.length < 16) head = Buffer.concat([head, part.value.slice(0, 16 - head.length)]); bytes += part.value.byteLength; if (bytes > maxBytes) throw videoError(413, "LIMIT_EXCEEDED"); hash.update(part.value); } }
    catch (e) { await reader.cancel(); throw e; }
    const content_type = head.subarray(4, 8).toString() === "ftyp" ? "video/mp4" : head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WAVE" ? "audio/wav"
      : head[0] === 0x89 && head.subarray(1, 4).toString() === "PNG" ? "image/png" : head[0] === 0xff && head[1] === 0xd8 ? "image/jpeg"
        : head.subarray(0, 3).toString() === "ID3" || head[0] === 0xff && (head[1] & 0xe0) === 0xe0 ? "audio/mpeg" : "application/octet-stream";
    return { bytes, sha256: hash.digest("hex"), content_type };
  }
}
export function videoProviderFromEnv(): VideoProvider | undefined {
  if (!process.env.VIDEO_WORKER_URL) return undefined;
  if (!process.env.VIDEO_SERVICE_TOKEN || !process.env.FLOW_INTERNAL_JWT_SIGNING_KEY) throw new Error("video worker service credentials missing");
  return new HTTPVideoProvider(process.env.VIDEO_WORKER_URL, process.env.VIDEO_SERVICE_TOKEN, process.env.FLOW_INTERNAL_JWT_SIGNING_KEY);
}

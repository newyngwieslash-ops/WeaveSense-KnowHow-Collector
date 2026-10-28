import type { Engine } from "./engine.ts";
import type { Q } from "./db.ts";
import { affected } from "./db.ts";
import { assertVideoObject, canonicalHash, canonicalTranscript, isVideoKind, newVideoId, normalizeVideoURL, sha, TERMINAL_VIDEO_STATES, videoError, videoEvidenceTime, videoTextPreview,
  type VideoManifest, type VideoScope, type VideoSegment } from "./video-contract.ts";
import { videoProviderFromEnv, type VideoProvider, type ProviderResult, type DiscoveryPage } from "./video-provider.ts";
import { enqueueVideoKnowledgeReady } from "./video-knowledge-extractor.ts";
import { enqueueVideoEmbedding, loadVideoEmbedding, commitVideoEmbeddings, retryVideoEmbedding, VideoEmbeddingService } from "./video-embedding.ts";
import { assertVideoRetentionJournal } from "./video-journal.ts";
import { createHash } from "node:crypto";
import { validateVisualPart } from "./video-visual.ts";
import { normalizeVideoResources, admitVideoResources, settleVideoResources, releaseUnsubmittedVideoResources } from "./video-resources.ts";
import { normalizeVideoRetentionConfig, registerVideoObjectRetention, stampVideoTextRetention, expireVideoObjects } from "./video-retention-policy.ts";

const scopeParams = (s: VideoScope) => [s.tenant_id, s.workspace_id];
const actor = (s: VideoScope) => s.actor ? `${s.actor.type}:${s.actor.id}` : "";
const json = (v: unknown) => JSON.stringify(v);
const finiteInt = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const capabilities = ["transcript", "vision", "ocr", "vlm", "summary", "embedding"];
function processingMode(value: unknown) {
  const mode = value === "subtitle_first" ? "subtitles_first" : value === "multimodal" ? "full_video" : value ?? "subtitles_first";
  if (!["subtitles_first", "audio", "full_video", "visual_required"].includes(String(mode))) throw videoError(400, "INVALID_PROCESSING_MODE");
  return String(mode);
}

/** Persistent Loom coordinator. HTTP/MCP/schedules all use these same transactions and fingerprints. */
export class VideoCoordinator {
  enabled = process.env.FLOW_VIDEO_ENABLED === "true";
  provider?: VideoProvider;
  providerConfigurationError?: string;
  budgetStatus?: (job: any) => Promise<{ reservation_id: string; status: string; consumed_micro: number; allocated_micro: number; remaining_micro: number; open_children: number; unknown_children: number }>;
  readonly engine: Engine;
  constructor(engine: Engine) {
    this.engine = engine;
    // Cleanup/read transport remains available on rollback; feature flags still gate all new work.
    try { this.provider = videoProviderFromEnv(); }
    catch { this.providerConfigurationError = "VIDEO_WORKER_CONFIGURATION_INVALID"; }
  }
  get db() { return this.engine.db; }
  get now() { return this.engine.now(); }
  private enabledFor(s: VideoScope) {
    const allowed = (process.env.FLOW_VIDEO_WORKSPACES ?? "").split(",").map(x => x.trim()).filter(Boolean);
    if (!this.enabled || (allowed.length && !allowed.includes(s.workspace_id))) throw videoError(503, "VIDEO_DISABLED");
  }
  async profile(s: VideoScope, id: string, version: number, q: Q = this.db) {
    const p = (await q.query(`SELECT * FROM flow_video_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND version=$4`, [...scopeParams(s), id, version])).rows[0];
    if (!p) throw videoError(404, "PROFILE_NOT_FOUND");
    return p;
  }
  async listProfiles(s: VideoScope, id?: string, cursor?: string, limit = 100) {
    const [afterId, afterVersion] = cursor?.split(":") ?? [];
    if (!finiteInt(limit, 1, 100) || (cursor && (!/^[A-Za-z0-9_-]{1,80}$/.test(afterId) || !finiteInt(Number(afterVersion), 1, 1_000_000)))) throw videoError(400, "INVALID_PAGINATION");
    const rows = (await this.db.query(`SELECT * FROM flow_video_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::text IS NULL OR id=$3)
      AND ($4::text IS NULL OR id>$4 OR (id=$4 AND version<$5)) ORDER BY id,version DESC LIMIT $6`, [...scopeParams(s), id ?? null, afterId ?? null, Number(afterVersion) || 0, limit + 1])).rows;
    return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? `${rows[limit - 1].id}:${rows[limit - 1].version}` : null };
  }
  async saveProfile(s: VideoScope, input: any) {
    this.enabledFor(s);
    if (typeof input.name !== "string" || !input.name.trim() || !input.config || typeof input.config !== "object" || Array.isArray(input.config)) throw videoError(400, "INVALID_PROFILE");
    const config = structuredClone(input.config);
    config.processing_mode = processingMode(config.processing_mode);
    config.required_capabilities ??= ["transcript"];
    config.optional_capabilities ??= [];
    if (!Array.isArray(config.required_capabilities) || !config.required_capabilities.length || config.required_capabilities.some((x: string) => !capabilities.includes(x))) throw videoError(400, "INVALID_CAPABILITIES");
    if (!Array.isArray(config.optional_capabilities) || config.optional_capabilities.some((x: string) => !capabilities.includes(x))) throw videoError(400, "INVALID_CAPABILITIES");
    config.max_video_bytes ??= 2_000_000_000; config.max_duration_ms ??= 14_400_000; config.max_discovery_pages ??= 5; config.budget_micro ??= 0;
    config.max_transcript_bytes ??= 64_000_000;
    config.max_daily_jobs ??= 1000;
    normalizeVideoResources(config);
    normalizeVideoRetentionConfig(config);
    if (!finiteInt(config.max_daily_jobs, 1, 10000)) throw videoError(400, "INVALID_PROFILE_LIMIT");
    config.max_frames ??= 120; config.frame_interval_ms ??= 10000; config.chunk_ms ??= 60000;
    if (!finiteInt(config.max_frames, 1, 1000) || !finiteInt(config.frame_interval_ms, 1000, 60000) || !finiteInt(config.chunk_ms, 1000, 300000)) throw videoError(400, "INVALID_PROFILE_LIMIT");
    config.reconcile_after_seconds ??= 604800; config.max_reconcile_items ??= 3;
    if (!finiteInt(config.reconcile_after_seconds, 3600, 2592000) || !finiteInt(config.max_reconcile_items, 0, 20)) throw videoError(400, "INVALID_PROFILE_LIMIT");
    for (const [key, max] of [["max_video_bytes", 10_000_000_000], ["max_duration_ms", 86_400_000], ["max_discovery_pages", 100], ["budget_micro", Number.MAX_SAFE_INTEGER]] as const)
      if (!finiteInt(config[key], key === "budget_micro" ? 0 : 1, max)) throw videoError(400, "INVALID_PROFILE_LIMIT");
    if (!finiteInt(config.max_transcript_bytes, 1, 256_000_000)) throw videoError(400, "INVALID_PROFILE_LIMIT");
    if (/cookie|api.?key|password|access.?token/i.test(json(config))) throw videoError(400, "PROFILE_SECRET_FORBIDDEN");
    const id = input.id ?? newVideoId("vp_");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw videoError(400, "INVALID_PROFILE_ID");
    return this.db.tx(async q => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`profile:${s.tenant_id}:${s.workspace_id}:${id}`]);
      const current = (await q.query(`SELECT max(version)::int AS version FROM flow_video_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), id])).rows[0]?.version ?? 0;
      if (Number(input.expected_version ?? 0) !== current) throw videoError(409, "VERSION_CONFLICT");
      return (await q.query(`INSERT INTO flow_video_profiles(id,tenant_id,workspace_id,version,name,config,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, ...scopeParams(s), current + 1, input.name.trim(), json(config), canonicalHash({ name: input.name.trim(), config }), actor(s)])).rows[0];
    });
  }
  async validateSource(s: VideoScope, input: any, q: Q = this.db) {
    this.enabledFor(s);
    if (q === this.db) await assertVideoRetentionJournal(this.engine, s);
    const c = input.config ?? {};
    if (!["video", "account"].includes(c.source_type) || !c.profile_id || !finiteInt(c.profile_version, 1, 1_000_000) || !String(c.usage_basis ?? "").trim()
      || !Array.isArray(c.allowed_uses) || !c.allowed_uses.includes("knowledge")) throw videoError(400, "INVALID_VIDEO_SOURCE");
    if (c.authorization_expires_at && !(Date.parse(c.authorization_expires_at) > this.now.getTime())) throw videoError(403, "AUTH_REQUIRED");
    if (c.credential_ref && !/^[A-Za-z0-9_.:/-]{1,180}$/.test(c.credential_ref)) throw videoError(400, "INVALID_CREDENTIAL_REF");
    c.max_items ??= 200;
    if (!finiteInt(c.max_items, 1, 200)) throw videoError(400, "INVALID_SOURCE_LIMIT");
    if (c.source_type === "account") c.since ??= new Date(this.now.getTime() - 7 * 86400_000).toISOString();
    if (c.since != null && !Number.isFinite(Date.parse(c.since))) throw videoError(400, "INVALID_SOURCE_WINDOW");
    await this.profile(s, c.profile_id, c.profile_version, q);
    if (c.processing_mode !== undefined) c.processing_mode = processingMode(c.processing_mode);
    const allowed = ["source_type", "profile_id", "profile_version", "native_id", "author_id", "part_id", "usage_basis", "allowed_uses", "authorization_expires_at", "credential_ref", "processing_mode", "max_items", "since"];
    const rawURL = String(input.url ?? ""), url = normalizeVideoURL(input.kind, rawURL, c.source_type);
    return { url, config: { ...Object.fromEntries(allowed.filter(k => c[k] !== undefined).map(k => [k, c[k]])), submitted_url_sha256: sha(rawURL), normalized_from_share_text: rawURL.trim() !== url } };
  }
  private async source(s: VideoScope, id: string, q: Q = this.db, requireActive = true) {
    const src = (await q.query(`SELECT * FROM flow_sources WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3${q === this.db ? "" : " FOR SHARE"}`, [...scopeParams(s), id])).rows[0];
    if (!src || !isVideoKind(src.kind)) throw videoError(404, "SOURCE_NOT_FOUND");
    if (src.status === "revoked" || (requireActive && src.status !== "active") || (src.config.authorization_expires_at && Date.parse(src.config.authorization_expires_at) <= this.now.getTime())) throw videoError(403, "AUTH_REQUIRED");
    return src;
  }
  private async authorize(job: any, scope = job.input?.correction_parent ? "intel.knowledge.review" : "intel.video.process") {
    await this.source(job, job.source_id, this.db, false);
    const asset = (await this.db.query(`SELECT revoked_at FROM flow_video_assets WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(job), job.asset_id])).rows[0];
    if (!asset || asset.revoked_at) throw videoError(403, "AUTH_REQUIRED");
    if (this.engine.authorize && !(await this.engine.authorize(job, scope))) throw videoError(403, "AUTH_REQUIRED");
  }
  async start(s: VideoScope, key: string, input: any) {
    this.enabledFor(s);
    await assertVideoRetentionJournal(this.engine, s);
    if (!key || key.length > 200) throw videoError(400, "IDEMPOTENCY_KEY_REQUIRED");
    return this.db.tx(q => this.startTx(q, s, key, input));
  }
  private async startTx(q: Q, s: VideoScope, key: string, input: any, operationId?: string, internal?: { reacquire?: boolean; repair_job_id?: string; repair_objects?: any[] }) {
    const src = await this.source(s, input.source_id, q);
    const profile_id = input.profile_id ?? src.config.profile_id, profile_version = input.profile_version ?? src.config.profile_version;
    const p = await this.profile(s, profile_id, profile_version, q);
    const native_id = input.native_id ?? src.config.native_id;
    if (typeof native_id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(native_id) || (input.part_id != null && typeof input.part_id !== "string")) throw videoError(400, "INVALID_NATIVE_ID");
    let part_id = input.part_id ?? src.config.part_id ?? "";
    if (!/^[A-Za-z0-9_-]{0,80}$/.test(part_id)) throw videoError(400, "INVALID_PART_ID");
    const required = input.required_capabilities ?? p.config.required_capabilities;
    if (!Array.isArray(required) || required.some(x => !capabilities.includes(x)) || p.config.required_capabilities.some((x: string) => !required.includes(x))) throw videoError(400, "INVALID_CAPABILITIES");
    // Embedding requires the separately configured host-billed, host-verified bridge.
    if (required.includes("embedding") && (!p.config.embedding_model_id || !finiteInt(p.config.embedding_budget_micro, 1, Number.MAX_SAFE_INTEGER))) throw videoError(503, "EMBEDDING_UNAVAILABLE");
    const mode = processingMode(src.config.processing_mode ?? p.config.processing_mode);
    if (mode === "visual_required" && !required.includes("vision")) throw videoError(400, "VISION_PROFILE_REQUIRED");
    if (mode === "audio" && required.some((x: string) => ["vision", "ocr", "vlm"].includes(x))) throw videoError(400, "AUDIO_MODE_VISUAL_CONFLICT");
    let canonicalURL = normalizeVideoURL(src.kind, input.canonical_url ?? (src.config.source_type === "account"
      ? src.kind === "bilibili" ? `https://www.bilibili.com/video/${native_id}${part_id ? `?p=${part_id}` : ""}` : `https://www.douyin.com/video/${native_id}` : src.url));
    const u = new URL(canonicalURL), urlId = u.pathname.match(/\/video\/([^/]+)/)?.[1], urlPart = u.searchParams.get("p") ?? "";
    if (urlId && urlId !== native_id || src.kind === "bilibili" && urlPart && part_id && urlPart !== part_id) throw videoError(400, "ASSET_IDENTITY_MISMATCH");
    part_id = part_id || (src.kind === "bilibili" ? urlPart : "") || "1";
    if (src.kind === "bilibili") {
      if (!/^[1-9]\d*$/.test(part_id) || !finiteInt(Number(part_id), 1, 10000)) throw videoError(400, "INVALID_PART_ID");
      u.searchParams.set("p", part_id); canonicalURL = u.toString();
    } else if (part_id !== "1") throw videoError(400, "INVALID_PART_ID");
    if (input.input_object || input.input_kind) throw videoError(400, "INPUT_REFERENCE_NOT_ALLOWED");
    let lawful_input: { input_kind: string; sha256: string; bytes: number; content_type: string } | null = null;
    if (input.lawful_input) {
      const v = input.lawful_input;
      if (!v || typeof v !== "object" || !["platform_subtitles", "media"].includes(v.input_kind) || !/^[a-f0-9]{64}$/.test(v.sha256)) throw videoError(400, "INVALID_LAWFUL_INPUT");
      const subtitles = v.input_kind === "platform_subtitles";
      if (subtitles && (mode !== "subtitles_first" || v.content_type !== "application/json") || !subtitles && !["video/mp4", "audio/wav", "audio/mpeg"].includes(v.content_type)
        || !finiteInt(v.bytes, 1, Math.min(Number(p.config.max_video_bytes), subtitles ? 8 * 1024 * 1024 : 2 * 1024 ** 3))) throw videoError(400, "INVALID_LAWFUL_INPUT");
      lawful_input = { input_kind: v.input_kind, sha256: v.sha256, bytes: v.bytes, content_type: v.content_type };
    }
    const normalized = { source_id: src.id, platform: src.kind, native_id, part_id, canonical_url: canonicalURL,
      content_version: String(input.content_version ?? "source-v1"), profile_id, profile_version, required_capabilities: [...new Set(required)].sort(),
      processor_version: input.processor_version ?? "video-v1", model_config: input.model_config ?? {}, title: String(input.title ?? src.title), published_at: input.published_at ?? null,
      credential_ref: src.config.credential_ref ?? null, usage_basis: src.config.usage_basis, allowed_uses: src.config.allowed_uses, processing_mode: mode, lawful_input,
      reacquire: internal?.reacquire === true, repair_job_id: internal?.repair_job_id ?? null, repair_objects: internal?.repair_objects ?? null };
    const requestHash = canonicalHash(normalized);
    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`video:${s.tenant_id}:${s.workspace_id}`]);
    const prior = (await q.query(`SELECT * FROM flow_video_requests WHERE tenant_id=$1 AND workspace_id=$2 AND namespace='start' AND idempotency_key=$3`, [...scopeParams(s), key])).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw videoError(409, "IDEMPOTENCY_CONFLICT");
      const j = (await q.query(`SELECT * FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), prior.video_job_id])).rows[0];
      if (operationId) await q.query(`INSERT INTO flow_video_operation_jobs(tenant_id,workspace_id,operation_id,video_job_id,source_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...scopeParams(s), operationId, j.id, src.id]);
      return { ...this.project(j), replayed: true };
    }
    const asset = (await q.query(`INSERT INTO flow_video_assets(id,tenant_id,workspace_id,platform,native_id,part_id,canonical_url,title,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,workspace_id,platform,native_id,part_id) DO UPDATE SET title=EXCLUDED.title,canonical_url=EXCLUDED.canonical_url,metadata=EXCLUDED.metadata RETURNING *`,
      [newVideoId("va_"), ...scopeParams(s), src.kind, native_id, part_id, normalized.canonical_url, normalized.title, json({ published_at: normalized.published_at })])).rows[0];
    if (asset.revoked_at) throw videoError(403, "AUTH_REQUIRED");
    await q.query(`INSERT INTO flow_video_asset_sources(tenant_id,workspace_id,asset_id,source_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [...scopeParams(s), asset.id, src.id]);
    const fingerprint = canonicalHash({ tenant_id: s.tenant_id, workspace_id: s.workspace_id, asset: asset.id, content: normalized.content_version, profile_id, profile_version,
      required: normalized.required_capabilities, processor: normalized.processor_version, model: normalized.model_config, processing_mode: normalized.processing_mode, lawful_input, reacquire: normalized.reacquire });
    let job = (await q.query(`SELECT * FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND fingerprint=$3`, [...scopeParams(s), fingerprint])).rows[0];
    const replayed = !!job;
    if (!job) {
      const today = new Date(this.now); today.setUTCHours(0, 0, 0, 0);
      const used = Number((await q.query(`SELECT count(*)::int AS n FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3`, [...scopeParams(s), today.toISOString()])).rows[0].n);
      if (used >= Number(p.config.max_daily_jobs ?? 1000)) throw videoError(429, "RESOURCE_QUOTA_EXCEEDED");
      job = (await q.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,grant_actor,policy_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [newVideoId("vj_"), operationId ?? newVideoId("op_"), ...scopeParams(s), src.id, asset.id, profile_id, profile_version, fingerprint, json(normalized), actor(s), s.policy_version ?? "policy_v1"])).rows[0];
      await q.query(`INSERT INTO flow_video_stages(tenant_id,workspace_id,video_job_id,stage,next_poll_at,state) VALUES($1,$2,$3,'input',$4,$5)`, [...scopeParams(s), job.id, this.now.toISOString(), lawful_input ? "awaiting_input" : "queued"]);
      if (lawful_input) { await q.query(`UPDATE flow_video_jobs SET stage='awaiting_input' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), job.id]); job.stage = "awaiting_input"; }
      await registerVideoObjectRetention(q, job, [], this.now);
      await this.engine.emit(q, s, job.operation_id, job.id, "video.accepted", { video_job_id: job.id, source_id: src.id });
    }
    await q.query(`INSERT INTO flow_video_requests(tenant_id,workspace_id,namespace,idempotency_key,request_hash,video_job_id) VALUES($1,$2,'start',$3,$4,$5)`, [...scopeParams(s), key, requestHash, job.id]);
    await q.query(`INSERT INTO flow_video_operation_jobs(tenant_id,workspace_id,operation_id,video_job_id,source_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...scopeParams(s), operationId ?? job.operation_id, job.id, src.id]);
    return { ...this.project(job), replayed };
  }
  project(j: any) {
    return { video_job_id: j.id, operation_id: j.operation_id, source_id: j.source_id, asset_id: j.asset_id, profile_id: j.profile_id, profile_version: j.profile_version,
      state: j.state, stage: j.stage, completion_level: j.completion_level, document_id: j.document_id, revision: j.revision, coverage: j.coverage,
      available_capabilities: j.available_capabilities, remote_cancel_status: j.remote_cancel_status, error: j.error, cleanup_error: j.cleanup_error, created_at: j.created_at, updated_at: j.updated_at,
      platform: j.input?.platform, native_id: j.input?.native_id, part_id: j.input?.part_id, title: j.input?.title, reused_from_job_id: j.reused_from_job_id,
      input_received: !!j.input?.input_object, input_upload_required: !!j.input?.lawful_input && !j.input?.input_object,
      input_provenance: j.input?.lawful_input ? "authorized_user_upload" : "platform_acquisition",
      actual_usage_micro: Number(j.actual_usage_micro ?? 0), budget_settlement: j.budget_reserving_at ? "pending" : j.budget_reservation_id ? j.budget_closed_at ? "closed" : "pending" : "not_reserved" };
  }
  async job(s: VideoScope, id: string, q: Q = this.db) {
    const j = (await q.query(`SELECT * FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), id])).rows[0];
    if (!j) throw videoError(404, "VIDEO_JOB_NOT_FOUND");
    return j;
  }
  /** The authenticated original grantee supplies bytes, never an object key or fetch URL. */
  async uploadInput(s: VideoScope, id: string, body: AsyncIterable<Uint8Array>, length: number, contentType: string) {
    this.enabledFor(s); await assertVideoRetentionJournal(this.engine, s);
    const job = await this.job(s, id), descriptor = job.input.lawful_input;
    if (s.actor?.type !== "user" || actor(s) !== job.grant_actor) throw videoError(403, "INPUT_GRANT_MISMATCH");
    if (!descriptor || length !== descriptor.bytes || contentType !== descriptor.content_type) throw videoError(409, "INPUT_DESCRIPTOR_MISMATCH");
    await this.authorize(job);
    if (TERMINAL_VIDEO_STATES.includes(job.state) || job.input.input_object) {
      if (job.input.input_object && !["cancelled", "failed"].includes(job.state)) return this.project(job);
      throw videoError(409, "INPUT_NOT_ACCEPTING");
    }
    if (job.stage !== "awaiting_input" || !this.provider?.uploadInput) throw videoError(503, "INPUT_UPLOAD_UNAVAILABLE");
    await admitVideoResources(this.engine, job, await this.profile(s, job.profile_id, job.profile_version));
    async function* checked() {
      const hash = createHash("sha256"); let bytes = 0;
      for await (const chunk of body) { bytes += chunk.byteLength; if (bytes > descriptor.bytes) throw videoError(413, "LIMIT_EXCEEDED"); hash.update(chunk); yield chunk; }
      if (bytes !== descriptor.bytes || hash.digest("hex") !== descriptor.sha256) throw videoError(422, "INPUT_HASH_MISMATCH");
    }
    const object = await this.provider.uploadInput(job, descriptor, checked());
    return this.acceptInputReceipt(s, job, object);
  }
  private async acceptInputReceipt(s: VideoScope, job: any, object: any) {
    const id = job.id, descriptor = job.input.lawful_input;
    assertVideoObject(s, object.object_key, id);
    if (object.sha256 !== descriptor.sha256 || object.bytes !== descriptor.bytes || object.content_type !== descriptor.content_type) throw videoError(422, "INPUT_RECEIPT_MISMATCH");
    await this.registerArtifacts(job, [object]);
    return this.db.tx(async q => {
      const current = (await q.query(`SELECT * FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [...scopeParams(s), id])).rows[0];
      await this.source(s, current.source_id, q, false);
      if (TERMINAL_VIDEO_STATES.includes(current.state) || !["awaiting_input", "input"].includes(current.stage)) throw videoError(409, "INPUT_NOT_ACCEPTING");
      const input = { ...current.input, input_kind: descriptor.input_kind, input_object: object };
      const updated = (await q.query(`UPDATE flow_video_jobs SET input=$4,stage='input',updated_at=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 RETURNING *`, [...scopeParams(s), id, json(input), this.now.toISOString()])).rows[0];
      await q.query(`UPDATE flow_video_stages SET state='queued',next_poll_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage='input' AND state='awaiting_input'`, [...scopeParams(s), id, this.now.toISOString()]);
      return this.project(updated);
    });
  }
  async get(s: VideoScope, id: string) {
    const j = await this.job(s, id);
    const stages = (await this.db.query(`SELECT st.stage,st.state,st.attempt,st.fencing_token,st.next_poll_at,st.error,st.heartbeat_at,
      CASE WHEN i.state IN ('prepared','submitted','accepted','resume_requested','terminal') THEN i.state WHEN i.state IS NULL THEN 'none' ELSE 'unknown' END AS submission_intent_state,
      i.external_task_id IS NOT NULL AS external_task_known,coalesce(i.external_observed_state,'unknown') AS external_observed_state,i.external_observed_at
      FROM flow_video_stages st LEFT JOIN flow_video_submission_intents i ON i.tenant_id=st.tenant_id AND i.workspace_id=st.workspace_id AND i.video_job_id=st.video_job_id AND i.stage=st.stage
      WHERE st.tenant_id=$1 AND st.workspace_id=$2 AND st.video_job_id=$3 ORDER BY st.stage`, [...scopeParams(s), id])).rows;
    return { ...this.project(j), stages, next_poll_after: TERMINAL_VIDEO_STATES.includes(j.state) ? null : 5 };
  }
  /** Last confirmed response is historical evidence, not an assertion that remote work has stopped. */
  private async observeExternal(job: any, stage: any, result: ProviderResult, q?: Q): Promise<void> {
    if (!result?.task_id || !['pending','completed','failed','reconciliation_required'].includes(result.state)) return;
    if (!q) return this.db.tx(tx => this.observeExternal(job, stage, result, tx));
    // Keep the current generation locked through the write, including against cancellation/takeover.
    const current = (await q.query(`SELECT attempt,fencing_token FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 FOR SHARE`, [...scopeParams(job), job.id, stage.stage])).rows[0];
    if (!current || Number(current.attempt) !== Number(stage.attempt) || Number(current.fencing_token) !== Number(stage.fencing_token)) throw videoError(409, "STALE_FENCE");
    const state = ["EXTERNAL_OUTCOME_UNKNOWN", "USAGE_OUTCOME_UNKNOWN"].includes(result.error?.code ?? "") ? "reconciliation_required" : result.state;
    await q.query(`UPDATE flow_video_submission_intents SET external_observed_state=$6,external_observed_at=$7
      WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 AND external_task_id=$5
      AND (external_observed_at IS NULL OR external_observed_at<=$7)`, [...scopeParams(job), job.id, stage.stage, result.task_id, state, this.now.toISOString()]);
  }
  async list(s: VideoScope, cursor?: string, limit = 50, state?: string) {
    if (!finiteInt(limit, 1, 100)) throw videoError(400, "INVALID_PAGINATION");
    const rows = (await this.db.query(`SELECT * FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::text IS NULL OR id>$3) AND ($5::text IS NULL OR state=$5) ORDER BY id LIMIT $4`, [...scopeParams(s), cursor ?? null, limit + 1, state ?? null])).rows;
    return { items: rows.slice(0, limit).map(j => this.project(j)), next_cursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  async discover(s: VideoScope, key: string, body: any, process = false) {
    this.enabledFor(s);
    const src = await this.source(s, body.source_id);
    if (!key || key.length > 200) throw videoError(400, "IDEMPOTENCY_KEY_REQUIRED");
    let continuation: any;
    if (body.discovery_handle) {
      continuation = (await this.db.query(`SELECT * FROM flow_collection_runs WHERE tenant_id=$1 AND workspace_id=$2 AND operation_id=$3 AND source_id=$4`, [...scopeParams(s), String(body.discovery_handle), body.source_id])).rows[0];
      if (!continuation || continuation.status !== "partial" || !continuation.video_discovery_options || !continuation.video_discovery_checkpoint?.partial) throw videoError(409, "DISCOVERY_NOT_RESUMABLE");
      if (continuation.video_discovery_options.discover_only !== !process) throw videoError(409, "DISCOVERY_MODE_CONFLICT");
    }
    const options = { discover_only: !process, limit: Math.min(Math.max(Number(body.limit) || 50, 1), 200), window: continuation?.video_discovery_options.window ?? body.window ?? null, deadline_ms: Math.min(Math.max(Number(body.deadline_ms) || 20_000, 1000), 20_000) };
    if (process && (!options.window || !Number.isFinite(Date.parse(options.window.from)) || !Number.isFinite(Date.parse(options.window.to)) || Date.parse(options.window.to) <= Date.parse(options.window.from)
      || Date.parse(options.window.to) - Date.parse(options.window.from) > 90 * 86400_000)) throw videoError(400, "BOUNDED_WINDOW_REQUIRED");
    const hash = canonicalHash({ source_id: body.source_id, options, discovery_handle: body.discovery_handle ?? null });
    return this.db.tx(async q => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`discover:${s.tenant_id}:${s.workspace_id}:${key}`]);
      let run = (await q.query(`SELECT * FROM flow_collection_runs WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3 AND source_id=$4`, [...scopeParams(s), `video-discover:${key}`, body.source_id])).rows[0];
      if (run && run.request_hash !== hash) throw videoError(409, "IDEMPOTENCY_CONFLICT");
      if (!run) run = (await q.query(`INSERT INTO flow_collection_runs(id,operation_id,tenant_id,workspace_id,source_id,idempotency_key,request_hash,video_discovery_options,video_source_config,video_grant_actor,video_policy_version,video_discovery_checkpoint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [newVideoId("job_"), newVideoId("op_"), ...scopeParams(s), body.source_id, `video-discover:${key}`, hash, json(options), json(continuation?.video_source_config ?? src.config), actor(s), s.policy_version ?? "policy_v1", continuation ? json(continuation.video_discovery_checkpoint) : null])).rows[0];
      return { operation_id: run.operation_id, job_ids: [run.id], state: run.status, discovery_handle: run.operation_id, downloads_started: false, processing_requested: process };
    });
  }

  async discoveryResult(s: VideoScope, operation: string, cursor = "0", limit = 50) {
    const offset = Number(cursor); if (!finiteInt(offset, 0, 1_000_000) || !finiteInt(limit, 1, 100)) throw videoError(400, "INVALID_PAGINATION");
    const run = (await this.db.query(`SELECT * FROM flow_collection_runs WHERE tenant_id=$1 AND workspace_id=$2 AND operation_id=$3`, [...scopeParams(s), operation])).rows[0];
    if (!run) throw videoError(404, "DISCOVERY_NOT_FOUND");
    await this.source(s, run.source_id, this.db, false);
    const rows = (await this.db.query(`SELECT p.payload FROM flow_video_discovery_pages p WHERE tenant_id=$1 AND workspace_id=$2 AND operation_id=$3 ORDER BY created_at,page_key`, [...scopeParams(s), operation])).rows;
    const all = rows.flatMap(r => r.payload.items).map(x => ({ native_id: x.native_id, part_id: x.part_id ?? "", canonical_url: x.canonical_url, title: x.title, published_at: x.published_at ?? null, content_version: x.content_version ?? "source-v1" }));
    return { operation_id: operation, state: run.status, items: all.slice(offset, offset + limit), next_cursor: all.length > offset + limit ? String(offset + limit) : null,
      partial: run.status === "partial", can_resume: run.status === "partial" && !!run.video_discovery_checkpoint?.partial,
      checkpoint: run.video_discovery_checkpoint ? { generation: run.video_discovery_checkpoint.generation, partial: run.video_discovery_checkpoint.partial, has_pending_cursor: run.video_discovery_checkpoint.checkpoint != null } : null,
      downloads_started: !run.video_discovery_options?.discover_only };
  }

  /** Existing collection leases/schedules drive scans; each page atomically records identities, jobs and checkpoint. */
  async executeDiscovery(run: any, src: any) {
    this.enabledFor(run);
    await assertVideoRetentionJournal(this.engine, run);
    if (!this.provider) throw videoError(503, "PROVIDER_UNAVAILABLE");
    src = { ...src, config: { ...(run.video_source_config ?? src.config), ...(run.video_discovery_options?.window ? { since: run.video_discovery_options.window.from, until: run.video_discovery_options.window.to } : {}) } };
    const profile = await this.profile(run, src.config.profile_id, src.config.profile_version);
    const grant = String(run.video_grant_actor ?? "");
    if (!grant || (this.engine.authorize && !(await this.engine.authorize({ ...run, grant_actor: grant }, run.video_discovery_options?.discover_only ? "intel.video.read" : "intel.collect")))) throw videoError(403, "AUTH_REQUIRED");
    const deadline = Date.now() + (run.video_discovery_options?.deadline_ms ?? 20_000), maxPages = Number(profile.config.max_discovery_pages), isolated = !!run.video_discovery_options;
    const maxItems = Number(run.video_discovery_options?.limit ?? src.config.max_items ?? 200);
    // A final page can commit before its acknowledgement is lost. Reconcile
    // finishes this run from its own durable pages, not a fresh platform scan.
    const progress = (await this.db.query(`SELECT count(*)::int AS pages,coalesce(sum(jsonb_array_length(payload->'items')),0)::int AS items,
      coalesce(bool_or(payload->>'complete'='true' OR payload->>'reached_boundary'='true'),false) AS done
      FROM flow_video_discovery_pages WHERE tenant_id=$1 AND workspace_id=$2 AND operation_id=$3 AND source_id=$4`, [...scopeParams(run), run.operation_id, src.id])).rows[0];
    // The requested bound belongs to the run, not each retry attempt. Overlap
    // consumes scan capacity even though it is not a newly admitted job.
    let done = progress.done, count = Number(progress.items), pages = Number(progress.pages);
    while (!done && pages < maxPages && count < maxItems && Date.now() < deadline) {
      const heartbeat = await this.engine.heartbeat(run);
      if (heartbeat !== "ok") throw videoError(409, "STALE_FENCE");
      const cp = isolated ? (await this.db.query(`SELECT video_discovery_checkpoint AS cp FROM flow_collection_runs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(run), run.id])).rows[0]?.cp
        : (await this.db.query(`SELECT * FROM flow_video_discovery_checkpoints WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3`, [...scopeParams(run), src.id])).rows[0];
      const buffered = cp?.checkpoint?.loom_buffered_page;
      let page = buffered ?? await this.provider.discover(src, cp?.checkpoint ?? null, deadline);
      if (!Array.isArray(page.items) || page.items.length > 1000 || typeof page.complete !== "boolean" || (page.items.length === 0 && !page.complete && page.next_cursor == null) || (!page.complete && !page.reached_boundary && page.next_cursor == null)) throw videoError(502, "PROVIDER_CONTRACT_CHANGED");
      const denied = (await this.db.query(`SELECT native_id,part_id FROM flow_video_assets WHERE tenant_id=$1 AND workspace_id=$2 AND platform=$3 AND revoked_at IS NOT NULL AND native_id=ANY($4::text[])`, [...scopeParams(run), src.kind, page.items.map((item: any) => String(item.native_id ?? ""))])).rows;
      const deniedKeys = new Set(denied.map(asset => `${asset.native_id}:${asset.part_id}`));
      page = { ...page, items: page.items.filter((item: any) => !deniedKeys.has(`${item.native_id}:${item.part_id || "1"}`)) };
      const stableTime = Date.parse(cp?.stable_watermark?.published_at ?? "");
      const since = isolated ? Date.parse(src.config.since ?? "") : Math.max(Date.parse(src.config.since ?? "") || 0, Number.isFinite(stableTime) ? stableTime - 86400_000 : 0);
      const until = Date.parse(src.config.until ?? "");
      const observedItems = page.items;
      const eligible = page.items.filter((item: any) => {
        if (item.published_at == null) return true; // Unknown date is disclosed, never used to infer a page boundary.
        const published = Date.parse(item.published_at);
        if (!Number.isFinite(published)) throw videoError(502, "PROVIDER_CONTRACT_CHANGED");
        return (!Number.isFinite(since) || published >= since) && (!Number.isFinite(until) || published <= until);
      });
      const remaining = maxItems - count;
      const selected = eligible.slice(0, remaining);
      const rest = eligible.slice(remaining);
      // A provider page larger than the requested bound is durably buffered, never silently dropped.
      page = { ...page, items: selected, ...(rest.length ? { complete: false, reached_boundary: false, next_cursor: { loom_buffered_page: { ...page, items: rest } } } : {}) };
      done = page.complete || page.reached_boundary === true;
      await this.db.tx(async q => {
        await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`discover-source:${run.tenant_id}:${run.workspace_id}:${src.id}`]);
        await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`video:${run.tenant_id}:${run.workspace_id}`]);
        const owned = (await q.query(`SELECT * FROM flow_collection_runs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [...scopeParams(run), run.id])).rows[0];
        if (!owned || owned.status !== "running" || Number(owned.fencing_token) !== Number(run.fencing_token) || new Date(owned.lease_expires_at).getTime() <= this.now.getTime()) throw videoError(409, "STALE_FENCE");
        await this.source(run, src.id, q);
        const locked = (await q.query(`SELECT native_id,part_id,revoked_at FROM flow_video_assets WHERE tenant_id=$1 AND workspace_id=$2 AND platform=$3 AND native_id=ANY($4::text[]) FOR SHARE`, [...scopeParams(run), src.kind, observedItems.map((item: any) => String(item.native_id ?? ""))])).rows;
        const revokedKeys = new Set(locked.filter(asset => asset.revoked_at).map(asset => `${asset.native_id}:${asset.part_id}`));
        const retain = (item: any) => !revokedKeys.has(`${item.native_id}:${item.part_id || "1"}`);
        page.items = page.items.filter(retain);
        if (page.next_cursor?.loom_buffered_page) page.next_cursor.loom_buffered_page.items = page.next_cursor.loom_buffered_page.items.filter(retain);
        const latest = isolated ? owned.video_discovery_checkpoint : (await q.query(`SELECT * FROM flow_video_discovery_checkpoints WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3 FOR UPDATE`, [...scopeParams(run), src.id])).rows[0];
        if ((latest?.generation ?? 0) !== (cp?.generation ?? 0)) throw videoError(409, "DISCOVERY_CHECKPOINT_CHANGED");
        const pageKey = canonicalHash({ run: isolated ? run.id : null, generation: cp?.generation ?? 0, cursor: cp?.checkpoint ?? null });
        await q.query(`INSERT INTO flow_video_discovery_pages(tenant_id,workspace_id,source_id,operation_id,page_key,payload_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7)`, [...scopeParams(run), src.id, run.operation_id, pageKey, canonicalHash(page), json(page)]);
        const colon = grant.indexOf(":");
        const ctx: VideoScope = { tenant_id: run.tenant_id, workspace_id: run.workspace_id, actor: { type: grant.slice(0, colon), id: grant.slice(colon + 1) }, policy_version: run.video_policy_version ?? "policy_v1" };
        for (const item of observedItems.filter(retain)) {
          // Bounded coverage checks update metadata for already-known assets even outside the incremental time window.
          await q.query(`UPDATE flow_video_assets a SET title=$6,metadata=$7,last_seen_at=$8 WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.platform=$3 AND a.native_id=$4 AND a.part_id=$5 AND a.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM flow_video_asset_sources x WHERE x.tenant_id=a.tenant_id AND x.workspace_id=a.workspace_id AND x.asset_id=a.id AND x.source_id=$9)`,
            [...scopeParams(run), src.kind, item.native_id, item.part_id || "1", String(item.title ?? ""), json(item), this.now.toISOString(), src.id]);
        }
        let newlyAdmitted = 0;
        for (const item of page.items) {
          if (run.video_discovery_options?.discover_only) {
            if (typeof item.native_id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(item.native_id)) throw videoError(502, "PROVIDER_CONTRACT_CHANGED");
            const a = (await q.query(`INSERT INTO flow_video_assets(id,tenant_id,workspace_id,platform,native_id,part_id,canonical_url,title,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
              ON CONFLICT(tenant_id,workspace_id,platform,native_id,part_id) DO UPDATE SET title=EXCLUDED.title,metadata=EXCLUDED.metadata RETURNING id`,
              [newVideoId("va_"), ...scopeParams(run), src.kind, item.native_id, item.part_id || (src.kind === "bilibili" ? new URL(item.canonical_url).searchParams.get("p") : "") || "1", normalizeVideoURL(src.kind, item.canonical_url), item.title ?? "", json(item)])).rows[0];
            await q.query(`INSERT INTO flow_video_asset_sources(tenant_id,workspace_id,asset_id,source_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [...scopeParams(run), a.id, src.id]);
            newlyAdmitted++;
          } else {
            const key = `discovery:${src.id}:${canonicalHash(item)}:${src.config.profile_version}`;
            const admission = await this.startTx(q, ctx, key, { ...item, source_id: src.id, profile_id: src.config.profile_id, profile_version: src.config.profile_version }, run.operation_id);
            if (!admission.replayed) newlyAdmitted++;
          }
        }
        const pending = cp?.pending_watermark ?? page.watermark ?? null;
        if (isolated) await q.query(`UPDATE flow_collection_runs SET video_discovery_checkpoint=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(run), run.id,
          json({ checkpoint: done ? null : page.next_cursor, pending_watermark: pending, partial: !done, generation: (cp?.generation ?? 0) + 1 })]);
        else await q.query(`INSERT INTO flow_video_discovery_checkpoints(tenant_id,workspace_id,source_id,stable_watermark,checkpoint,pending_watermark,partial,generation,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,workspace_id,source_id) DO UPDATE SET stable_watermark=EXCLUDED.stable_watermark,checkpoint=EXCLUDED.checkpoint,pending_watermark=EXCLUDED.pending_watermark,partial=EXCLUDED.partial,generation=EXCLUDED.generation,updated_at=EXCLUDED.updated_at`,
          [...scopeParams(run), src.id, json(done ? pending : cp?.stable_watermark ?? null), json(done ? null : page.next_cursor), json(done ? null : pending), !done, (cp?.generation ?? 0) + 1, this.now.toISOString()]);
        // Page identities, admitted jobs, cursor and visible count share one
        // commit; a later-page failure or lost reply cannot erase prior work.
        await q.query(`UPDATE flow_collection_runs SET items_new=items_new+$4,collector='video',provider=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
          [...scopeParams(run), run.id, newlyAdmitted, this.provider!.instance]);
      });
      count += page.items.length; pages++;
      if (count >= maxItems) break;
    }
    if (!isolated) await this.recheckKnownAssets(run, src, profile);
    return this.db.tx(async q => {
      const update = await q.query(`UPDATE flow_collection_runs SET status=$4,collector='video',provider=$5,finished_at=$6,lease_owner=NULL,partial_reason=$7
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND fencing_token=$8 AND status='running' RETURNING id,items_new`,
        [...scopeParams(run), run.id, done ? "succeeded" : "partial", this.provider!.instance, this.now.toISOString(), done ? null : "discovery_checkpoint_pending", run.fencing_token]);
      if (!affected(update)) throw videoError(409, "STALE_FENCE");
      const admitted = Number(update.rows[0].items_new);
      await this.engine.emit(q, run, run.operation_id, run.id, "collection.completed", { source_id: src.id, video_discovery: true, knowledge_ready: false, items_new: admitted, status: done ? "succeeded" : "partial", cycle_complete: false });
      await this.readyCycle(q, run, run.operation_id);
      return { status: done ? "succeeded" : "partial", items_new: admitted, checkpoint_retained: !done };
    });
  }
  private async recheckKnownAssets(run: any, src: any, profile: any) {
    const maximum = Number(profile.config.max_reconcile_items ?? 3), seconds = Number(profile.config.reconcile_after_seconds ?? 604800);
    if (!maximum) return;
    await this.db.tx(async q => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`discover-source:${run.tenant_id}:${run.workspace_id}:${src.id}`]);
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`video:${run.tenant_id}:${run.workspace_id}`]);
      const owned = (await q.query(`SELECT status,fencing_token,lease_expires_at FROM flow_collection_runs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [...scopeParams(run), run.id])).rows[0];
      if (!owned || owned.status !== "running" || Number(owned.fencing_token) !== Number(run.fencing_token) || new Date(owned.lease_expires_at).getTime() <= this.now.getTime()) throw videoError(409, "STALE_FENCE");
      await this.source(run, src.id, q);
      const assets = (await q.query(`SELECT a.* FROM flow_video_assets a JOIN flow_video_asset_sources x ON x.asset_id=a.id AND x.tenant_id=a.tenant_id AND x.workspace_id=a.workspace_id
        WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND x.source_id=$3 AND a.revoked_at IS NULL AND coalesce(a.last_reconcile_at,a.input_checked_at,a.created_at)<$4
        AND EXISTS (SELECT 1 FROM flow_video_jobs j WHERE j.tenant_id=a.tenant_id AND j.workspace_id=a.workspace_id AND j.asset_id=a.id AND j.state IN ('completed','completed_with_gaps'))
        AND NOT EXISTS (SELECT 1 FROM flow_video_jobs j WHERE j.tenant_id=a.tenant_id AND j.workspace_id=a.workspace_id AND j.asset_id=a.id AND j.state NOT IN ('completed','completed_with_gaps','failed','cancelled'))
        ORDER BY coalesce(a.last_reconcile_at,a.input_checked_at,a.created_at),a.id LIMIT $5 FOR UPDATE OF a SKIP LOCKED`, [...scopeParams(run), src.id, new Date(this.now.getTime() - seconds * 1000).toISOString(), maximum])).rows;
      const grant = String(run.video_grant_actor), colon = grant.indexOf(":");
      const ctx: VideoScope = { ...run, actor: { type: grant.slice(0, colon), id: grant.slice(colon + 1) }, policy_version: run.video_policy_version };
      for (const asset of assets) {
        const generation = Math.floor(this.now.getTime() / (seconds * 1000));
        await this.startTx(q, ctx, `recheck:${src.id}:${asset.id}:${generation}:${profile.version}`, { source_id: src.id, native_id: asset.native_id, part_id: asset.part_id,
          canonical_url: asset.canonical_url, title: asset.title, published_at: asset.metadata.published_at ?? null, profile_id: profile.id, profile_version: profile.version,
          content_version: `recheck:${generation}:${asset.id}` }, run.operation_id, { reacquire: true });
        await q.query(`UPDATE flow_video_assets SET last_reconcile_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(run), asset.id, this.now.toISOString()]);
      }
    });
  }
  async cancel(s: VideoScope, id: string, reason: string) {
    const job = await this.db.tx(async q => {
      const j = (await q.query(`SELECT * FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [...scopeParams(s), id])).rows[0];
      if (!j) throw videoError(404, "VIDEO_JOB_NOT_FOUND");
      if (["completed", "completed_with_gaps"].includes(j.state)) throw videoError(409, "ALREADY_READY_USE_WITHDRAW");
      await q.query(`UPDATE flow_video_jobs SET state='cancelled',remote_cancel_status=CASE WHEN remote_cancel_status='not_requested' THEN 'requested' ELSE remote_cancel_status END,error=$4,finished_at=$5,updated_at=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), id, json({ code: "CANCELLED", message: String(reason || "cancelled").slice(0, 200) }), this.now.toISOString()]);
      await q.query(`UPDATE flow_video_stages SET state='cancelled',fencing_token=fencing_token+1,lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND state<>'completed'`, [...scopeParams(s), id]);
      await q.query(`UPDATE flow_video_objects SET state='delete_pending' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND state='accepted'`, [...scopeParams(s), id]);
      return j;
    });
    const intents = (await this.db.query(`SELECT external_task_id FROM flow_video_submission_intents WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`, [...scopeParams(s), id])).rows;
    const responses = await Promise.all(intents.map(x => x.external_task_id ? Promise.resolve(this.provider?.cancel(job, x.external_task_id) ?? "unsupported").catch(() => "unknown") : "unknown"));
    const remote = responses.length === 0 ? "confirmed" : responses.every(x => x === "confirmed") ? "confirmed" : responses.includes("unknown") ? "unknown" : "unsupported";
    await this.db.query(`UPDATE flow_video_jobs SET remote_cancel_status=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND state='cancelled'`, [...scopeParams(s), id, remote]);
    return this.get(s, id);
  }
  async reconcile(s: VideoScope, input: { video_job_id?: string; idempotency_key?: string }) {
    let id = input.video_job_id;
    if (!id && input.idempotency_key) id = (await this.db.query(`SELECT video_job_id FROM flow_video_requests WHERE tenant_id=$1 AND workspace_id=$2 AND namespace='start' AND idempotency_key=$3`, [...scopeParams(s), input.idempotency_key])).rows[0]?.video_job_id;
    if (!id && input.idempotency_key) {
      const discovery = (await this.db.query(`SELECT operation_id,id,status FROM flow_collection_runs WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`, [...scopeParams(s), `video-discover:${input.idempotency_key}`])).rows[0];
      if (discovery) return { operation_id: discovery.operation_id, discovery_handle: discovery.operation_id, job_ids: [discovery.id], state: discovery.status };
    }
    if (!id) throw videoError(404, input.idempotency_key ? "VIDEO_SUBMISSION_NOT_FOUND" : "VIDEO_JOB_NOT_FOUND");
    const job = await this.job(s, id);
    if (job.stage === "awaiting_input" && job.input.lawful_input && this.provider?.inputReceipt) {
      await this.authorize(job);
      const receipt = await this.provider.inputReceipt(job, job.input.lawful_input.sha256);
      if (receipt) await this.acceptInputReceipt(s, job, receipt);
      return this.get(s, id);
    }
    if (job.state === "reconciliation_required" && job.stage === "embedding") {
      await this.authorize(job);
      // Persisted host batch keys recover existing tasks; this does not generate a new model request identity.
      await this.db.tx(async q => {
        await q.query(`UPDATE flow_video_jobs SET state='queued' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND state='reconciliation_required'`, [...scopeParams(s), id]);
        await q.query(`UPDATE flow_video_stages SET state='queued',next_poll_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage='embedding'`, [...scopeParams(s), id, this.now.toISOString()]);
      });
      return this.get(s, id);
    }
    if (job.state === "reconciliation_required" && this.provider?.reconcile) {
      await this.authorize(job);
      const intent = (await this.db.query(`SELECT * FROM flow_video_submission_intents WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, job.stage])).rows[0];
      const stage = (await this.db.query(`SELECT * FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, job.stage])).rows[0];
      if (intent) {
        const remote = await this.provider.reconcile(job, stage, intent.intent_key);
        if (remote?.task_id && remote.state !== "reconciliation_required" && !["EXTERNAL_OUTCOME_UNKNOWN", "USAGE_OUTCOME_UNKNOWN"].includes(remote.error?.code ?? "")) await this.db.tx(async q => {
          const current = (await q.query(`SELECT attempt,fencing_token FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 FOR UPDATE`, [...scopeParams(s), id, job.stage])).rows[0];
          if (!current || Number(current.attempt) !== Number(stage.attempt) || Number(current.fencing_token) !== Number(stage.fencing_token)) throw videoError(409, "STALE_FENCE");
          await q.query(`UPDATE flow_video_submission_intents SET external_task_id=$5,state='accepted',updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, job.stage, remote.task_id]);
          await this.observeExternal(job, stage, remote, q);
          await q.query(`UPDATE flow_video_jobs SET state='queued',error=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND state='reconciliation_required'`, [...scopeParams(s), id]);
          await q.query(`UPDATE flow_video_stages SET state='queued',next_poll_at=$5,lease_owner=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, job.stage, this.now.toISOString()]);
        });
        else if (remote?.task_id) await this.observeExternal(job, stage, remote);
      }
    }
    return this.get(s, id);
  }
  async retry(s: VideoScope, id: string) {
    const j = await this.job(s, id);
    if (!["failed", "blocked_auth", "blocked_budget", "retry_wait"].includes(j.state)) throw videoError(409, "RETRY_NOT_ALLOWED");
    if (j.budget_closing_at) throw videoError(409, "BUDGET_RECONCILIATION_REQUIRED");
    const stage = (await this.db.query(`SELECT * FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, j.stage])).rows[0];
    if (!stage) throw videoError(409, "RETRY_STAGE_MISSING");
    await this.authorize(j);
    let renewedBudget: number | undefined;
    if (j.budget_reservation_id && this.budgetStatus) {
      const receipt = await this.budgetStatus(j);
      if (receipt.reservation_id !== j.budget_reservation_id || !finiteInt(receipt.consumed_micro, 0, Number.MAX_SAFE_INTEGER)) throw videoError(502, "BUDGET_RECEIPT_INVALID");
      if (["settled", "released"].includes(receipt.status)) {
        if (receipt.open_children || receipt.unknown_children || receipt.allocated_micro) throw videoError(409, "BUDGET_RECONCILIATION_REQUIRED");
        const profile = await this.profile(s, j.profile_id, j.profile_version);
        const incurred = Number(j.budget_consumed_prior_micro) + receipt.consumed_micro;
        if (incurred >= Number(profile.config.budget_micro)) throw videoError(402, "BUDGET_EXCEEDED");
        renewedBudget = incurred;
      }
    }
    const intent = (await this.db.query(`SELECT * FROM flow_video_submission_intents WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, j.stage])).rows[0];
    let remote: ProviderResult | undefined;
    if (intent?.external_task_id && j.stage !== "embedding") {
      if (!this.provider) throw videoError(503, "PROVIDER_UNAVAILABLE");
      remote = await this.provider.poll(j, stage, intent.external_task_id);
      if (remote.state === "failed" && !this.provider.retry) throw videoError(409, "PROVIDER_RESUME_UNSUPPORTED");
    }
    const unknown = remote?.state === "reconciliation_required" || ["EXTERNAL_OUTCOME_UNKNOWN", "USAGE_OUTCOME_UNKNOWN"].includes(remote?.error?.code ?? "");
    await this.db.tx(async q => {
      // Network checks never hold database locks. Revalidate the complete local
      // generation before committing *any* retry/budget/intent mutation, so a
      // cancellation or another recovery command cannot be overwritten.
      const current = (await q.query(`SELECT * FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [...scopeParams(s), id])).rows[0];
      const live = (await q.query(`SELECT * FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 FOR UPDATE`, [...scopeParams(s), id, j.stage])).rows[0];
      if (!current || !live || current.state !== j.state || current.stage !== j.stage
        || current.budget_reservation_id !== j.budget_reservation_id || Number(current.budget_generation) !== Number(j.budget_generation)
        || Number(current.budget_consumed_prior_micro) !== Number(j.budget_consumed_prior_micro)
        || String(current.budget_closed_at) !== String(j.budget_closed_at) || String(current.budget_closing_at) !== String(j.budget_closing_at)
        || String(current.budget_reserving_at) !== String(j.budget_reserving_at)
        || live.state !== stage.state || Number(live.attempt) !== Number(stage.attempt) || Number(live.fencing_token) !== Number(stage.fencing_token)) throw videoError(409, "RETRY_STATE_CHANGED");
      if (remote) await this.observeExternal(j, stage, remote, q);
      if (unknown) {
        await q.query(`UPDATE flow_video_jobs SET state='reconciliation_required',error='{"code":"EXTERNAL_OUTCOME_UNKNOWN"}'::jsonb WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), id]);
        await q.query(`UPDATE flow_video_stages SET state='reconciliation_required' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, j.stage]);
        return;
      }
      if (renewedBudget !== undefined) await q.query(`UPDATE flow_video_jobs SET budget_consumed_prior_micro=$4,actual_usage_micro=$4,budget_generation=budget_generation+1,budget_reservation_id=NULL,budget_closed_at=NULL
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), id, renewedBudget]);
      if (remote?.state === "failed") await q.query(`UPDATE flow_video_submission_intents SET state='resume_requested',updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, j.stage]);
      if (j.stage === "embedding") await retryVideoEmbedding(q, s, j);
      await q.query(`UPDATE flow_video_jobs SET state='queued',error=NULL,finished_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), id]);
      await q.query(`UPDATE flow_video_stages SET state='queued',next_poll_at=$5,error=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, j.stage, this.now.toISOString()]);
    });
    if (unknown) throw videoError(409, "RETRY_OUTCOME_UNPROVEN");
    return this.get(s, id);
  }
  async repair(s: VideoScope, id: string, key: string) {
    this.enabledFor(s); await assertVideoRetentionJournal(this.engine, s);
    if (!key || key.length > 200) throw videoError(400, "IDEMPOTENCY_KEY_REQUIRED");
    const original = await this.job(s, id); await this.authorize(original); await this.readable(original);
    const replay = (await this.db.query(`SELECT video_job_id FROM flow_video_requests WHERE tenant_id=$1 AND workspace_id=$2 AND namespace='start' AND idempotency_key=$3`, [...scopeParams(s), `repair:${id}:${key}`])).rows[0];
    if (replay) return this.project(await this.job(s, replay.video_job_id));
    if (original.completion_level !== "knowledge_ready" || original.input.lawful_input) throw videoError(409, "REPAIR_REQUIRES_PLATFORM_READY_INPUT");
    const missing = (await this.db.query(`SELECT object_id,sha256 FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND state='missing' AND (access_expires_at IS NULL OR access_expires_at>$4) ORDER BY object_id`, [...scopeParams(s), original.reused_from_job_id ?? id, this.now.toISOString()])).rows;
    if (!missing.length) throw videoError(409, "NO_REPAIRABLE_MEDIA");
    return this.db.tx(q => this.startTx(q, s, `repair:${id}:${key}`, { ...original.input, input_object: undefined, input_kind: undefined, lawful_input: null,
      content_version: `repair:${id}:${canonicalHash(missing)}` }, newVideoId("op_"), { reacquire: true, repair_job_id: original.reused_from_job_id ?? id, repair_objects: missing }));
  }
  async claim(owner: string, leaseMs = 90_000) {
    if (!this.enabled) return null;
    return this.db.tx(async q => {
      const now = this.now.toISOString();
      // Serialize the count-and-claim admission across replicas; SKIP LOCKED alone cannot enforce shared capacity.
      await q.query(`SELECT pg_advisory_xact_lock(hashtext('video-worker-admission'))`);
      const providerLimit = Math.max(1, Math.min(64, Number(process.env.FLOW_VIDEO_PROVIDER_CONCURRENCY) || 8));
      const sourceLimit = Math.max(1, Math.min(8, Number(process.env.FLOW_VIDEO_SOURCE_CONCURRENCY) || 1));
      const allowed = (process.env.FLOW_VIDEO_WORKSPACES ?? "").split(",").map(x => x.trim()).filter(Boolean);
      const r = (await q.query(`SELECT st.*,j.operation_id,j.source_id FROM flow_video_stages st JOIN flow_video_jobs j ON j.id=st.video_job_id AND j.tenant_id=st.tenant_id AND j.workspace_id=st.workspace_id
        WHERE j.state IN ('queued','running','retry_wait') AND ((st.state IN ('queued','retry_wait') AND st.next_poll_at <= $1) OR (st.state='running' AND (st.lease_expires_at <= $1 OR (st.lease_owner=$2 AND st.next_poll_at <= $1))))
        AND ($3::text[] IS NULL OR j.workspace_id=ANY($3::text[]))
        AND ((st.lease_owner=$2 AND st.state='running' AND st.lease_expires_at>$1) OR (SELECT count(*) FROM flow_video_stages live WHERE live.tenant_id=st.tenant_id AND live.workspace_id=st.workspace_id AND live.state='running' AND live.lease_expires_at>$1)<4)
        AND ((st.lease_owner=$2 AND st.state='running' AND st.lease_expires_at>$1) OR st.stage='embedding' OR (SELECT count(*) FROM flow_video_stages live WHERE live.stage IN ('input','process') AND live.state='running' AND live.lease_expires_at>$1)<$4)
        AND ((st.lease_owner=$2 AND st.state='running' AND st.lease_expires_at>$1) OR (SELECT count(*) FROM flow_video_stages live JOIN flow_video_jobs active ON active.tenant_id=live.tenant_id AND active.workspace_id=live.workspace_id AND active.id=live.video_job_id
          WHERE active.tenant_id=j.tenant_id AND active.workspace_id=j.workspace_id AND active.source_id=j.source_id AND live.state='running' AND live.lease_expires_at>$1)<$5)
        ORDER BY st.next_poll_at,st.video_job_id LIMIT 1 FOR UPDATE OF st SKIP LOCKED`, [now, owner, allowed.length ? allowed : null, providerLimit, sourceLimit])).rows[0];
      if (!r) return null;
      const continued = r.state === "running" && r.lease_owner === owner && new Date(r.lease_expires_at).getTime() > this.now.getTime();
      const stage = (await q.query(`UPDATE flow_video_stages SET state='running',attempt=attempt+$8,fencing_token=fencing_token+$8,lease_owner=$5,lease_expires_at=$6,heartbeat_at=$7
        WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 RETURNING *`, [...scopeParams(r), r.video_job_id, r.stage, owner, new Date(this.now.getTime() + leaseMs).toISOString(), now, continued ? 0 : 1])).rows[0];
      await q.query(`UPDATE flow_video_jobs SET state='running',updated_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(r), r.video_job_id, now]);
      return stage;
    });
  }
  async heartbeat(st: any, leaseMs = 90_000) {
    const n = affected(await this.db.query(`UPDATE flow_video_stages SET heartbeat_at=$7,lease_expires_at=$8 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 AND fencing_token=$5 AND lease_owner=$6 AND state='running' AND lease_expires_at>$7`,
      [...scopeParams(st), st.video_job_id, st.stage, st.fencing_token, st.lease_owner, this.now.toISOString(), new Date(this.now.getTime() + leaseMs).toISOString()]));
    if (n !== 1) throw videoError(409, "STALE_FENCE");
  }
  private async fenced(q: Q, st: any) {
    const row = (await q.query(`SELECT st.*,j.state AS job_state FROM flow_video_stages st JOIN flow_video_jobs j ON j.id=st.video_job_id AND j.tenant_id=st.tenant_id AND j.workspace_id=st.workspace_id
      WHERE st.tenant_id=$1 AND st.workspace_id=$2 AND st.video_job_id=$3 AND st.stage=$4 FOR UPDATE OF st,j`, [...scopeParams(st), st.video_job_id, st.stage])).rows[0];
    if (!row || row.state !== "running" || row.job_state !== "running" || Number(row.fencing_token) !== Number(st.fencing_token) || row.attempt !== st.attempt
      || row.lease_owner !== st.lease_owner || new Date(row.lease_expires_at).getTime() <= this.now.getTime()) throw videoError(409, "STALE_FENCE");
    return row;
  }
  private async park(st: any, state: string, error: any, delaySeconds = 5) {
    await this.db.tx(async q => {
      await this.fenced(q, st);
      await q.query(`UPDATE flow_video_stages SET state=$5,error=$6,next_poll_at=$7,lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(st), st.video_job_id, st.stage, state, error ? json(error) : null, new Date(this.now.getTime() + delaySeconds * 1000).toISOString()]);
      await q.query(`UPDATE flow_video_jobs SET state=$4,error=$5,updated_at=$6 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(st), st.video_job_id, state, error ? json(error) : null, this.now.toISOString()]);
    });
  }
  private async pending(st: any) {
    await this.db.tx(async q => {
      await this.fenced(q, st);
      await q.query(`UPDATE flow_video_stages SET next_poll_at=$5,heartbeat_at=$6,lease_expires_at=$7 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`,
        [...scopeParams(st), st.video_job_id, st.stage, new Date(this.now.getTime() + 5000).toISOString(), this.now.toISOString(), new Date(this.now.getTime() + 90_000).toISOString()]);
    });
  }
  private providerKey(job: any) { return canonicalHash({ instance: this.provider?.instance, platform: job.input.platform, credential_ref: job.input.credential_ref ?? null }); }
  private async providerAdmission(job: any) {
    const row = (await this.db.query(`SELECT blocked_until FROM flow_video_provider_health WHERE tenant_id=$1 AND workspace_id=$2 AND provider_key=$3`, [...scopeParams(job), this.providerKey(job)])).rows[0];
    if (row?.blocked_until && new Date(row.blocked_until).getTime() > this.now.getTime()) throw Object.assign(videoError(503, "PROVIDER_CIRCUIT_OPEN"), { retry_after: Math.ceil((new Date(row.blocked_until).getTime() - this.now.getTime()) / 1000) });
  }
  private async providerOutcome(job: any, reason?: string, retryAfter = 0) {
    await this.db.tx(async q => {
      const key = this.providerKey(job);
      await q.query(`INSERT INTO flow_video_provider_health(tenant_id,workspace_id,provider_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [...scopeParams(job), key]);
      const row = (await q.query(`SELECT consecutive_failures FROM flow_video_provider_health WHERE tenant_id=$1 AND workspace_id=$2 AND provider_key=$3 FOR UPDATE`, [...scopeParams(job), key])).rows[0];
      const failures = reason ? Number(row.consecutive_failures) + 1 : 0;
      const seconds = reason && (failures >= 5 || reason === "RATE_LIMITED") ? Math.max(Math.min(retryAfter, 86400), Math.min(900, 30 * 2 ** Math.min(5, Math.max(0, failures - 5)))) : 0;
      await q.query(`UPDATE flow_video_provider_health SET consecutive_failures=$4,blocked_until=$5,last_error=$6,updated_at=$7 WHERE tenant_id=$1 AND workspace_id=$2 AND provider_key=$3`,
        [...scopeParams(job), key, failures, seconds ? new Date(this.now.getTime() + seconds * 1000).toISOString() : null, reason ?? null, this.now.toISOString()]);
    });
  }
  async workOnce(owner: string) {
    await assertVideoRetentionJournal(this.engine);
    const st = await this.claim(owner); if (!st) return null;
    const job = await this.job(st, st.video_job_id);
    let heartbeatError: unknown;
    const interval = setInterval(() => { void this.heartbeat(st).catch(e => { heartbeatError = e; }); }, 15_000);
    try {
      await this.authorize(job);
      const p = await this.profile(job, job.profile_id, job.profile_version);
      if (this.engine.budget && Number(p.config.budget_micro) <= 0) throw videoError(402, "BUDGET_EXCEEDED");
      if (this.engine.budget && Number(p.config.budget_micro) > 0 && !job.budget_reservation_id) {
        const remaining = Number(p.config.budget_micro) - Number(job.budget_consumed_prior_micro);
        if (remaining <= 0) throw videoError(402, "BUDGET_EXCEEDED");
        const priorReserveIntent = Boolean(job.budget_reserving_at);
        await this.db.tx(async q => {
          await this.fenced(q, st);
          await q.query(`UPDATE flow_video_jobs SET budget_reserving_at=coalesce(budget_reserving_at,$4) WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND budget_generation=$5 AND budget_reservation_id IS NULL`, [...scopeParams(job), job.id, this.now.toISOString(), job.budget_generation]);
        });
        let reservation: { reservation_id: string };
        const reservationKey = `video:${job.fingerprint}:budget:${job.budget_generation}`;
        try {
          const existing = priorReserveIntent && this.engine.budget.lookup ? await this.engine.budget.lookup(job, reservationKey, job.id) : null;
          reservation = existing ?? await this.engine.budget.reserve(job, reservationKey, remaining, job.id);
        }
        catch (e: any) {
          // A definitive admission rejection did not create a reservation. Any
          // other outcome keeps its durable intent for exact-key reconciliation.
          if (e.status === 402 && !priorReserveIntent) await this.db.query(`UPDATE flow_video_jobs SET budget_reserving_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND budget_generation=$4 AND budget_reservation_id IS NULL AND EXISTS (SELECT 1 FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$5 AND attempt=$6 AND fencing_token=$7)`, [...scopeParams(job), job.id, job.budget_generation, st.stage, st.attempt, st.fencing_token]);
          else if (e.status === 402) throw videoError(503, "BUDGET_RESERVATION_UNKNOWN"); // A later denial cannot negate an earlier accepted/unknown request.
          else throw videoError(503, "BUDGET_RESERVATION_UNKNOWN");
          throw e;
        }
        // A cancel/lease loss does not undo the accepted host reservation. Attach
        // its receipt to the original generation even when the job was stopped,
        // so maintenance can reconcile/close it rather than leaking a hold.
        const attached = affected(await this.db.query(`UPDATE flow_video_jobs SET budget_reservation_id=$4,budget_reserving_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND budget_generation=$5 AND (budget_reservation_id IS NULL OR budget_reservation_id=$4)`, [...scopeParams(job), job.id, reservation.reservation_id, job.budget_generation]));
        if (attached !== 1) throw videoError(409, "STALE_FENCE");
        job.budget_reservation_id = reservation.reservation_id;
        await this.db.tx(q => this.fenced(q, st));
      }
      if (st.stage === "embedding") {
        const state = await new VideoEmbeddingService(this.engine).workClaim(job, st);
        if (heartbeatError) throw heartbeatError;
        if (state === "pending") await this.pending(st);
        else await this.db.tx(async q => {
          await this.fenced(q, st); await this.source(job, job.source_id, q, false);
          const payload = await loadVideoEmbedding(q, job, job);
          await this.commitReady(q, job, job, payload.manifest, payload.manifestHash, payload.transcript);
          await q.query(`UPDATE flow_video_stages SET state='completed',lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage='embedding'`, [...scopeParams(job), job.id]);
        });
        return this.get(job, job.id);
      }
      if (st.stage === "input") await admitVideoResources(this.engine, job, p);
      if (!this.provider) throw videoError(503, "PROVIDER_UNAVAILABLE");
      await this.providerAdmission(job);
      const intentKey = `${st.stage}:${job.fingerprint}`;
      let intent = (await this.db.query(`SELECT * FROM flow_video_submission_intents WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(job), job.id, st.stage])).rows[0];
      let result: ProviderResult;
      if (intent?.external_task_id) {
        if (intent.state === "resume_requested") {
          if (!this.provider.retry) throw videoError(409, "PROVIDER_RESUME_UNSUPPORTED");
          try { result = await this.provider.retry(job, st, intent.external_task_id); }
          catch {
            await this.park(st, "reconciliation_required", { code: "EXTERNAL_OUTCOME_UNKNOWN", retryable: false }); return this.get(job, job.id);
          }
          await this.db.tx(async q => {
            await this.fenced(q, st);
            await q.query(`UPDATE flow_video_submission_intents SET state='accepted',updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(job), job.id, st.stage]);
          });
        } else result = await this.provider.poll(job, st, intent.external_task_id);
      }
      else if (intent) {
        // Intent exists without a confirmed task ID: never blindly repeat an external submission.
        await this.park(st, "reconciliation_required", { code: "EXTERNAL_OUTCOME_UNKNOWN", retryable: false });
        return this.get(job, job.id);
      } else {
        await this.db.tx(async q => {
          await this.fenced(q, st);
          await q.query(`INSERT INTO flow_video_submission_intents(tenant_id,workspace_id,video_job_id,stage,intent_key,request_hash,provider_instance,state) VALUES($1,$2,$3,$4,$5,$6,$7,'submitted')`, [...scopeParams(job), job.id, st.stage, intentKey, job.fingerprint, this.provider!.instance]);
        });
        const input = (await this.db.query(`SELECT manifest FROM flow_video_manifests WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND artifact_stage='input_ready'`, [...scopeParams(job), job.id])).rows[0]?.manifest;
        try { result = await this.provider.submit(job, st, intentKey, p, input); }
        catch (e: any) {
          if ([400, 401, 403, 413, 429].includes(e.status)) {
            // Explicit pre-admission HTTP rejection is proof no operational task was accepted.
            await this.db.tx(async q => {
              await this.fenced(q, st);
              await q.query(`DELETE FROM flow_video_submission_intents WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 AND external_task_id IS NULL`, [...scopeParams(job), job.id, st.stage]);
            });
            throw e;
          }
          await this.providerOutcome(job, "EXTERNAL_OUTCOME_UNKNOWN");
          await this.park(st, "reconciliation_required", { code: "EXTERNAL_OUTCOME_UNKNOWN", retryable: false }); return this.get(job, job.id);
        }
        if (!result.task_id) { await this.park(st, "reconciliation_required", { code: "EXTERNAL_OUTCOME_UNKNOWN", retryable: false }); return this.get(job, job.id); }
        await this.db.tx(async q => {
          await this.fenced(q, st);
          await q.query(`UPDATE flow_video_submission_intents SET external_task_id=$5,state='accepted',updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(job), job.id, st.stage, result.task_id]);
        });
      }
      await this.observeExternal(job, st, result);
      await this.recordUsage(job, st.stage, result.usage ?? (result.manifest as any)?.usage ?? {});
      await this.providerOutcome(job);
      await this.registerResultArtifacts(job, result);
      if (["completed", "failed"].includes(result.state)) await this.db.query(`UPDATE flow_video_submission_intents SET state='terminal' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(job), job.id, st.stage]);
      if (heartbeatError) throw heartbeatError;
      if (result.state === "pending") await this.pending(st);
      else if (result.state === "reconciliation_required") await this.park(st, "reconciliation_required", { code: "EXTERNAL_OUTCOME_UNKNOWN", retryable: false });
      else if (result.state === "failed") throw Object.assign(videoError(422, result.error?.code ?? "PROCESSOR_FAILED"), { retry_after: result.error?.retry_after });
      else if (result.state === "completed" && result.manifest) {
        // The accepted external task is stable across lease takeovers; only this worker's current envelope can commit it.
        await this.importManifest(job, job.id, { ...result.manifest, stage_attempt: st.attempt, fencing_token: Number(st.fencing_token) }, st);
      } else throw videoError(502, "PROVIDER_CONTRACT_CHANGED");
    } catch (e: any) {
      if (e.reason === "STALE_FENCE") return { state: "stale" };
      const reason = e.reason ?? (e.status === 402 ? "BUDGET_EXCEEDED" : "PROCESSOR_FAILED");
      if (["SOURCE_UNAVAILABLE", "CONTENT_NOT_FOUND", "REMOTE_UNAVAILABLE"].includes(reason)) await this.db.query(`UPDATE flow_video_assets SET availability='remote_unavailable',remote_checked_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND revoked_at IS NULL`, [...scopeParams(job), job.asset_id, this.now.toISOString()]);
      if (st.stage === "input") await releaseUnsubmittedVideoResources(this.engine, job);
      if (st.stage !== "embedding" && this.provider && ["PROVIDER_UNAVAILABLE", "RATE_LIMITED", "PROVIDER_CONTRACT_CHANGED"].includes(reason)) await this.providerOutcome(job, reason, Number(e.retry_after) || 0);
      const state = ["EXTERNAL_OUTCOME_UNKNOWN", "USAGE_OUTCOME_UNKNOWN"].includes(reason) ? "reconciliation_required" : reason === "AUTH_REQUIRED" ? "blocked_auth" : reason === "BUDGET_EXCEEDED" ? "blocked_budget"
        : ["PROVIDER_UNAVAILABLE", "PROVIDER_CIRCUIT_OPEN", "RATE_LIMITED", "STORAGE_ERROR", "STORAGE_PRESSURE", "DAILY_RESOURCE_LIMIT", "EMBEDDING_UNAVAILABLE"].includes(reason) && st.attempt < 8 ? "retry_wait" : "failed";
      const delay = Math.max(Number(e.retry_after) || 0, Math.min(1800, 15 * 2 ** Math.min(7, st.attempt)) + Math.floor(Math.random() * 10));
      try { await this.park(st, state, { code: reason, retryable: state === "retry_wait", stage: st.stage, retry_after: delay }, delay); } catch (f: any) { if (f.reason !== "STALE_FENCE") throw f; }
    } finally { clearInterval(interval); }
    return this.get(job, job.id);
  }

  async importManifest(s: VideoScope, id: string, m: VideoManifest, claimed?: any) {
    await assertVideoRetentionJournal(this.engine, s);
    const job = await this.job(s, id);
    await this.authorize(job);
    const stage = m?.artifact_stage === "input_ready" ? "input" : "process";
    const st = claimed ?? (await this.db.query(`SELECT * FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, stage])).rows[0];
    if (!st || !m || m.video_job_id !== id || m.schema_version !== 1 || m.stage_attempt !== st.attempt || Number(m.fencing_token) !== Number(st.fencing_token)
      || !["input_ready", "processing_complete"].includes(m.artifact_stage) || !/^[a-f0-9]{64}$/.test(m.input_hash ?? "") || !Array.isArray(m.objects) || !m.coverage || !m.processors) throw videoError(422, "INVALID_MANIFEST");
    const manifestHash = canonicalHash({ ...m, stage_attempt: 0, fencing_token: 0 });
    const prior = (await this.db.query(`SELECT sha256 FROM flow_video_manifests WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND artifact_stage=$4`, [...scopeParams(s), id, m.artifact_stage])).rows[0];
    if (prior) {
      if (prior.sha256 !== manifestHash) throw videoError(409, "MANIFEST_CONFLICT");
      if (job.state === "cancelled") throw videoError(409, "STALE_FENCE");
      return { ...this.project(job), manifest_sha256: manifestHash, replayed: true };
    }
    if (!this.provider) throw videoError(503, "STORAGE_UNAVAILABLE");
    const profile = await this.profile(s, job.profile_id, job.profile_version);
    if (stage === "input") await admitVideoResources(this.engine, job, profile);
    if (!Array.isArray(m.coverage.completed) || !Array.isArray(m.coverage.missing) || !Array.isArray(m.coverage.required)) throw videoError(422, "INVALID_COVERAGE");
    if (m.source_metadata) {
      const { metadata_sha256, ...metadata } = m.source_metadata;
      if (metadata_sha256 !== canonicalHash(metadata) || Buffer.byteLength(json(metadata)) > 30000 || metadata.resolution?.native_id !== job.input.native_id
        || metadata.title != null && (typeof metadata.title !== "string" || metadata.title.length > 2000) || metadata.description != null && (typeof metadata.description !== "string" || metadata.description.length > 20000)) throw videoError(422, "INVALID_SOURCE_METADATA");
      if (metadata.canonical_url && normalizeVideoURL(job.input.platform, metadata.canonical_url).includes("/video/") && new URL(metadata.canonical_url).pathname.split("/video/")[1]?.split("/")[0] !== job.input.native_id) throw videoError(422, "ASSET_IDENTITY_MISMATCH");
    }
    if (m.coverage.duration_ms != null && (!finiteInt(m.coverage.duration_ms, 0, Number(profile.config.max_duration_ms)))) throw videoError(413, "LIMIT_EXCEEDED");
    if (m.input_kind === "platform_subtitles" && (m.media_sha256 !== null || m.availability !== "not_acquired")) throw videoError(422, "INVALID_SUBTITLE_AVAILABILITY");
    if (m.input_kind === "media" && (!/^[a-f0-9]{64}$/.test(m.media_sha256 ?? "") || m.availability !== "available")) throw videoError(422, "INVALID_MEDIA_HASH");
    if (!["platform_subtitles", "media"].includes(m.input_kind)) throw videoError(422, "INVALID_INPUT_KIND");
    if (stage === "input" && (!m.objects.some(o => o.sha256 === m.input_hash) || (m.media_sha256 && !m.objects.some(o => o.sha256 === m.media_sha256 && /^(audio|video)\//.test(o.content_type))))) throw videoError(422, "INPUT_HASH_MISMATCH");
    const objectBytes = new Map<string, Uint8Array>();
    let total = 0, transcriptBytes = 0;
    for (const o of m.objects) {
      assertVideoObject(s, o.object_key, id);
      if (!/^[a-f0-9]{64}$/.test(o.sha256) || o.object_key.split("/")[6] !== o.sha256 || !finiteInt(o.bytes, 1, Number(profile.config.max_video_bytes)) || !["application/json", "application/x-subrip", "text/vtt", "text/plain", "video/mp4", "audio/wav", "audio/mpeg", "image/png", "image/jpeg"].includes(o.content_type)) throw videoError(422, "INVALID_ARTIFACT_OBJECT");
      total += o.bytes; if (total > Number(profile.config.max_video_bytes)) throw videoError(413, "LIMIT_EXCEEDED");
      if (o.content_type === "application/json") {
        transcriptBytes += o.bytes;
        if (transcriptBytes > Number(profile.config.max_transcript_bytes ?? 64_000_000)) throw videoError(413, "TRANSCRIPT_LIMIT_EXCEEDED");
        if (o.bytes > 10_000_000) throw videoError(413, "ARTIFACT_PART_TOO_LARGE");
        const bytes = await this.provider.readObject(s, id, o.object_key, o.bytes);
        if (bytes.byteLength !== o.bytes || sha(bytes) !== o.sha256) throw videoError(422, "ARTIFACT_HASH_MISMATCH");
        objectBytes.set(o.object_key, bytes);
      } else {
        if (!this.provider.verifyObject) throw videoError(503, "STREAMING_VERIFICATION_UNAVAILABLE");
        const verified = await this.provider.verifyObject(s, id, o.object_key, o.bytes);
        if (verified.bytes !== o.bytes || verified.sha256 !== o.sha256) throw videoError(422, "ARTIFACT_HASH_MISMATCH");
        if (/^(video|audio|image)\//.test(o.content_type) && verified.content_type !== o.content_type) throw videoError(422, "ARTIFACT_TYPE_MISMATCH");
      }
    }
    const emptySpeech = stage === "process" && ["no_audio", "no_speech_detected"].includes(String(m.coverage.transcript_status));
    if (m.frames) {
      if (stage !== "process" || !Array.isArray(m.frames) || m.frames.length > profile.config.max_frames || new Set(m.frames.map(frame => frame.frame_id)).size !== m.frames.length) throw videoError(422, "INVALID_FRAME_REFERENCE");
      for (const frame of m.frames) if (!m.objects.some(object => object.object_key === frame.object_key && object.sha256 === frame.sha256 && /^image\//.test(object.content_type))
        || frame.media_sha256 !== m.media_sha256 || !finiteInt(frame.timestamp_ms, 0, m.coverage.duration_ms ?? profile.config.max_duration_ms)) throw videoError(422, "INVALID_FRAME_REFERENCE");
    }
    if (m.visual) {
      if (stage !== "process" || m.visual.schema_version !== 1 || !Array.isArray(m.visual.parts) || !finiteInt(m.visual.record_count, 0, 100000)) throw videoError(422, "INVALID_VISUAL_PART");
      let records = 0; const ids = new Set<string>();
      for (const part of m.visual.parts) {
        const object = m.objects.find(value => value.object_key === part.object_key);
        if (!object || object.sha256 !== part.sha256 || object.bytes !== part.bytes || !objectBytes.has(part.object_key)) throw videoError(422, "INVALID_VISUAL_PART");
        for (const record of validateVisualPart(m, part, objectBytes.get(part.object_key)!)) { if (ids.has(record.record_id)) throw videoError(422, "DUPLICATE_VISUAL_RECORD"); ids.add(record.record_id); records++; }
      }
      if (records !== m.visual.record_count) throw videoError(422, "VISUAL_COUNT_MISMATCH");
    }
    if (!m.objects.length && !emptySpeech) throw videoError(422, "INCOMPLETE_ARTIFACT");
    let transcript: ReturnType<typeof canonicalTranscript> | undefined;
    if (stage === "process") {
      if (m.parent_manifest_sha256 !== job.input_manifest_sha256) throw videoError(409, "PARENT_MANIFEST_MISMATCH");
      const parent = (await this.db.query(`SELECT manifest FROM flow_video_manifests WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND artifact_stage='input_ready'`, [...scopeParams(s), id])).rows[0]?.manifest;
      if (!parent || ["input_kind", "input_hash", "media_sha256", "availability"].some(k => (m as any)[k] !== parent[k])) throw videoError(422, "INPUT_LINEAGE_MISMATCH");
      const required: string[] = job.input.required_capabilities.filter((x: string) => x !== "embedding");
      if (required.some(x => !m.coverage.completed.includes(x)) || m.coverage.missing.some(x => required.includes(x))) throw videoError(422, "INCOMPLETE_ARTIFACT");
      const duration = m.coverage.duration_ms;
      const intervals = m.coverage.intervals as any;
      if (m.input_kind === "media" && required.includes("transcript")) {
        if (!finiteInt(duration, 1, Number(profile.config.max_duration_ms)) || !Array.isArray(intervals?.processed)) throw videoError(422, "COVERAGE_UNVERIFIED");
        let end = 0;
        for (const interval of intervals.processed) {
          if (!Array.isArray(interval) || interval.length !== 2 || !finiteInt(interval[0], 0, duration!) || !finiteInt(interval[1], interval[0], duration!) || interval[0] > end) throw videoError(422, "INCOMPLETE_ARTIFACT");
          end = Math.max(end, interval[1]);
        }
        if (end < duration!) throw videoError(422, "INCOMPLETE_ARTIFACT");
      }
      if (required.some(x => ["vision", "ocr", "vlm"].includes(x))) {
        if (!m.frames?.length) throw videoError(422, "VISUAL_EVIDENCE_MISSING");
        for (const f of m.frames) {
          if (!m.objects.some(o => o.object_key === f.object_key && o.sha256 === f.sha256 && /^image\//.test(o.content_type)) || f.media_sha256 !== m.media_sha256
            || !finiteInt(f.timestamp_ms, 0, duration ?? Number(profile.config.max_duration_ms))) throw videoError(422, "INVALID_FRAME_REFERENCE");
        }
      }
      const segments: VideoSegment[] = [];
      for (const p of m.transcript?.parts ?? []) {
        if (!p || typeof p !== "object") throw videoError(422, "INVALID_TRANSCRIPT");
        const o = m.objects.find(x => x.object_key === p.object_key);
        if (!o || o.sha256 !== p.sha256 || !objectBytes.has(p.object_key)) throw videoError(422, "INCOMPLETE_TRANSCRIPT");
        let part: any;
        try { part = JSON.parse(Buffer.from(objectBytes.get(p.object_key)!).toString("utf8")); } catch { throw videoError(422, "INVALID_TRANSCRIPT"); }
        if (!part || !Array.isArray(part.segments) || part.segments.length !== p.segment_count) throw videoError(422, "TRANSCRIPT_COUNT_MISMATCH");
        if (part.segments.some((segment: any) => !segment || typeof segment !== "object")) throw videoError(422, "INVALID_SEGMENT");
        // Overlapping captions can end before an earlier, longer caption. The
        // worker declares the complete envelope, not the last item's end.
        const range = part.segments.reduce((range: { start: number | null; end: number | null }, segment: VideoSegment) => ({
          start: segment.start_ms == null ? range.start : range.start == null ? segment.start_ms : Math.min(range.start, segment.start_ms),
          end: segment.end_ms == null ? range.end : range.end == null ? segment.end_ms : Math.max(range.end, segment.end_ms),
        }), { start: null, end: null });
        if (p.start_ms !== range.start || p.end_ms !== range.end) throw videoError(422, "TRANSCRIPT_RANGE_MISMATCH");
        for (const segment of part.segments) {
          if (segment.kind && !["subtitle", "asr", "ocr"].includes(segment.kind) || (segment as any).derived === true) throw videoError(422, "DERIVED_MATERIAL_NOT_SOURCE");
          if (segment.end_ms != null && duration != null && segment.end_ms > duration) throw videoError(422, "INVALID_SEGMENT_TIME");
          if (segment.kind === "ocr" && !m.frames?.some(f => f.object_key === segment.frame_ref)) throw videoError(422, "INVALID_FRAME_REFERENCE");
        }
        segments.push(...part.segments);
      }
      segments.sort((a, b) => (a.start_ms ?? Number.MAX_SAFE_INTEGER) - (b.start_ms ?? Number.MAX_SAFE_INTEGER));
      for (const part of m.visual?.parts ?? []) validateVisualPart(m, part, objectBytes.get(part.object_key)!, segments);
      transcript = !segments.length && emptySpeech ? { body: "", text: `${job.input.title}\n\n`, spans: [] } : canonicalTranscript(job.input.title, segments);
    }
    return this.db.tx(async q => {
      await this.fenced(q, st);
      await this.source(s, job.source_id, q, false);
      for (const o of m.objects) await q.query(`INSERT INTO flow_video_objects(tenant_id,workspace_id,video_job_id,object_key,sha256,bytes,content_type) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [...scopeParams(s), id, o.object_key, o.sha256, o.bytes, o.content_type]);
      await registerVideoObjectRetention(q, job, m.objects, this.now);
      await q.query(`INSERT INTO flow_video_manifests(tenant_id,workspace_id,video_job_id,artifact_stage,sha256,manifest) VALUES($1,$2,$3,$4,$5,$6)`, [...scopeParams(s), id, m.artifact_stage, manifestHash, json(m)]);
      await q.query(`UPDATE flow_video_stages SET state='completed',lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, stage]);
      if (stage === "input") {
        await settleVideoResources(q, job, m, this.now);
        const identity = /^[a-f0-9]{64}$/.test(String(m.processors.processing_identity ?? "")) ? m.processors.processing_identity : null;
        await q.query(`UPDATE flow_video_jobs SET state='queued',stage='process',completion_level='input_ready',input_manifest_sha256=$4,updated_at=$5,verified_input_hash=$6,verified_media_sha256=$7,processing_identity=$8 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), id, manifestHash, this.now.toISOString(), m.input_hash, m.media_sha256, identity]);
        await q.query(`UPDATE flow_video_assets SET media_sha256=$4,availability=$5,input_checked_at=$6,remote_checked_at=$6 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), job.asset_id, m.media_sha256, m.availability, this.now.toISOString()]);
        if (m.source_metadata) await q.query(`UPDATE flow_video_assets SET title=coalesce($4,title),metadata=metadata||$5::jsonb WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), job.asset_id, m.source_metadata.title ?? null, json({ refreshed_source: m.source_metadata })]);
        const reused = await this.reuseReadyInput(q, s, job, m, manifestHash, profile);
        if (reused) return reused;
        await q.query(`INSERT INTO flow_video_stages(tenant_id,workspace_id,video_job_id,stage,next_poll_at) VALUES($1,$2,$3,'process',$4)`, [...scopeParams(s), id, this.now.toISOString()]);
        return { video_job_id: id, state: "queued", completion_level: "input_ready", manifest_sha256: manifestHash };
      }
      if (await enqueueVideoEmbedding(q, s, { job, manifest: m, manifestHash, transcript: transcript! })) return { video_job_id: id, state: "queued", stage: "embedding", completion_level: "input_ready", manifest_sha256: manifestHash };
      return this.commitReady(q, s, job, m, manifestHash, transcript!);
    });
  }
  /** Exact current-source bytes + trusted processor identity, never metadata similarity, allow reuse without new inference. */
  private async reuseReadyInput(q: Q, s: VideoScope, job: any, input: VideoManifest, inputManifestHash: string, profile: any) {
    const identity = input.processors.processing_identity;
    if (!/^[a-f0-9]{64}$/.test(String(identity ?? "")) || [...job.input.required_capabilities, ...(profile.config.optional_capabilities ?? [])].some(x => ["vlm", "summary", "embedding"].includes(x))) return null;
    const prior = (await q.query(`SELECT j.*,r.title AS revision_title,r.body AS revision_body,r.content_hash,d.source_id AS document_source_id FROM flow_video_jobs j
      JOIN flow_documents d ON d.id=j.document_id AND d.tenant_id=j.tenant_id AND d.workspace_id=j.workspace_id AND d.current_revision=j.revision
      JOIN flow_document_revisions r ON r.document_id=d.id AND r.tenant_id=d.tenant_id AND r.revision=j.revision
      WHERE j.tenant_id=$1 AND j.workspace_id=$2 AND j.asset_id=$3 AND j.profile_id=$4 AND j.profile_version=$5 AND j.verified_input_hash=$6
        AND j.processing_identity=$7 AND j.verified_media_sha256 IS NOT DISTINCT FROM $8::text AND j.state IN ('completed','completed_with_gaps') AND d.video_ready AND d.video_revoked_at IS NULL
        AND (d.video_text_access_expires_at IS NULL OR d.video_text_access_expires_at>now()) AND (r.video_text_access_expires_at IS NULL OR r.video_text_access_expires_at>now())
        AND j.input->'required_capabilities'=$9::jsonb AND j.input->'model_config'=$10::jsonb AND j.input->>'processing_mode'=$11
      ORDER BY j.created_at DESC LIMIT 1 FOR UPDATE OF d`, [...scopeParams(s), job.asset_id, job.profile_id, job.profile_version, input.input_hash, identity, input.media_sha256,
        json(job.input.required_capabilities), json(job.input.model_config), job.input.processing_mode])).rows[0];
    if (!prior) return null;
    await this.source(s, prior.document_source_id, q, false);
    const text = `${prior.revision_title}\n\n${prior.revision_body}`;
    const count = Number((await q.query(`SELECT count(*)::int AS n FROM flow_document_chunks WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4`, [...scopeParams(s), prior.document_id, prior.revision])).rows[0].n);
    if (sha(text) !== prior.content_hash || count !== this.engine.chunkText(text).length) throw videoError(503, "CACHED_INDEX_INVALID");
    const cached: VideoManifest = { ...input, artifact_stage: "processing_complete", parent_manifest_sha256: inputManifestHash, objects: [], transcript: { parts: [] }, coverage: prior.coverage,
      processors: { version: "loom-exact-cache-v1", processing_identity: identity, reused_from_job_id: prior.id, reused_manifest_sha256: prior.processing_manifest_sha256 } };
    const manifestHash = canonicalHash({ ...cached, stage_attempt: 0, fencing_token: 0 });
    await q.query(`INSERT INTO flow_video_manifests(tenant_id,workspace_id,video_job_id,artifact_stage,sha256,manifest) VALUES($1,$2,$3,'processing_complete',$4,$5)`, [...scopeParams(s), job.id, manifestHash, json(cached)]);
    await q.query(`UPDATE flow_video_jobs SET state=$4,stage='ready',completion_level='knowledge_ready',document_id=$5,revision=$6,processing_manifest_sha256=$7,coverage=$8,available_capabilities=$9,reused_from_job_id=$10,finished_at=$11,updated_at=$11
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), job.id, prior.state, prior.document_id, prior.revision, manifestHash, json(prior.coverage), prior.available_capabilities, prior.reused_from_job_id ?? prior.id, this.now.toISOString()]);
    await this.engine.emit(q, s, job.operation_id, job.id, "video.knowledge_ready", { video_job_id: job.id, operation_id: job.operation_id, knowledge_ready: true, cycle_complete: false, reused_from_job_id: prior.id,
      document_id: prior.document_id, revision: prior.revision, source_id: job.source_id, profile_id: job.profile_id, profile_version: job.profile_version, available_capabilities: prior.available_capabilities, coverage: prior.coverage });
    const operations = (await q.query(`SELECT operation_id FROM flow_video_operation_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`, [...scopeParams(s), job.id])).rows;
    for (const operation of operations) await this.readyCycle(q, s, operation.operation_id);
    return { ...this.project(await this.job(s, job.id, q)), manifest_sha256: manifestHash };
  }
  private async commitReady(q: Q, s: VideoScope, job: any, m: VideoManifest, manifestHash: string, transcript: ReturnType<typeof canonicalTranscript>) {
      const id = job.id;
      const profile = await this.profile(s, job.profile_id, job.profile_version, q);
      const coverage = { ...m.coverage, completed: m.coverage.completed.filter(x => x !== "embedding"),
        optional_missing: [...new Set((m.coverage.optional_missing ?? []).filter(x => x !== "embedding"))] };
      // K-017 is the sole visibility barrier, shared with trusted human corrections.
      const external = `video:${job.asset_id}:${job.profile_id}`;
      let doc = (await q.query(`SELECT * FROM flow_documents WHERE tenant_id=$1 AND workspace_id=$2 AND video_asset_id=$3 AND external_id=$4 FOR UPDATE`, [...scopeParams(s), job.asset_id, external])).rows[0];
      const correction = job.input.correction_parent;
      if (correction) {
        const current = doc && (await q.query(`SELECT content_hash FROM flow_document_revisions WHERE tenant_id=$1 AND document_id=$2 AND revision=$3`, [s.tenant_id, doc.id, doc.current_revision])).rows[0];
        if (!doc || doc.id !== correction.document_id || doc.current_revision !== correction.revision || current?.content_hash !== correction.content_hash) throw videoError(409, "VERSION_CONFLICT");
      }
      let revision = doc ? Number(doc.current_revision) + 1 : 1;
      if (!doc) doc = (await q.query(`INSERT INTO flow_documents(id,tenant_id,workspace_id,source_id,external_id,url,title,published_at,current_revision,video_asset_id,video_ready)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) RETURNING *`, [newVideoId("doc_"), ...scopeParams(s), job.source_id, external, job.input.canonical_url, job.input.title, job.input.published_at, revision, job.asset_id])).rows[0];
      const contentHash = sha(transcript!.text);
      await q.query(`INSERT INTO flow_document_revisions(document_id,revision,tenant_id,content_hash,title,body,collected_by_run,extraction,video_manifest_sha256,material_type)
        VALUES($1,$2,$3,$4,$5,$6,$7,'video',$8,$9)`, [doc.id, revision, s.tenant_id, contentHash, job.input.title, transcript!.body, id, manifestHash, m.input_kind === "platform_subtitles" ? job.input.lawful_input ? "transcript" : "platform_subtitles" : "asr_transcript"]);
      await this.engine.indexChunks(q, s, job.source_id, doc.id, revision, transcript!.text, job.input.published_at);
      const indexed = (await q.query(`SELECT count(*)::int AS n FROM flow_document_chunks WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4`, [...scopeParams(s), doc.id, revision])).rows[0]?.n;
      if (!indexed) throw videoError(503, "INDEX_UNAVAILABLE");
      const embedding = await commitVideoEmbeddings(q, s, job, doc.id, revision);
      if (embedding.completed) coverage.completed.push("embedding");
      else if (embedding.optional_missing || profile.config.optional_capabilities?.includes("embedding")) coverage.optional_missing.push("embedding");
      for (const span of transcript!.spans) {
        if (transcript!.text.slice(span.char_start, span.char_end) !== span.text) throw videoError(422, "UTF16_MAPPING_INVALID");
        const evidence = newVideoId("ev_");
        await q.query(`INSERT INTO flow_evidence(id,tenant_id,workspace_id,document_id,revision,char_start,char_end,quote,created_by,idempotency_key,snippet_hash,url)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [evidence, ...scopeParams(s), doc.id, revision, span.char_start, span.char_end, span.text, "video-import", `video:${id}:${span.char_start}`, sha(span.text), job.input.canonical_url]);
        await q.query(`INSERT INTO flow_video_temporal_evidence(evidence_id,tenant_id,workspace_id,video_job_id,start_ms,end_ms,frame_ref,alignment_method,media_sha256,material_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [evidence, ...scopeParams(s), id, span.start_ms, span.end_ms, span.frame_ref ?? null, span.alignment_method, m.media_sha256,
            span.kind === "ocr" ? "ocr" : span.kind === "observation" ? "visual_observation" : m.input_kind === "platform_subtitles" ? "platform_subtitles" : "asr_transcript"]);
      }
      await stampVideoTextRetention(q, job, doc.id, revision, this.now);
      await q.query(`UPDATE flow_documents SET current_revision=$4,title=$5,video_ready=true WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND video_revoked_at IS NULL`, [...scopeParams(s), doc.id, revision, job.input.title]);
      let state = coverage.optional_missing.length ? "completed_with_gaps" : "completed";
      await q.query(`UPDATE flow_video_jobs SET state=$4,stage='ready',completion_level='knowledge_ready',document_id=$5,revision=$6,processing_manifest_sha256=$7,coverage=$8,available_capabilities=$9,finished_at=$10,updated_at=$10 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
        [...scopeParams(s), id, state, doc.id, revision, manifestHash, json(coverage), coverage.completed, this.now.toISOString()]);
      if (job.input.repair_job_id) {
      const repaired = await q.query(`UPDATE flow_video_objects old SET state='accepted',replica_job_id=fresh.video_job_id,replica_object_key=fresh.object_key FROM flow_video_objects fresh,flow_video_jobs original
        WHERE old.tenant_id=$1 AND old.workspace_id=$2 AND old.video_job_id=$3 AND old.state='missing'
          AND original.tenant_id=old.tenant_id AND original.workspace_id=old.workspace_id AND original.id=old.video_job_id AND original.asset_id=$4
          AND original.verified_media_sha256 IS NOT DISTINCT FROM $5::text AND fresh.tenant_id=old.tenant_id AND fresh.workspace_id=old.workspace_id AND fresh.video_job_id=$6
          AND fresh.sha256=old.sha256 AND fresh.bytes=old.bytes AND fresh.content_type=old.content_type AND fresh.state='accepted'
          AND (old.access_expires_at IS NULL OR old.access_expires_at>$7) RETURNING old.object_id`, [...scopeParams(s), job.input.repair_job_id, job.asset_id, m.media_sha256, id, this.now.toISOString()]);
      const target = await this.job(s, job.input.repair_job_id, q), requested = job.input.repair_objects?.length ?? 0;
      (coverage as any).repair = { requested, restored: repaired.rows.length, original_job_id: target.id,
        status: target.verified_media_sha256 !== m.media_sha256 ? "changed_media" : repaired.rows.length < requested ? "partial" : "restored" };
      if (repaired.rows.length < requested) state = "completed_with_gaps";
      await q.query(`UPDATE flow_video_jobs SET state=$4,coverage=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), id, state, json(coverage)]);
      }
      await this.engine.emit(q, s, job.operation_id, id, "video.knowledge_ready", { schema_version: 1, scope: { tenant_id: s.tenant_id, workspace_id: s.workspace_id }, operation_id: job.operation_id, video_job_id: id,
        knowledge_ready: true, cycle_complete: false, source_id: job.source_id, profile_id: job.profile_id, profile_version: job.profile_version, document_id: doc.id, revision, available_capabilities: coverage.completed, coverage, fingerprint: job.fingerprint });
      await enqueueVideoKnowledgeReady(q, s, { video_job_id: id, document_id: doc.id, revision, profile_id: job.profile_id, profile_version: job.profile_version, grant_actor: job.grant_actor, policy_version: job.policy_version });
      let dependencies: string[] = [];
      if (correction) {
        dependencies = (await q.query(`UPDATE flow_knowledge_units SET state='in_review',approval=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND state IN ('approved','published') AND id IN
          (SELECT knowledge_id FROM flow_knowledge_evidence_refs WHERE tenant_id=$1 AND workspace_id=$2 AND evidence_id=ANY($3::text[])) RETURNING id`, [...scopeParams(s), correction.evidence_ids])).rows.map(r => r.id);
        await q.query(`UPDATE flow_knowledge_releases SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=ANY($3::text[])`, [...scopeParams(s), dependencies]);
        await this.engine.emit(q, s, job.operation_id, id, "document.revised", { document_id: doc.id, revision, previous_revision: correction.revision, cause: "human_correction", recheck_knowledge_ids: dependencies });
      }
      const operations = (await q.query(`SELECT DISTINCT operation_id FROM flow_video_operation_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`, [...scopeParams(s), id])).rows;
      for (const op of operations) await this.readyCycle(q, s, op.operation_id);
      return { video_job_id: id, operation_id: job.operation_id, state, completion_level: "knowledge_ready", document_id: doc.id, revision, manifest_sha256: manifestHash, ...(correction ? { previous_revision: correction.revision, recheck_knowledge_ids: dependencies } : {}) };
  }
  /** One bounded existing monitor/Canvas window, only after discovery and every required material are ready. */
  private async readyCycle(q: Q, s: VideoScope, operation: string) {
    const cycle = (await q.query(`SELECT * FROM flow_collection_windows WHERE tenant_id=$1 AND workspace_id=$2 AND operation_id=$3 FOR UPDATE`, [...scopeParams(s), operation])).rows[0];
    if (!cycle?.monitor_id) return;
    const scans = (await q.query(`SELECT source_id,status FROM flow_collection_runs WHERE tenant_id=$1 AND workspace_id=$2 AND operation_id=$3`, [...scopeParams(s), operation])).rows;
    if (!cycle.expected_source_ids.every((id: string) => scans.some(r => r.source_id === id && r.status === "succeeded"))) return;
    const jobs = (await q.query(`SELECT j.*,m.source_id AS membership_source_id,r.title,r.body FROM flow_video_operation_jobs m JOIN flow_video_jobs j ON j.id=m.video_job_id AND j.tenant_id=m.tenant_id AND j.workspace_id=m.workspace_id
      LEFT JOIN flow_document_revisions r ON r.document_id=j.document_id AND r.revision=j.revision AND r.tenant_id=j.tenant_id
      WHERE m.tenant_id=$1 AND m.workspace_id=$2 AND m.operation_id=$3`, [...scopeParams(s), operation])).rows;
    if (!jobs.length || jobs.some(j => !["completed", "completed_with_gaps"].includes(j.state))) return;
    const keywordHit = (j: any) => !cycle.keywords.length || cycle.keywords.some((k: string) => `${j.title}\n\n${j.body}`.toLocaleLowerCase().includes(k.toLocaleLowerCase()));
    let matched = 0;
    for (const j of jobs.filter(keywordHit)) {
      const old = (await q.query(`SELECT 1 FROM flow_monitor_hits WHERE tenant_id=$1 AND workspace_id=$2 AND monitor_id=$3 AND document_id=$4 AND revision=$5 LIMIT 1`, [...scopeParams(s), cycle.monitor_id, j.document_id, j.revision])).rows[0];
      if (old) continue;
      await q.query(`INSERT INTO flow_monitor_hits(id,tenant_id,workspace_id,monitor_id,monitor_version,schedule_id,operation_id,job_id,source_id,document_id,revision,matched_at,scheduled_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`, [newVideoId("hit_"), ...scopeParams(s), cycle.monitor_id, cycle.monitor_version, cycle.schedule_id, operation, j.id, j.membership_source_id, j.document_id, j.revision, this.now.toISOString(), cycle.scheduled_at]);
      matched++;
    }
    if (!matched) return;
    const scheduled = new Date(cycle.scheduled_at);
    const payload = { knowledge_ready: true, cycle_complete: true, cycle_status: "succeeded", operation_id: operation, monitor_id: cycle.monitor_id, monitor_version: cycle.monitor_version,
      canvas_id: cycle.canvas_id, canvas_auto_run_grant: cycle.canvas_auto_run_grant, schedule_id: cycle.schedule_id, expected_source_ids: cycle.expected_source_ids,
      source_completions: scans, available_capabilities: [...new Set(jobs.flatMap(j => j.available_capabilities))], matched_documents: matched,
      window: { scheduled_at: scheduled.toISOString(), from: new Date(scheduled.getTime() - cycle.interval_seconds * 1000).toISOString(), to: scheduled.toISOString(), timezone: cycle.timezone } };
    await q.query(`INSERT INTO flow_outbox(event_id,tenant_id,workspace_id,operation_id,job_id,type,payload) VALUES($1,$2,$3,$4,$5,'video.knowledge_ready',$6) ON CONFLICT DO NOTHING`,
      [`evt_vcycle_${sha(`${s.tenant_id}:${s.workspace_id}:${operation}`).slice(0, 32)}`, ...scopeParams(s), operation, `cycle_${operation}`, json(payload)]);
  }
  /** Human corrections create new immutable artifacts and use the same K-017 FTS/evidence barrier. */
  async correct(s: VideoScope, id: string, key: string, body: any) {
    this.enabledFor(s);
    await assertVideoRetentionJournal(this.engine, s);
    if (s.actor?.type !== "user" || !s.scopes?.includes("intel.knowledge.review")) throw videoError(403, "HUMAN_REVIEW_REQUIRED");
    if (!key || key.length > 200 || !Array.isArray(body.patches) || !body.patches.length || body.patches.length > 100 || !String(body.reason ?? "").trim()) throw videoError(400, "INVALID_CORRECTION");
    const original = await this.job(s, id); await this.authorize({ ...original, grant_actor: actor(s) }, "intel.knowledge.review");
    if (!original.document_id || !["completed", "completed_with_gaps"].includes(original.state)) throw videoError(409, "READY_MATERIAL_REQUIRED");
    const requestHash = canonicalHash({ id, body });
    return this.db.tx(async q => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`correction:${s.tenant_id}:${s.workspace_id}:${key}`]);
      const old = (await q.query(`SELECT * FROM flow_video_corrections WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`, [...scopeParams(s), key])).rows[0];
      if (old) { if (old.request_hash !== requestHash) throw videoError(409, "IDEMPOTENCY_CONFLICT"); return { ...this.project(await this.job(s, old.video_job_id, q)), proposed_revision: old.to_revision, replayed: true }; }
      const doc = (await q.query(`SELECT d.*,r.content_hash,r.title FROM flow_documents d JOIN flow_document_revisions r ON r.document_id=d.id AND r.revision=d.current_revision AND r.tenant_id=d.tenant_id
        WHERE d.tenant_id=$1 AND d.workspace_id=$2 AND d.id=$3 AND d.video_ready AND d.video_revoked_at IS NULL FOR UPDATE OF d`, [...scopeParams(s), original.document_id])).rows[0];
      if (!doc || doc.current_revision !== body.expected_revision || doc.content_hash !== body.expected_content_hash) throw videoError(409, "VERSION_CONFLICT");
      const rows = (await q.query(`SELECT e.id,e.quote,e.char_start,t.start_ms,t.end_ms,t.frame_ref,t.media_sha256,t.material_type,t.alignment_method FROM flow_evidence e
        JOIN flow_video_temporal_evidence t ON t.evidence_id=e.id AND t.tenant_id=e.tenant_id AND t.workspace_id=e.workspace_id
        WHERE e.tenant_id=$1 AND e.workspace_id=$2 AND e.document_id=$3 AND e.revision=$4 ORDER BY e.char_start`, [...scopeParams(s), doc.id, doc.current_revision])).rows;
      const patches = new Map<string, any>();
      const parent = (await q.query(`SELECT manifest FROM flow_video_manifests WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND artifact_stage='processing_complete'`, [...scopeParams(s), original.id])).rows[0]?.manifest;
      if (!parent) throw videoError(409, "PARENT_MANIFEST_MISSING");
      const duration = parent.coverage?.duration_ms;
      for (const p of body.patches) {
        if (!p || typeof p.evidence_id !== "string" || patches.has(p.evidence_id) || !rows.some(r => r.id === p.evidence_id) || typeof p.text !== "string" || !p.text.trim() || p.text.length > 20000) throw videoError(422, "INVALID_CORRECTION_SPAN");
        if ((p.start_ms !== undefined || p.end_ms !== undefined) && (!finiteInt(p.start_ms, 0, 86_400_000) || !finiteInt(p.end_ms, p.start_ms, 86_400_000))) throw videoError(422, "INVALID_SEGMENT_TIME");
        if (p.end_ms !== undefined && Number.isSafeInteger(duration) && p.end_ms > duration) throw videoError(422, "SEGMENT_OUTSIDE_MEDIA");
        patches.set(p.evidence_id, p);
      }
      const segments: VideoSegment[] = rows.map(r => {
        const p = patches.get(r.id);
        return { text: p?.text ?? r.quote, start_ms: p?.start_ms ?? (r.start_ms == null ? null : Number(r.start_ms)), end_ms: p?.end_ms ?? (r.end_ms == null ? null : Number(r.end_ms)), frame_ref: r.frame_ref ?? undefined,
          alignment_method: p ? "human_segment" : r.alignment_method, kind: r.material_type === "ocr" ? "ocr" : r.material_type === "visual_observation" ? "observation" : r.material_type === "platform_subtitles" ? "subtitle" : "asr" };
      });
      const transcript = canonicalTranscript(doc.title, segments), jobId = newVideoId("vj_");
      const artifact = { schema_version: 1, kind: "human_transcript_correction", parent_document_id: doc.id, parent_revision: doc.current_revision, parent_content_hash: doc.content_hash,
        patches: body.patches, segments, actor: actor(s), alignment_method: "human_segment" };
      const digest = canonicalHash(artifact);
      const input = { ...original.input, title: doc.title, content_version: `correction:${digest}`, correction_parent: { document_id: doc.id, revision: doc.current_revision, content_hash: doc.content_hash, evidence_ids: [...patches.keys()] } };
      const job = (await q.query(`INSERT INTO flow_video_jobs(id,operation_id,tenant_id,workspace_id,source_id,asset_id,profile_id,profile_version,fingerprint,input,grant_actor,policy_version,state,stage,input_manifest_sha256,verified_input_hash,verified_media_sha256,processing_identity)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'running','correction',$13,$14,$15,$16) RETURNING *`,
        [jobId, newVideoId("op_"), ...scopeParams(s), original.source_id, original.asset_id, original.profile_id, original.profile_version, digest, json(input), actor(s), s.policy_version ?? "policy_v1", original.input_manifest_sha256, original.verified_input_hash, original.verified_media_sha256, original.processing_identity])).rows[0];
      const manifest: VideoManifest = { ...parent, video_job_id: jobId, objects: [], transcript: { parts: [] }, processors: { version: "human-correction-v1", parent_manifest_sha256: original.processing_manifest_sha256, artifact_sha256: digest } };
      await q.query(`INSERT INTO flow_video_manifests(tenant_id,workspace_id,video_job_id,artifact_stage,sha256,manifest) VALUES($1,$2,$3,'processing_complete',$4,$5)`, [...scopeParams(s), jobId, digest, json(manifest)]);
      await q.query(`INSERT INTO flow_video_corrections(tenant_id,workspace_id,idempotency_key,request_hash,original_job_id,video_job_id,document_id,from_revision,to_revision,artifact,reason,actor)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [...scopeParams(s), key, requestHash, id, jobId, doc.id, doc.current_revision, doc.current_revision + 1, json(artifact), String(body.reason).slice(0, 2000), actor(s)]);
      if (await enqueueVideoEmbedding(q, s, { job, manifest, manifestHash: digest, transcript })) return { video_job_id: jobId, operation_id: job.operation_id, state: "queued", stage: "embedding", document_id: doc.id, revision: null, proposed_revision: doc.current_revision + 1, previous_revision: doc.current_revision, recheck_knowledge_ids: [] };
      return this.commitReady(q, s, job, manifest, digest, transcript);
    });
  }
  async artifacts(s: VideoScope, id: string, cursor = "0", limit = 50, kind = "evidence", textOffset = 0, conflictOffset = 0, textField = "text") {
    const job = await this.job(s, id); await this.source(s, job.source_id, this.db, false);
    await this.readable(job);
    const offset = Number(cursor);
    if (!finiteInt(offset, 0, 10_000_000) || !finiteInt(limit, 1, 100)) throw videoError(400, "INVALID_PAGINATION");
    if (kind === "visual") {
      if (!finiteInt(textOffset, 0, 10_000_000) || !finiteInt(conflictOffset, 0, 8) || !["text", "audio", "visual"].includes(textField)) throw videoError(400, "INVALID_PAGINATION");
      return this.visualArtifacts(s, job, offset, textOffset || conflictOffset || textField !== "text" ? 1 : limit, textOffset, conflictOffset, textField);
    }
    if (kind === "media") {
      if (job.completion_level !== "knowledge_ready") return { video_job_id: id, kind, items: [], next_cursor: null, complete: false };
      const origin = job.reused_from_job_id ?? id;
      const rows = (await this.db.query(`SELECT object_id,content_type,bytes FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND state='accepted' AND (access_expires_at IS NULL OR access_expires_at>$6) AND content_type SIMILAR TO '(image|audio|video)/%' ORDER BY object_id LIMIT $4 OFFSET $5`, [...scopeParams(s), origin, limit + 1, offset, this.now.toISOString()])).rows;
      return { video_job_id: id, kind, items: rows.slice(0, limit).map(object => ({ ...object, bytes: Number(object.bytes), download_path: `/api/intelligence/video/jobs/${id}/media/${object.object_id}` })), next_cursor: rows.length > limit ? String(offset + limit) : null, complete: true };
    }
    if (!["evidence", "transcript", "all"].includes(kind)) throw videoError(400, "INVALID_ARTIFACT_KIND");
    const evidence = (await this.db.query(`SELECT e.id AS evidence_id,e.document_id,e.revision,e.char_start,e.char_end,e.quote,e.snippet_hash,t.start_ms,t.end_ms,t.frame_ref,t.alignment_method,t.media_sha256
      FROM flow_video_temporal_evidence t JOIN flow_evidence e ON e.id=t.evidence_id AND e.tenant_id=t.tenant_id AND e.workspace_id=t.workspace_id
      WHERE t.tenant_id=$1 AND t.workspace_id=$2 AND e.document_id=$3 AND e.revision=$4 ORDER BY e.char_start LIMIT $5 OFFSET $6`, [...scopeParams(s), job.document_id, job.revision, limit + 1, offset])).rows;
    const manifests = (await this.db.query(`SELECT artifact_stage,sha256,manifest FROM flow_video_manifests WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 ORDER BY artifact_stage`, [...scopeParams(s), id])).rows;
    const items: any[] = []; let bytes = 0;
    for (const e of evidence.slice(0, limit)) {
      const item = { ...e, ...videoEvidenceTime(e), quote: e.quote.length <= 1200 ? e.quote : null, quote_excerpt: e.quote.length > 1200 ? videoTextPreview(e.quote, 1200) : null,
        quote_complete: e.quote.length <= 1200, read_ref: { document_id: e.document_id, revision: e.revision, offset: e.char_start, max_chars: e.char_end - e.char_start } };
      const size = Buffer.byteLength(json(item)); if (items.length && bytes + size > 4500) break;
      bytes += size; items.push(item);
    }
    return { video_job_id: id, items, manifests: offset === 0 ? manifests.map(x => ({ artifact_stage: x.artifact_stage, sha256: x.sha256, input_kind: x.manifest.input_kind, availability: x.manifest.availability,
      object_count: x.manifest.objects.length, transcript_part_count: x.manifest.transcript?.parts?.length ?? 0 })) : [],
      next_cursor: evidence.length > items.length ? String(offset + items.length) : null, complete: job.completion_level === "knowledge_ready", coverage: job.coverage };
  }
  private async visualArtifacts(s: VideoScope, job: any, offset: number, limit: number, textOffset = 0, conflictOffset = 0, textField = "text") {
    const origin = job.reused_from_job_id ?? job.id;
    const manifest = (await this.db.query(`SELECT manifest FROM flow_video_manifests WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND artifact_stage='processing_complete'`, [...scopeParams(s), origin])).rows[0]?.manifest as VideoManifest | undefined;
    const items: any[] = []; let index = 0, bytes = 0;
    for (const part of manifest?.visual?.parts ?? []) {
      if (index + part.record_count <= offset) { index += part.record_count; continue; }
      const object = (await this.db.query(`SELECT state,access_expires_at FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 AND object_key=$3`, [...scopeParams(s), part.object_key])).rows[0];
      if (object?.state !== "accepted" || object.access_expires_at && new Date(object.access_expires_at) <= this.now || !this.provider) throw videoError(410, "VISUAL_ARTIFACT_EXPIRED");
      const raw = await this.provider.readObject(s, origin, part.object_key, 256 * 1024);
      if (sha(raw) !== part.sha256) throw videoError(422, "ARTIFACT_HASH_MISMATCH");
      for (const record of validateVisualPart(manifest!, part, raw)) {
        if (index++ < offset) continue;
        const chosen = textField === "text" ? record.text : record.conflict_candidates?.[conflictOffset]?.[textField]?.text;
        if (textField !== "text" && typeof chosen !== "string") throw videoError(404, "CONFLICT_SOURCE_NOT_FOUND");
        const value = typeof chosen === "string" ? chosen : "";
        if (textOffset > 0 && /[\uDC00-\uDFFF]/.test(value[textOffset] ?? "") && /[\uD800-\uDBFF]/.test(value[textOffset - 1] ?? "")) throw videoError(400, "INVALID_UTF16_OFFSET");
        let textEnd = Math.min(value.length, textOffset + 500);
        if (textEnd > 0 && /[\uDC00-\uDFFF]/.test(value[textEnd] ?? "") && /[\uD800-\uDBFF]/.test(value[textEnd - 1] ?? "")) textEnd--;
        const frameRefs = (record.frame_refs ?? (record.frame_ref ? [record.frame_ref] : [])).slice(0, 4);
        const media = (await this.db.query(`SELECT object_key,object_id,content_type,bytes,state,access_expires_at FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND object_key=ANY($4::text[])`, [...scopeParams(s), origin, frameRefs])).rows;
        const mediaRefs = frameRefs.map((key: string) => {
          const object = media.find(value => value.object_key === key);
          const available = !!object && object.state === "accepted" && (!object.access_expires_at || new Date(object.access_expires_at) > this.now);
          return { object_id: object?.object_id ?? null, content_type: object?.content_type ?? null, bytes: object ? Number(object.bytes) : null, available,
            download_path: available ? `/api/intelligence/video/jobs/${job.id}/media/${object!.object_id}` : null, unavailable_reason: available ? null : object?.state === "missing" ? "object_missing" : "media_expired" };
        });
        const item = { ...record, text: typeof chosen === "string" ? value.slice(textOffset, textEnd) : undefined,
          observed_text: textField === "text" && typeof record.observed_text === "string" ? value.slice(textOffset, textEnd) : undefined, text_complete: textOffset === 0 && textEnd >= value.length,
          text_offset: textOffset, total_text_chars: value.length, next_text_offset: textEnd < value.length ? textEnd : null,
          text_field: textField, read_ref: { kind: "visual", cursor: String(index - 1), text_offset: textEnd < value.length ? textEnd : 0, text_field: textField, conflict_offset: conflictOffset, limit: 1, record_id: record.record_id },
          conflict_candidates: record.conflict_candidates?.slice(conflictOffset, conflictOffset + 1).map((candidate: any) => ({ ...candidate,
            audio: { ...candidate.audio, text: videoTextPreview(candidate.audio.text, 250), text_complete: candidate.audio.text.length <= 250, read_ref: { kind: "visual", cursor: String(index - 1), text_field: "audio", conflict_offset: conflictOffset, text_offset: 0, limit: 1 } },
            visual: { ...candidate.visual, text: videoTextPreview(candidate.visual.text, 250), text_complete: candidate.visual.text.length <= 250, read_ref: { kind: "visual", cursor: String(index - 1), text_field: "visual", conflict_offset: conflictOffset, text_offset: 0, limit: 1 } } })),
          conflict_count: record.conflict_candidates?.length, next_conflict_offset: record.conflict_candidates?.length > conflictOffset + 1 ? conflictOffset + 1 : null,
          frame_media: record.frame_ref ? mediaRefs[0] : undefined, frame_media_items: record.frame_refs ? mediaRefs : undefined,
          frame_refs: record.frame_refs?.slice(0, 4), frame_ids: record.frame_ids?.slice(0, 4), frame_ref_count: record.frame_refs?.length,
          provenance: record.provenance ? { model_tasks: record.provenance.model_tasks.slice(0, 4).map((value: any) => ({ task_id: value.task_id, usage_ref: value.usage_ref, model_config_hash: value.model_config_hash })), model_task_count: record.provenance.model_tasks.length } : undefined,
          audio_segments: record.audio_segments?.slice(0, 4), audio_segment_count: record.audio_segments?.length };
        const size = Buffer.byteLength(json(item));
        if (items.length >= limit || items.length && bytes + size > 4500) return { video_job_id: job.id, kind: "visual", items, next_cursor: String(offset + items.length), complete: job.completion_level === "knowledge_ready" };
        if (size > 6000) throw videoError(422, "VISUAL_RECORD_TOO_LARGE");
        items.push(item); bytes += size;
      }
    }
    return { video_job_id: job.id, kind: "visual", items, next_cursor: null, complete: job.completion_level === "knowledge_ready" };
  }
  async readable(job: any) {
    const a = (await this.db.query(`SELECT a.revoked_at,d.video_revoked_at,d.video_text_access_expires_at,d.source_id AS document_source_id FROM flow_video_assets a LEFT JOIN flow_documents d ON d.id=$4 AND d.tenant_id=a.tenant_id AND d.workspace_id=a.workspace_id
      WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.id=$3`, [...scopeParams(job), job.asset_id, job.document_id])).rows[0];
    if (!a || a.revoked_at || a.video_revoked_at) throw videoError(403, "MATERIAL_REVOKED");
    if (job.document_id && !a.video_text_access_expires_at) throw videoError(503, "RETENTION_POLICY_NOT_BOUND");
    if (a.video_text_access_expires_at && new Date(a.video_text_access_expires_at) <= this.now) throw videoError(410, "MATERIAL_RETENTION_EXPIRED");
    if (a.document_source_id) await this.source(job, a.document_source_id, this.db, false);
  }
  async recordUsage(job: any, stage: string, usage: Record<string, unknown>) {
    const mapping: Record<string, string> = { download_bytes: "download_bytes", asr_seconds: "asr_seconds", ocr_requests: "ocr_pages", frame_count: "video_frames", vlm_requests: "vlm_requests", collection_requests: "collection_requests" };
    await this.db.tx(async q => {
      for (const [key, usage_type] of Object.entries(mapping)) {
        const quantity = Math.ceil(Number(usage[key]));
        if (!Number.isSafeInteger(quantity) || quantity < 0) continue;
        await q.query(`INSERT INTO flow_video_usage_counters(tenant_id,workspace_id,video_job_id,stage,usage_type) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...scopeParams(job), job.id, stage, usage_type]);
        const prior = (await q.query(`SELECT quantity FROM flow_video_usage_counters WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 AND usage_type=$5 FOR UPDATE`, [...scopeParams(job), job.id, stage, usage_type])).rows[0];
        const delta = quantity - Number(prior.quantity); if (delta <= 0) continue;
        await q.query(`UPDATE flow_video_usage_counters SET quantity=$6 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 AND usage_type=$5`, [...scopeParams(job), job.id, stage, usage_type, quantity]);
        // Priced ASR/OCR admissions are settled by the authoritative host child ledger, not charged twice via outbox.
        if (!(job.budget_reservation_id && ["asr_seconds", "ocr_pages"].includes(usage_type))) await this.engine.emit(q, job, job.operation_id, job.id, "usage.recorded", { usage_type, quantity: delta, video_job_id: job.id, profile_id: job.profile_id, profile_version: job.profile_version, stage });
      }
    });
  }
  /** Operational intermediates are cleanup inventory only, never evidence or ready receipts. */
  async registerArtifacts(job: any, objects: NonNullable<ProviderResult["artifacts"]>) {
    if (!Array.isArray(objects) || objects.length > 10000) throw videoError(422, "INVALID_ARTIFACT_OBJECT");
    const profile = await this.profile(job, job.profile_id, job.profile_version);
    for (const o of objects) {
      assertVideoObject(job, o.object_key, job.id);
      if (!/^[a-f0-9]{64}$/.test(o.sha256) || o.object_key.split("/")[6] !== o.sha256 || !finiteInt(o.bytes, 1, profile.config.max_video_bytes)
        || !["application/json", "application/x-subrip", "text/vtt", "text/plain", "video/mp4", "audio/wav", "audio/mpeg", "image/png", "image/jpeg"].includes(o.content_type)) throw videoError(422, "INVALID_ARTIFACT_OBJECT");
      const prior = (await this.db.query(`SELECT * FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 AND object_key=$3`, [...scopeParams(job), o.object_key])).rows[0];
      if (prior) {
        if (prior.sha256 !== o.sha256 || Number(prior.bytes) !== o.bytes || prior.content_type !== o.content_type) throw videoError(409, "ARTIFACT_CONFLICT");
        continue;
      }
      if (!this.provider?.verifyObject) throw videoError(503, "STREAMING_VERIFICATION_UNAVAILABLE");
      const actual = await this.provider.verifyObject(job, job.id, o.object_key, o.bytes);
      if (actual.sha256 !== o.sha256 || actual.bytes !== o.bytes) throw videoError(422, "ARTIFACT_HASH_MISMATCH");
      if (/^(video|audio|image)\//.test(o.content_type) && actual.content_type !== o.content_type) throw videoError(422, "ARTIFACT_TYPE_MISMATCH");
      await this.db.tx(async q => {
      await q.query(`INSERT INTO flow_video_objects(tenant_id,workspace_id,video_job_id,object_key,sha256,bytes,content_type,state)
        SELECT $1,$2,$3,$4,$5,$6,$7,CASE WHEN j.state='cancelled' OR a.revoked_at IS NOT NULL OR s.status='revoked' THEN 'delete_pending' ELSE 'accepted' END
        FROM flow_video_jobs j JOIN flow_video_assets a ON a.id=j.asset_id AND a.tenant_id=j.tenant_id AND a.workspace_id=j.workspace_id
        JOIN flow_sources s ON s.id=j.source_id AND s.tenant_id=j.tenant_id AND s.workspace_id=j.workspace_id
        WHERE j.tenant_id=$1 AND j.workspace_id=$2 AND j.id=$3 ON CONFLICT DO NOTHING`, [...scopeParams(job), job.id, o.object_key, o.sha256, o.bytes, o.content_type]);
      await registerVideoObjectRetention(q, job, [o], this.now);
      });
    }
  }
  private async registerResultArtifacts(job: any, result: ProviderResult) {
    await this.registerArtifacts(job, result.artifacts ?? []);
    let cursor = result.next_artifact_cursor, pages = 0;
    const seen = new Set<string>();
    while (cursor) {
      if (!this.provider?.artifactPage || seen.has(cursor) || ++pages > 1000) throw videoError(502, "ARTIFACT_PAGINATION_INVALID");
      seen.add(cursor);
      const page = await this.provider.artifactPage(job, result.task_id, cursor);
      await this.registerArtifacts(job, page.artifacts);
      cursor = page.next_artifact_cursor;
    }
  }
  private async harvestCleanupInventory(job: any) {
    if (!this.provider?.inventoryPage) return;
    let cursor: string | null = "0"; const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor) || seen.size >= 1000) throw videoError(502, "ARTIFACT_PAGINATION_INVALID"); seen.add(cursor);
      const page = await this.provider.inventoryPage(job, cursor);
      if (!Array.isArray(page.artifacts) || page.artifacts.length > 100) throw videoError(502, "ARTIFACT_PAGINATION_INVALID");
      for (const object of page.artifacts) {
        assertVideoObject(job, object.object_key, job.id);
        if (object.object_key.split("/")[6] !== object.sha256 || !finiteInt(object.bytes, 0, 10_000_000_000) || typeof object.content_type !== "string") throw videoError(422, "INVALID_ARTIFACT_OBJECT");
        // A pre-write receipt is a cleanup destination, NEVER proof of source bytes or a ready artifact.
        await this.db.tx(async q => {
        await q.query(`INSERT INTO flow_video_objects(tenant_id,workspace_id,video_job_id,object_key,sha256,bytes,content_type,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,'delete_pending') ON CONFLICT(tenant_id,workspace_id,object_key) DO UPDATE SET state=CASE WHEN flow_video_objects.state='deleted' THEN 'deleted' ELSE 'delete_pending' END`,
          [...scopeParams(job), job.id, object.object_key, object.sha256, object.bytes, object.content_type]);
        await registerVideoObjectRetention(q, job, [object], this.now);
        });
      }
      cursor = page.next_artifact_cursor;
    }
  }
  async maintain(limit = 20) {
    await expireVideoObjects(this.engine, limit);
    // Harvest cancellation receipts without resuming processing or publishing late artifacts.
    if (this.provider) {
      const cleanup = (await this.db.query(`SELECT j.* FROM flow_video_jobs j JOIN flow_video_assets a ON a.id=j.asset_id AND a.tenant_id=j.tenant_id AND a.workspace_id=j.workspace_id
        JOIN flow_sources s ON s.id=j.source_id AND s.tenant_id=j.tenant_id AND s.workspace_id=j.workspace_id
        WHERE j.execution_erased_at IS NULL AND (j.state='cancelled' OR a.revoked_at IS NOT NULL OR s.status='revoked') ORDER BY j.updated_at LIMIT $1`, [limit])).rows;
      for (const job of cleanup) try {
        await this.harvestCleanupInventory(job);
        await this.provider.cleanupTemporary?.(job, Math.floor(this.now.getTime() / 1000) - 86400);
      } catch (error: any) { await this.db.query(`UPDATE flow_video_jobs SET cleanup_error=$4,updated_at=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(job), job.id, json({ code: error.reason ?? "INVENTORY_RECONCILIATION_PENDING" }), this.now.toISOString()]); }
      const stopped = (await this.db.query(`SELECT j.*,i.stage AS intent_stage,i.intent_key,i.external_task_id FROM flow_video_jobs j
        JOIN flow_video_submission_intents i ON i.tenant_id=j.tenant_id AND i.workspace_id=j.workspace_id AND i.video_job_id=j.id
        WHERE j.state='cancelled' AND i.state<>'terminal' ORDER BY i.updated_at LIMIT $1`, [limit])).rows;
      for (const j of stopped) {
        try {
          await this.db.query(`UPDATE flow_video_submission_intents SET updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(j), j.id, j.intent_stage]);
          const st = (await this.db.query(`SELECT * FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(j), j.id, j.intent_stage])).rows[0];
          let result = j.external_task_id ? await this.provider.poll(j, st, j.external_task_id) : await this.provider.reconcile?.(j, st, j.intent_key);
          if (!result?.task_id) continue; // Absence is not proof an external submit never happened.
          if (!j.external_task_id) await this.db.query(`UPDATE flow_video_submission_intents SET external_task_id=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4 AND external_task_id IS NULL`, [...scopeParams(j), j.id, j.intent_stage, result.task_id]);
          await this.observeExternal(j, st, result);
          if (result.state === "pending") {
            const remote = await this.provider.cancel(j, result.task_id);
            await this.db.query(`UPDATE flow_video_jobs SET remote_cancel_status=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(j), j.id, remote]);
            result = await this.provider.poll(j, st, result.task_id);
            await this.observeExternal(j, st, result);
          }
          await this.recordUsage(j, j.intent_stage, result.usage ?? (result.manifest as any)?.usage ?? {});
          await this.registerResultArtifacts(j, result);
          if (["completed", "failed"].includes(result.state)) await this.db.query(`UPDATE flow_video_submission_intents SET state='terminal' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(j), j.id, j.intent_stage]);
        } catch (error: any) {
          await this.db.query(`UPDATE flow_video_jobs SET cleanup_error=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(j), j.id, json({ code: error.reason ?? "CLEANUP_RECONCILIATION_PENDING" })]);
        }
      }
    }
    if (this.engine.budget) {
      const unconfirmed = (await this.db.query(`SELECT * FROM flow_video_jobs WHERE state IN ('failed','cancelled') AND budget_reservation_id IS NULL AND budget_reserving_at IS NOT NULL ORDER BY created_at LIMIT $1`, [limit])).rows;
      for (const j of unconfirmed) try {
        if (!this.engine.budget.lookup) continue;
        const receipt = await this.engine.budget.lookup(j, `video:${j.fingerprint}:budget:${j.budget_generation}`, j.id);
        if (!receipt) continue; // Absence during an in-flight request is not proof of rejection.
        await this.db.query(`UPDATE flow_video_jobs SET budget_reservation_id=$4,budget_reserving_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND budget_generation=$5 AND budget_reservation_id IS NULL`, [...scopeParams(j), j.id, receipt.reservation_id, j.budget_generation]);
      } catch { /* Read only the original key; uncertainty remains a visible hold. */ }
      const terminal = (await this.db.query(`SELECT * FROM flow_video_jobs WHERE state IN ('completed','completed_with_gaps','failed','cancelled') AND budget_reservation_id IS NOT NULL AND budget_closed_at IS NULL ORDER BY created_at LIMIT $1`, [limit])).rows;
      for (const j of terminal) {
        try {
        if (!this.budgetStatus) continue; // Unknown external accounting is a hold, never assumed zero.
        const budget = await this.budgetStatus(j);
        if (budget.reservation_id !== j.budget_reservation_id || !finiteInt(budget.consumed_micro, 0, Number.MAX_SAFE_INTEGER)) throw videoError(502, "BUDGET_RECEIPT_INVALID");
        const current = affected(await this.db.query(`UPDATE flow_video_jobs SET actual_usage_micro=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND budget_reservation_id=$5 AND budget_generation=$6 AND state=$7 AND budget_closed_at IS NULL`, [...scopeParams(j), j.id, Number(j.budget_consumed_prior_micro) + budget.consumed_micro, j.budget_reservation_id, j.budget_generation, j.state]));
        if (current !== 1) continue;
        if (budget.open_children || budget.unknown_children || budget.allocated_micro) continue;
        // Persist an intent before the external close. This prevents a retry
        // reusing a still-"reserved" parent while settlement is in flight. An
        // unknown response leaves the intent for idempotent maintenance replay.
        const closing = affected(await this.db.query(`UPDATE flow_video_jobs SET budget_closing_at=coalesce(budget_closing_at,$4) WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND budget_reservation_id=$5 AND budget_generation=$6 AND state=$7 AND budget_closed_at IS NULL`, [...scopeParams(j), j.id, this.now.toISOString(), j.budget_reservation_id, j.budget_generation, j.state]));
        if (closing !== 1) continue;
        // Child actual costs already roll into the host parent; actual_micro here MUST stay zero to prevent double charge.
        await this.engine.budget.close(j, j.budget_reservation_id, budget.consumed_micro > 0 || ["completed", "completed_with_gaps"].includes(j.state) ? "settle" : "release", 0);
        await this.db.query(`UPDATE flow_video_jobs SET budget_closed_at=$4,budget_closing_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND budget_reservation_id=$5 AND budget_generation=$6 AND budget_closed_at IS NULL`, [...scopeParams(j), j.id, this.now.toISOString(), j.budget_reservation_id, j.budget_generation]);
        } catch { /* Financial uncertainty retains the hold; it must not prevent unrelated object cleanup. */ }
      }
    }
    if (!this.provider?.deleteObject) return;
    const pending = (await this.db.query(`SELECT o.* FROM flow_video_objects o WHERE o.state='delete_pending' AND o.cleanup_next_at<=$1 AND NOT EXISTS
      (SELECT 1 FROM flow_video_stages st WHERE st.tenant_id=o.tenant_id AND st.workspace_id=o.workspace_id AND st.video_job_id=o.video_job_id AND st.state='running' AND st.lease_expires_at>$1) ORDER BY o.cleanup_next_at,o.created_at LIMIT $2`, [this.now.toISOString(), limit])).rows;
    for (const o of pending) {
      try {
        assertVideoObject(o, o.object_key, o.video_job_id);
        const receipt = await this.provider.deleteObject(o, o.video_job_id, o.object_key, o.sha256);
        if (!receipt.deleted || receipt.sha256 !== o.sha256) throw videoError(502, "DELETE_UNCONFIRMED");
        await this.db.tx(async q => {
          await q.query(`INSERT INTO flow_video_cleanup_receipts(tenant_id,workspace_id,object_key,sha256) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [...scopeParams(o), o.object_key, o.sha256]);
          await q.query(`UPDATE flow_video_objects SET state='deleted' WHERE tenant_id=$1 AND workspace_id=$2 AND object_key=$3 AND state='delete_pending'`, [...scopeParams(o), o.object_key]);
          await q.query(`UPDATE flow_video_jobs SET cleanup_error=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(o), o.video_job_id]);
        });
      } catch (error: any) {
        await this.db.query(`UPDATE flow_video_jobs SET cleanup_error=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(o), o.video_job_id, json({ code: error.reason ?? "OBJECT_DELETE_PENDING" })]);
        await this.db.query(`UPDATE flow_video_objects SET cleanup_next_at=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND object_key=$3`, [...scopeParams(o), o.object_key, new Date(this.now.getTime() + 60_000).toISOString()]);
      }
    }
    if (this.provider.eraseJob) {
      const erased = (await this.db.query(`SELECT j.* FROM flow_video_jobs j JOIN flow_video_assets a ON a.id=j.asset_id AND a.tenant_id=j.tenant_id AND a.workspace_id=j.workspace_id
        JOIN flow_sources s ON s.id=j.source_id AND s.tenant_id=j.tenant_id AND s.workspace_id=j.workspace_id
        WHERE j.execution_erased_at IS NULL AND (a.revoked_at IS NOT NULL OR s.status='revoked')
        AND NOT EXISTS (SELECT 1 FROM flow_video_objects o WHERE o.tenant_id=j.tenant_id AND o.workspace_id=j.workspace_id AND o.video_job_id=j.id AND o.state<>'deleted')
        AND NOT EXISTS (SELECT 1 FROM flow_video_submission_intents i WHERE i.tenant_id=j.tenant_id AND i.workspace_id=j.workspace_id AND i.video_job_id=j.id AND i.state<>'terminal') ORDER BY j.created_at LIMIT $1`, [limit])).rows;
      for (const j of erased) {
        try {
          const receipt = await this.provider.eraseJob(j, j.id);
          if (!receipt.erased || receipt.video_job_id !== j.id) throw videoError(502, "ERASURE_UNCONFIRMED");
          await this.db.query(`UPDATE flow_video_jobs SET execution_erased_at=$4,cleanup_error=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(j), j.id, this.now.toISOString()]);
        } catch (error: any) {
          await this.db.query(`UPDATE flow_video_jobs SET cleanup_error=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(j), j.id, json({ code: error.reason ?? "EXECUTION_ERASURE_PENDING" })]);
        }
      }
    }
  }
  async modelAuthorization(s: VideoScope, id: string, fence?: { stage_attempt: number; fencing_token: number }, purpose = "video_vision") {
    const j = await this.job(s, id);
    if (!["video_vision", "video_summary", "video_usage", "video_usage_settle", "video_embedding"].includes(purpose)) throw videoError(403, "VIDEO_MODEL_NOT_AUTHORIZED");
    const settleOnly = purpose === "video_usage_settle", stage = purpose === "video_embedding" ? "embedding" : "process";
    if (!settleOnly) {
      this.enabledFor(j);
      if (!["queued", "running", "retry_wait"].includes(j.state) || j.stage !== stage) throw videoError(403, "VIDEO_MODEL_NOT_AUTHORIZED");
      await this.authorize(j);
    }
    if (fence) {
      const st = (await this.db.query(`SELECT * FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND stage=$4`, [...scopeParams(s), id, stage])).rows[0];
      if (settleOnly) {
        // Settlement never authorizes work. Host additionally binds the child receipt to this scoped job/attempt/fence.
        if ((fence.stage_attempt || fence.fencing_token) && (!st || !finiteInt(fence.stage_attempt, 1, st.attempt) || !finiteInt(fence.fencing_token, 1, Number(st.fencing_token)))) throw videoError(403, "STALE_FENCE");
      } else if (!st || st.state !== "running" || st.attempt !== fence.stage_attempt || Number(st.fencing_token) !== fence.fencing_token || new Date(st.lease_expires_at).getTime() <= this.now.getTime()) throw videoError(403, "STALE_FENCE");
    }
    const profile = await this.profile(s, j.profile_id, j.profile_version);
    const input = (await this.db.query(`SELECT manifest FROM flow_video_manifests WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND artifact_stage='input_ready'`, [...scopeParams(s), id])).rows[0]?.manifest;
    return { allowed: true, settlement_only: settleOnly, video_job_id: id, profile_id: j.profile_id, profile_version: j.profile_version, budget_reservation_id: j.budget_reservation_id, grant_actor: j.grant_actor,
      budget_micro: profile.config.budget_micro, max_duration_ms: profile.config.max_duration_ms, max_frames: profile.config.max_frames ?? 120, duration_ms: input?.coverage?.duration_ms ?? null };
  }
  async mediaObject(s: VideoScope, id: string, objectId: string, range?: string) {
    await assertVideoRetentionJournal(this.engine, s);
    const job = await this.job(s, id); await this.source(s, job.source_id, this.db, false); await this.readable(job);
    if (job.completion_level !== "knowledge_ready" || !/^[a-f0-9]{32}$/.test(objectId)) throw videoError(404, "OBJECT_NOT_FOUND");
    const origin = job.reused_from_job_id ?? id;
    const object = (await this.db.query(`SELECT * FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND object_id=$4`, [...scopeParams(s), origin, objectId])).rows[0];
    if (!object || !/^(image|audio|video)\//.test(object.content_type)) throw videoError(404, "OBJECT_NOT_FOUND");
    if (object.state === "missing") throw videoError(404, "OBJECT_NOT_FOUND");
    if (object.state !== "accepted" || object.access_expires_at && new Date(object.access_expires_at) <= this.now) throw videoError(410, "MEDIA_EXPIRED");
    const total = Number(object.bytes); let start = 0, end = total - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || !match[1] && !match[2]) throw videoError(416, "INVALID_RANGE");
      start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
      end = match[1] && match[2] ? Math.min(total - 1, Number(match[2])) : total - 1;
      if (!finiteInt(start, 0, total - 1) || !finiteInt(end, start, total - 1)) throw videoError(416, "INVALID_RANGE");
      range = `bytes=${start}-${end}`;
    }
    if (!this.provider?.openObject) throw videoError(503, "STREAMING_VERIFICATION_UNAVAILABLE");
    let response: Response;
    if (object.replica_job_id) {
      const replica = (await this.db.query(`SELECT state,sha256,bytes,content_type,access_expires_at FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND object_key=$4`, [...scopeParams(s), object.replica_job_id, object.replica_object_key])).rows[0];
      if (!replica || replica.state !== "accepted" || replica.sha256 !== object.sha256 || Number(replica.bytes) !== Number(object.bytes) || replica.content_type !== object.content_type || replica.access_expires_at && new Date(replica.access_expires_at) <= this.now) throw videoError(404, "OBJECT_NOT_FOUND");
    }
    try { response = await this.provider.openObject(s, object.replica_job_id ?? origin, object.replica_object_key ?? object.object_key, range); }
    catch (error: any) {
      if (error.status === 404) await this.db.query(`UPDATE flow_video_objects SET state='missing' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND object_id=$4 AND state='accepted'`, [...scopeParams(s), origin, objectId]);
      throw error;
    }
    if (response.status !== (range ? 206 : 200) || response.headers.get("etag") !== `"${object.sha256}"` || Number(response.headers.get("content-length")) !== end - start + 1
      || response.headers.get("content-type") !== object.content_type || range && response.headers.get("content-range") !== `bytes ${start}-${end}/${total}`) {
      await response.body?.cancel(); throw videoError(502, "MEDIA_RECEIPT_INVALID");
    }
    return response;
  }
  async rawObject(s: VideoScope, id: string, key: string, fence?: { stage_attempt: number; fencing_token: number }) {
    const j = await this.job(s, id); await this.source(s, j.source_id, this.db, false); assertVideoObject(s, key, id);
    if (s.scopes?.includes("intel.video.model")) await this.modelAuthorization(s, id, fence);
    const asset = (await this.db.query(`SELECT revoked_at,availability FROM flow_video_assets WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...scopeParams(s), j.asset_id])).rows[0];
    if (!asset || asset.revoked_at || asset.availability === "media_expired") throw videoError(403, "MEDIA_UNAVAILABLE");
    const object = (await this.db.query(`SELECT * FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND object_key=$4 AND state='accepted'`, [...scopeParams(s), id, key])).rows[0];
    if (!this.provider) throw videoError(404, "OBJECT_NOT_FOUND");
    if (!object) {
      // Model-only staging read breaks the frame/OCR/VLM dependency cycle without creating evidence or ready state.
      if (!s.scopes?.includes("intel.video.model")) throw videoError(404, "OBJECT_NOT_FOUND");
      await this.modelAuthorization(s, id, fence);
      const bytes = await this.provider.readObject(s, id, key, 10_000_000);
      const digest = key.split("/")[6];
      if (sha(bytes) !== digest) throw videoError(422, "ARTIFACT_HASH_MISMATCH");
      const content_type = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? "image/png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "";
      if (!content_type) throw videoError(422, "INVALID_IMAGE_TYPE");
      return { bytes, content_type, sha256: digest };
    }
    if (object.access_expires_at && new Date(object.access_expires_at) <= this.now) throw videoError(410, "MEDIA_EXPIRED");
    const bytes = await this.provider.readObject(s, id, key, Math.min(Number(object.bytes), 10_000_000));
    if (sha(bytes) !== object.sha256 || bytes.byteLength !== Number(object.bytes)) throw videoError(422, "ARTIFACT_HASH_MISMATCH");
    return { bytes, content_type: object.content_type, sha256: object.sha256 };
  }
}

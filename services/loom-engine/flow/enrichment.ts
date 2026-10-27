// Flow adapters for upstream loom collection-capability enrichment (cdcb787f):
//  - article reader: upstream readArticle() (hosted reader, per-host allowlist,
//    public-DNS rechecks via outbound-policy, access-challenge rejection);
//  - YouTube subtitles: upstream subtitle worker contract (POST /v1/transcript,
//    bearer token, bounded 2 MiB body) parsed with upstream transcriptText().
// Both are opt-in by env exactly like upstream (ARTICLE_READER_ENABLED /
// SUBTITLE_ENABLED). Tenant scoping lives in Engine: callers resolve the
// document under (tenant_id, workspace_id) before any outbound call.
import { createHash } from "node:crypto";
import { youtubeVideoId, transcriptText } from "../src/lib/server/subtitles.ts";
import { subtitleLanguages, type SubtitleLanguage } from "../src/lib/subtitle-contract.ts";

export type ArticleReader = (url: string) => Promise<{ title: string; body: string; sourceUrl: string; digest: string }>;
export type Transcript = { status: "ok" | "no_subtitles"; kind: "manual" | "automatic" | "none"; language: SubtitleLanguage; text: string; digest: string };
export type SubtitleClient = (videoId: string, language: SubtitleLanguage) => Promise<Transcript>;

export class EnrichmentError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export function articleHostsFromEnv(raw = process.env.ARTICLE_READER_ALLOWED_HOSTS ?? ""): Set<string> {
  const hosts = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  // Same rule as upstream: one malformed or wildcard entry disables the allowlist entirely.
  if (hosts.some((h) => { try { return new URL(`https://${h}`).hostname !== h || h.includes("*"); } catch { return true; } })) return new Set();
  return new Set(hosts);
}

export const defaultArticleReader: ArticleReader = async (url) => {
  if (process.env.ARTICLE_READER_ENABLED !== "true") throw new EnrichmentError("article_disabled");
  const { readArticle } = await import("../src/lib/server/article-reader.ts");
  const a = await readArticle(url, { allowedHosts: articleHostsFromEnv() });
  return { title: a.title, body: a.body, sourceUrl: a.sourceUrl, digest: a.digest };
};

/** Video id for a Flow document; reuses the upstream URL/external-id rules. */
export function documentVideoId(d: { url: string; external_id?: string | null }): string {
  try { return youtubeVideoId({ platform: "youtube", url: d.url, external_id: d.external_id ?? undefined }); }
  catch { throw new EnrichmentError("subtitle_unsupported"); }
}

export function isSubtitleLanguage(x: unknown): x is SubtitleLanguage { return (subtitleLanguages as readonly unknown[]).includes(x); }

const MAX_BYTES = 2 * 1024 * 1024;

export function subtitleClient(opts: { endpoint?: string; token?: string; enabled?: boolean; fetchImpl?: typeof fetch } = {}): SubtitleClient {
  return async (videoId, language) => {
    const enabled = opts.enabled ?? process.env.SUBTITLE_ENABLED === "true";
    const token = opts.token ?? process.env.SUBTITLE_SERVICE_TOKEN ?? "";
    const raw = opts.endpoint ?? process.env.SUBTITLE_URL ?? "http://subtitle-egress:8794";
    if (!enabled) throw new EnrichmentError("subtitle_disabled");
    let endpoint: URL;
    try { endpoint = new URL(raw); } catch { throw new EnrichmentError("subtitle_unavailable"); }
    if (!token || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new EnrichmentError("subtitle_unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await (opts.fetchImpl ?? fetch)(new URL("/v1/transcript", endpoint), { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ video_id: videoId, language }) });
      if (!res.body) throw new EnrichmentError("subtitle_invalid_response");
      reader = res.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const n = await reader.read(); if (n.done) break;
        size += n.value.byteLength; if (size > MAX_BYTES) throw new EnrichmentError("subtitle_output_too_large"); chunks.push(n.value);
      }
      let data: any;
      try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new EnrichmentError("subtitle_invalid_response"); }
      if (!res.ok) throw new EnrichmentError(["timeout", "busy", "output_too_large"].includes(data?.error) ? `subtitle_${data.error}` : "subtitle_unavailable");
      if (!data || data.video_id !== videoId || data.language !== language) throw new EnrichmentError("subtitle_invalid_response");
      if (data.status === "no_subtitles" && data.kind === "none") return { status: "no_subtitles", kind: "none", language, text: "", digest: "" };
      if (data.status !== "ok" || !["manual", "automatic"].includes(data.kind) || typeof data.json3 !== "string") throw new EnrichmentError("subtitle_invalid_response");
      let text: string;
      try { text = transcriptText(data.json3); } catch (e: any) { throw new EnrichmentError(String(e?.message ?? "subtitle_invalid_response")); }
      if (data.text !== text) throw new EnrichmentError("subtitle_invalid_response");
      return { status: "ok", kind: data.kind, language, text, digest: createHash("sha256").update(data.json3, "utf8").digest("hex") };
    } catch (e) {
      if (e instanceof EnrichmentError) throw e;
      throw new EnrichmentError(controller.signal.aborted ? "subtitle_timeout" : "subtitle_unavailable");
    } finally { clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}); }
  };
}

/** HTTP status for an enrichment failure: config/unsupported → 422, upstream trouble → 502. */
export function enrichmentStatus(code: string): number {
  if (/_(disabled|unsupported|target_not_allowed|wechat_gateway_required|access_challenge|invalid_input)$/.test(code)) return 422;
  if (/_busy$/.test(code)) return 429;
  return 502;
}

// ---------- OCR (§6.4): optional extract-profile worker (tesseract) behind a bearer token ----------
export type OcrResult = { text: string; pages: number; digest: string };
export type OcrClient = (objectKey: string, scope: { tenant_id: string; workspace_id: string }) => Promise<OcrResult>;

/** OCR worker contract: POST /v1/ocr {object_key, tenant_id, workspace_id} → {object_key, text, pages, sha256}. Opt-in (OCR_ENABLED). */
export function ocrClient(opts: { endpoint?: string; token?: string; enabled?: boolean; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): OcrClient {
  return async (objectKey, scope) => {
    const enabled = opts.enabled ?? process.env.OCR_ENABLED === "true";
    const token = opts.token ?? process.env.OCR_SERVICE_TOKEN ?? "";
    const raw = opts.endpoint ?? process.env.OCR_URL ?? "http://ocr-worker:8796";
    if (!enabled) throw new EnrichmentError("ocr_disabled");
    let endpoint: URL;
    try { endpoint = new URL(raw); } catch { throw new EnrichmentError("ocr_unavailable"); }
    if (!token || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== "/") throw new EnrichmentError("ocr_unavailable");
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(new URL("/v1/ocr", endpoint), { method: "POST", redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ object_key: objectKey, tenant_id: scope.tenant_id, workspace_id: scope.workspace_id }) });
    } catch (e: any) { throw new EnrichmentError(e?.name === "TimeoutError" ? "ocr_timeout" : "ocr_unavailable"); }
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new EnrichmentError("ocr_output_too_large");
    let data: any; try { data = JSON.parse(text); } catch { throw new EnrichmentError("ocr_invalid_response"); }
    if (!res.ok) throw new EnrichmentError(["unsupported", "busy", "timeout", "not_found"].includes(data?.error) ? `ocr_${data.error === "not_found" ? "unsupported" : data.error}` : "ocr_unavailable");
    if (data?.object_key !== objectKey || typeof data.text !== "string" || !Number.isInteger(data.pages) || data.pages < 0) throw new EnrichmentError("ocr_invalid_response");
    return { text: data.text, pages: data.pages, digest: typeof data.sha256 === "string" ? data.sha256 : createHash("sha256").update(data.text).digest("hex") };
  };
}

/** PRD §6.4 ASR: speech-to-text of a stored audio/video attachment by the asr worker (compose profile "asr"). */
export type AsrSegment = { text: string; start: number; end: number };
export type AsrPart = { object_key: string; sha256: string; bytes: number; segment_count: number };
export type AsrResult = { text: string; seconds: number; language: string; digest: string; segments?: AsrSegment[]; parts?: AsrPart[]; complete?: boolean; status?: "ok" | "no_speech" };
export type AsrClient = (objectKey: string, scope: { tenant_id: string; workspace_id: string }, language?: string) => Promise<AsrResult>;

async function boundedWorkerJson(res: Response, maximum: number): Promise<{ data: any; raw: Uint8Array }> {
  if (!res.body) throw new EnrichmentError("asr_invalid_response");
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > maximum) throw new EnrichmentError("asr_output_too_large"); chunks.push(item.value); }
    const raw = Buffer.concat(chunks);
    try { return { data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), raw }; }
    catch { throw new EnrichmentError("asr_invalid_response"); }
  } finally { await reader.cancel().catch(() => {}); }
}

export function asrClient(opts: { endpoint?: string; token?: string; enabled?: boolean; fetchImpl?: typeof fetch; timeoutMs?: number; onPart?: (segments: AsrSegment[], part: AsrPart) => Promise<void> } = {}): AsrClient {
  return async (objectKey, scope, language) => {
    const enabled = opts.enabled ?? process.env.ASR_ENABLED === "true";
    const token = opts.token ?? process.env.ASR_SERVICE_TOKEN ?? "";
    const raw = opts.endpoint ?? process.env.ASR_URL ?? "http://asr-worker:8797";
    if (!enabled) throw new EnrichmentError("asr_disabled");
    let endpoint: URL;
    try { endpoint = new URL(raw); } catch { throw new EnrichmentError("asr_unavailable"); }
    if (!token || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new EnrichmentError("asr_unavailable");
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(new URL("/v1/asr", endpoint), { method: "POST", redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 900_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ object_key: objectKey, tenant_id: scope.tenant_id, workspace_id: scope.workspace_id, output_format: "manifest", ...(language ? { language } : {}) }) });
    } catch (e: any) { throw new EnrichmentError(e?.name === "TimeoutError" ? "asr_timeout" : "asr_unavailable"); }
    const { data } = await boundedWorkerJson(res, 4 * MAX_BYTES);
    if (!res.ok) throw new EnrichmentError(["unsupported", "busy", "timeout", "not_found", "too_long", "too_large"].includes(data?.error) ? `asr_${["not_found", "too_long", "too_large"].includes(data.error) ? "unsupported" : data.error}` : "asr_unavailable");
    if (data?.object_key !== objectKey || !Number.isInteger(data.seconds) || data.seconds < 0) throw new EnrichmentError("asr_invalid_response");
    const validSegments = (segments: any): segments is AsrSegment[] => Array.isArray(segments) && segments.every(s => typeof s?.text === "string" && Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end >= s.start && s.end <= data.seconds + 1);
    if (data.output_format === "manifest") {
      if (data.complete !== true || !Array.isArray(data.parts) || !Number.isInteger(data.segment_count) || data.parts.length > 10000) throw new EnrichmentError("asr_invalid_response");
      const segments: AsrSegment[] = []; const texts: string[] = []; let count = 0;
      const textDigest = createHash("sha256"); let first = true;
      const prefix = objectKey.slice(0, objectKey.lastIndexOf("/") + 1) + "asr-parts/";
      const videoPrefix = objectKey.match(/^(tenants\/[^/]+\/workspaces\/[^/]+\/video\/[A-Za-z0-9_-]{1,100})\/[a-f0-9]{64}\/[A-Za-z0-9_.-]+$/)?.[1];
      for (const part of data.parts as AsrPart[]) {
        const expectedKey = videoPrefix ? `${videoPrefix}/${part.sha256}/asr-part.json` : prefix + part.sha256 + ".json";
        if (part.object_key !== expectedKey || part.object_key.includes("..") || !/^[a-f0-9]{64}$/.test(part.sha256) || !Number.isInteger(part.bytes) || part.bytes > 256 * 1024 + 32 || !Number.isInteger(part.segment_count)) throw new EnrichmentError("asr_invalid_response");
        const page = await (opts.fetchImpl ?? fetch)(new URL("/v1/asr/parts", endpoint), { method: "POST", redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000), headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ object_key: part.object_key, ...scope }) });
        const result = await boundedWorkerJson(page, 256 * 1024 + 32);
        if (!page.ok || result.raw.byteLength !== part.bytes || createHash("sha256").update(result.raw).digest("hex") !== part.sha256 || !validSegments(result.data.segments) || result.data.segments.length !== part.segment_count) throw new EnrichmentError("asr_invalid_response");
        count += result.data.segments.length;
        for (const segment of result.data.segments) { textDigest.update((first ? "" : " ") + segment.text); first = false; }
        if (opts.onPart) await opts.onPart(result.data.segments, part);
        else { segments.push(...result.data.segments); texts.push(...result.data.segments.map((s: AsrSegment) => s.text)); }
      }
      if (count !== data.segment_count || textDigest.digest("hex") !== data.text_sha256) throw new EnrichmentError("asr_invalid_response");
      return { text: opts.onPart ? "" : texts.join(" "), seconds: data.seconds, language: String(data.language ?? ""), digest: data.sha256, segments: opts.onPart ? undefined : segments, parts: data.parts, complete: true, status: data.status };
    }
    // Older workers are accepted only when they explicitly provide all returned
    // segments. New workers reject oversized legacy inline results rather than slice.
    if (typeof data.text !== "string" || !validSegments(data.segments) || data.complete !== true || data.segment_count !== data.segments.length || data.segments.map((s: AsrSegment) => s.text).join(" ").trim() !== data.text) throw new EnrichmentError("asr_invalid_response");
    return { text: data.text, seconds: data.seconds, language: String(data.language ?? ""), digest: typeof data.sha256 === "string" ? data.sha256 : createHash("sha256").update(data.text).digest("hex"), segments: data.segments, complete: data.complete, status: data.status };
  };
}

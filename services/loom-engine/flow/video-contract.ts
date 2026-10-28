import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./errors.ts";

export type VideoScope = { tenant_id: string; workspace_id: string; actor?: { type: string; id: string }; scopes?: string[]; policy_version?: string };
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const canonicalHash = (v: unknown) => sha(JSON.stringify(canonical(v)));
export const newVideoId = (prefix: string) => prefix + randomBytes(12).toString("hex");
export const videoError = (status: number, reason: string) => Object.assign(new HttpError(status, reason), { reason });
export const VIDEO_STATES = ["queued", "running", "retry_wait", "blocked_auth", "blocked_budget", "reconciliation_required", "cancel_requested", "cancelled", "failed", "completed", "completed_with_gaps"] as const;
export const TERMINAL_VIDEO_STATES = ["cancelled", "failed", "completed", "completed_with_gaps"];
export const VIDEO_OBJECT_KEY = /^tenants\/([A-Za-z0-9_-]{1,64})\/workspaces\/([A-Za-z0-9_-]{1,64})\/video\/([A-Za-z0-9_-]{1,80})\/([a-f0-9]{64})\/([A-Za-z0-9_.-]{1,120})$/;
export const isVideoKind = (kind: string) => kind === "bilibili" || kind === "douyin";
export function assertVideoObject(scope: VideoScope, key: string, job?: string) {
  const m = VIDEO_OBJECT_KEY.exec(key);
  if (!m || m[1] !== scope.tenant_id || m[2] !== scope.workspace_id || (job && m[3] !== job) || m[5].includes("..")) throw videoError(403, "SCOPE_DENIED");
}
export type VideoObject = { object_key: string; sha256: string; bytes: number; content_type: string; artifact_type?: string; retention_class?: string };
export type VideoSegment = { text: string; start_ms: number | null; end_ms: number | null; kind?: "subtitle" | "asr" | "ocr" | "observation"; frame_ref?: string; alignment_method?: string };
/** PostgreSQL int8 fields are strings; expose exact, validated JSON milliseconds. */
export function videoEvidenceTime(row: { start_ms?: unknown; end_ms?: unknown }) {
  const parse = (value: unknown): number | null => {
    if (value == null) return null;
    const number = typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw videoError(422, "INVALID_EVIDENCE_TIME");
    return number;
  };
  const start_ms = parse(row.start_ms), end_ms = parse(row.end_ms);
  if ((start_ms === null) !== (end_ms === null) || start_ms !== null && end_ms! < start_ms) throw videoError(422, "INVALID_EVIDENCE_TIME");
  return { start_ms, end_ms };
}
export type VideoManifest = {
  schema_version: 1; artifact_stage: "input_ready" | "processing_complete"; video_job_id: string;
  stage_attempt: number; fencing_token: number; input_kind: "platform_subtitles" | "media";
  input_hash: string; media_sha256: string | null; availability: "not_acquired" | "available";
  parent_manifest_sha256?: string; objects: VideoObject[];
  transcript?: { parts: { object_key: string; sha256: string; segment_count: number; start_ms: number | null; end_ms: number | null }[] };
  coverage: { required: string[]; completed: string[]; missing: string[]; optional_missing?: string[]; duration_ms?: number; [key: string]: unknown };
  processors: Record<string, unknown>; language?: string;
  source_metadata?: Record<string, any> | null; usage?: Record<string, unknown>;
  frames?: { frame_id: string; object_key: string; sha256: string; timestamp_ms: number; media_sha256: string }[];
  visual?: { schema_version: 1; record_count: number; parts: (VideoObject & { record_count: number; start_ms: number; end_ms: number })[] };
};
export function normalizeVideoURL(platform: string, value: string, type: "video" | "account" = "video") {
  if (!isVideoKind(platform)) throw videoError(400, "INVALID_PLATFORM");
  if (typeof value !== "string" || value.length > 4096) throw videoError(400, "INVALID_VIDEO_URL");
  const links = value.trim().match(/https?:\/\/[^\s<>"'，。；！？、（）【】]+/g) ?? [];
  if (links.length !== 1) throw videoError(400, "AMBIGUOUS_VIDEO_URL");
  value = links[0].replace(/[),.;!?]+$/, "");
  let u: URL;
  try { u = new URL(value); } catch { throw videoError(400, "INVALID_VIDEO_URL"); }
  const hosts = platform === "bilibili" ? ["www.bilibili.com", "bilibili.com", "space.bilibili.com", "b23.tv"] : ["www.douyin.com", "douyin.com", "v.douyin.com"];
  if (u.protocol !== "https:" || !hosts.includes(u.hostname.toLowerCase()) || u.username || u.password || u.port) throw videoError(400, "INVALID_VIDEO_URL");
  const part = u.searchParams.get("p");
  if (part !== null && (!/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) > 10000)) throw videoError(400, "INVALID_PART_ID");
  u.hash = ""; u.search = "";
  if (platform === "bilibili" && type === "video" && part && /^[1-9]\d*$/.test(part)) u.searchParams.set("p", part);
  return u.toString();
}
export function canonicalTranscript(title: string, segments: VideoSegment[]) {
  if (!segments.length) throw videoError(422, "INCOMPLETE_ARTIFACT");
  let body = "", previous = -1;
  const spans = segments.map(segment => {
    if (!segment || typeof segment.text !== "string" || !segment.text.trim()) throw videoError(422, "INVALID_SEGMENT");
    const known = segment.start_ms != null || segment.end_ms != null;
    if (known && (!Number.isSafeInteger(segment.start_ms) || !Number.isSafeInteger(segment.end_ms) || segment.start_ms! < 0 || segment.end_ms! < segment.start_ms! || segment.start_ms! < previous)) throw videoError(422, "INVALID_SEGMENT_TIME");
    if (known) previous = segment.start_ms!;
    if (body) body += "\n";
    const char_start = title.length + 2 + body.length;
    body += segment.text;
    return { ...segment, char_start, char_end: title.length + 2 + body.length, alignment_method: segment.alignment_method ?? (known ? "segment" : "unknown") };
  });
  return { body, text: `${title}\n\n${body}`, spans };
}

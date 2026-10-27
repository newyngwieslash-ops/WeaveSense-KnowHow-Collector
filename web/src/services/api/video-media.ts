import { ApiError, compactApiParams, http } from "./request";
import { videoMutationHeaders, type VideoJob, type VideoPage } from "./video-knowledge";

export type VideoMediaDescriptor = { object_id: string | null; content_type: string | null; bytes: number | null; download_path: string | null; available?: boolean; unavailable_reason?: string | null };
export type VisualConflictSide = { text: string; text_sha256: string; start_ms: number; end_ms: number; text_complete: boolean; read_ref: { cursor: string; text_field: "audio" | "visual"; conflict_offset: number; text_offset: number } };
export type VisualConflictCandidate = { relation: "numeric_disagreement_candidate"; review_status: "unreviewed"; truth_status: "not_asserted"; label: string; unit: string; audio_value: string | number; visual_value: string | number; audio: VisualConflictSide; visual: VisualConflictSide };
export type VideoVisualRecord = {
    record_id: string; type: "frame" | "ocr" | "model_observation" | "model_inference" | "alignment";
    start_ms: number | null; end_ms: number | null; frame_id?: string; frame_ids?: string[]; frame_ref_count?: number;
    text?: string; observed_text?: string; derived?: boolean; review_status?: string; text_complete?: boolean;
    text_offset?: number; total_text_chars?: number; next_text_offset?: number | null;
    read_ref: { kind: "visual"; cursor: string; text_offset: number; limit: number; record_id: string; text_field?: "text" | "audio" | "visual"; conflict_offset?: number };
    text_field?: "text" | "audio" | "visual"; conflict_candidates?: VisualConflictCandidate[]; conflict_count?: number; next_conflict_offset?: number | null; conflict_scan?: Record<string, unknown>;
    frame_media?: VideoMediaDescriptor; frame_media_items?: VideoMediaDescriptor[];
    relation?: "temporal_overlap" | "unaligned"; semantic_relation?: string;
    audio_segments?: { start_ms: number; end_ms: number; text_sha256: string }[]; audio_segment_count?: number;
    provenance?: { model_task_count: number; model_tasks: { task_id: string; usage_ref: string; model_config_hash: string }[] };
};
export type VideoTemporalEvidence = { evidence_id: string; document_id: string; revision: number; char_start: number; char_end: number; quote: string | null; quote_excerpt?: string | null; quote_complete: boolean; snippet_hash: string; start_ms: number | null; end_ms: number | null; alignment_method?: string; material_type?: string };
export type VideoResult<T> = VideoPage<T> & { video_job_id: string; complete: boolean; coverage?: Record<string, unknown> };
const resultPath = (id: string) => `/intelligence/video/jobs/${encodeURIComponent(id)}/result`;
const config = (workspaceId: string, signal?: AbortSignal) => ({ headers: { "X-Workspace-Id": workspaceId }, signal });
export const readVideoVisualRecords = (workspaceId: string, id: string, cursor?: string, textOffset?: number, signal?: AbortSignal, continuation?: { conflict_offset: number; text_field: "text" | "audio" | "visual" }) => http.get<VideoResult<VideoVisualRecord>>(resultPath(id), { ...config(workspaceId, signal), params: compactApiParams({ kind: "visual", cursor, text_offset: textOffset, ...continuation, limit: textOffset === undefined && !continuation ? 12 : 1 }) });
export const repairVideoMedia = (workspaceId: string, jobId: string, idempotencyKey: string) => http.post<VideoJob>(`/intelligence/video/jobs/${encodeURIComponent(jobId)}/repair`, {}, videoMutationHeaders(workspaceId, idempotencyKey));
export const readVideoMediaObjects = (workspaceId: string, id: string, cursor?: string, signal?: AbortSignal) => http.get<VideoResult<VideoMediaDescriptor>>(resultPath(id), { ...config(workspaceId, signal), params: compactApiParams({ kind: "media", cursor, limit: 20 }) });
export const readVideoTemporalEvidence = (workspaceId: string, id: string, cursor?: string, signal?: AbortSignal) => http.get<VideoResult<VideoTemporalEvidence>>(resultPath(id), { ...config(workspaceId, signal), params: compactApiParams({ kind: "evidence", cursor, limit: 20 }) });
export type VideoTextSlice = { document_id: string; revision: number; offset: number; text: string; coverage: { total_chars: number; returned_chars: number; next_offset: number | null } };
export async function readVideoEvidenceSlice(workspaceId: string, evidence: VideoTemporalEvidence, offset: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(offset) || offset < evidence.char_start || offset >= evidence.char_end) throw new Error("片段偏移无效");
    const max = Math.min(4000, evidence.char_end - offset);
    const result = await http.post<VideoTextSlice>("/intelligence/documents/read", { document_id: evidence.document_id, revision: evidence.revision, offset, max_chars: max }, config(workspaceId, signal));
    if (result.document_id !== evidence.document_id || result.revision !== evidence.revision || result.offset !== offset || !result.text.length || result.text.length > max) throw new Error("固定修订片段响应不一致，未替换原文");
    return result;
}

/** Only a server-registered opaque ID on this exact host route is playable. No arbitrary URL/key fallback. */
export function safeVideoMediaURL(workspaceId: string, jobId: string, media: VideoMediaDescriptor): string | undefined {
    if (!workspaceId.trim() || !/^[\w-]+$/.test(jobId) || !/^[a-f0-9]{32}$/.test(media.object_id ?? "") || media.available === false || !Number.isSafeInteger(media.bytes) || Number(media.bytes) <= 0) return;
    const mime = media.content_type?.split(";")[0].trim().toLowerCase() ?? "";
    if (!/^(audio|video)\/[a-z0-9.+-]+$/.test(mime) && !["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(mime)) return;
    const path = `/api/intelligence/video/jobs/${jobId}/media/${media.object_id}`;
    if (media.download_path !== path) return;
    return `${path}?workspace_id=${encodeURIComponent(workspaceId)}`;
}
export function describeMediaAccessError(error: unknown) {
    if (error instanceof ApiError) {
        if (error.status === 403) return "媒体访问被拒绝或来源已撤权；已停止播放，不尝试其他地址。";
        if (error.status === 404) return "登记的媒体对象不存在或不可见；不回退到平台或临时对象地址。";
        if (error.status === 410) return "媒体已过期或被清除；文本是否仍可读由独立许可决定。";
        if (error.status === 416) return "媒体范围请求不可满足，请重新加载实际对象记录。";
    }
    return error instanceof Error ? error.message : "媒体读取失败，未回退其他来源";
}
export async function verifyVideoMediaAccess(workspaceId: string, jobId: string, media: VideoMediaDescriptor, signal?: AbortSignal) {
    const url = safeVideoMediaURL(workspaceId, jobId, media);
    if (!url) throw new Error("媒体没有可验证的同源受权地址");
    const bounded = new AbortController();
    const response = await http.raw<ArrayBuffer>({ method: "get", url, baseURL: "", headers: { "X-Workspace-Id": workspaceId, Range: "bytes=0-0" }, responseType: "arraybuffer", timeout: 15000, maxContentLength: 1024, signal: signal ? AbortSignal.any([signal, bounded.signal]) : bounded.signal, onDownloadProgress: progress => { if (progress.loaded > 1024) bounded.abort(); } }).catch(error => {
        if (bounded.signal.aborted && !signal?.aborted) throw new Error("媒体校验响应超出有界范围，已停止读取");
        throw error;
    });
    const mime = String(response.headers["content-type"] ?? "").split(";")[0];
    if (response.status !== 206 || response.data.byteLength !== 1 || mime !== media.content_type?.split(";")[0] || response.headers["content-range"] !== `bytes 0-0/${media.bytes}`) throw new Error("受权媒体范围校验失败，未加载完整媒体");
    return url;
}

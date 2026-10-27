import { compactApiParams, http } from "./request";

/** Workspace is a host selector, not an authorization claim. Go derives delegated scopes. */
const ws = (workspaceId: string, signal?: AbortSignal) => {
    if (!workspaceId.trim()) throw new Error("请先选择工作区");
    return { headers: { "X-Workspace-Id": workspaceId }, signal };
};
const root = "/intelligence/video";
export const videoMutationHeaders = (workspaceId: string, idempotencyKey: string = crypto.randomUUID()) => ({ headers: { ...ws(workspaceId).headers, "X-Idempotency-Key": idempotencyKey } });
const idPath = (id: string) => {
    if (!id.trim()) throw new Error("对象标识不能为空");
    return encodeURIComponent(id);
};
export type VideoPage<T> = { items: T[]; next_cursor?: string | null };
export type VideoProfile = { id: string; name: string; version: number; content_hash: string; config: Record<string, unknown> };
export type VideoJobState = "queued" | "running" | "retry_wait" | "blocked_auth" | "blocked_budget" | "reconciliation_required" | "cancel_requested" | "cancelled" | "failed" | "completed" | "completed_with_gaps";
export type VideoCoverage = { required?: string[]; completed?: string[]; missing?: string[]; optional_missing?: string[]; complete?: boolean; [key: string]: unknown };
export type VideoStage = {
    stage: string; state: string; attempt: number; error?: { code?: string; message?: string } | string | null; next_poll_at?: string | null;
    submission_intent_state?: "none" | "prepared" | "submitted" | "accepted" | "resume_requested" | "terminal" | "unknown";
    external_task_known?: boolean;
    external_observed_state?: "unknown" | "pending" | "completed" | "failed" | "reconciliation_required";
    external_observed_at?: string | null;
};
export type VideoJob = {
    video_job_id: string; operation_id: string; source_id: string; asset_id: string;
    profile_id: string; profile_version: number; state: VideoJobState; stage: string;
    stages: VideoStage[]; completion_level: "pending" | "input_ready" | "knowledge_ready";
    coverage?: VideoCoverage; available_capabilities?: string[]; remote_cancel_status?: "requested" | "confirmed" | "unsupported" | "unknown";
    document_id?: string | null; revision?: number | null; native_id?: string; part_id?: string;
    error?: { code?: string; message?: string } | string | null; created_at?: string; updated_at?: string;
    next_poll_at?: string | null; usage?: Record<string, unknown>; media_availability?: string; publication_state?: string;
};
export type VideoStart = { source_id: string; native_id: string; part_id?: string; canonical_url?: string; content_version?: string; profile_id: string; profile_version: number; required_capabilities?: string[]; processor_version?: string };
export type VideoDiscovery = { operation_id?: string; discovery_id?: string; discovery_handle?: string; items?: { native_id: string; part_id?: string; canonical_url?: string; title?: string; content_version?: string }[]; next_cursor?: string | null; coverage?: Record<string, unknown>; checkpoint?: Record<string, unknown>; state?: string; partial?: boolean; error?: string | null };

export const listVideoProfiles = (workspaceId: string, signal?: AbortSignal) => http.get<VideoPage<VideoProfile>>(`${root}/profiles`, ws(workspaceId, signal));
export const saveVideoProfile = (workspaceId: string, input: { id?: string; expected_version?: number; name: string; config: Record<string, unknown> }) => http.post<VideoProfile>(`${root}/profiles`, input, videoMutationHeaders(workspaceId));
export const listVideoJobs = (workspaceId: string, params: { state?: string; cursor?: string; source_id?: string } = {}, signal?: AbortSignal) => http.get<VideoPage<VideoJob>>(`${root}/jobs`, { ...ws(workspaceId, signal), params: compactApiParams(params) });
export const getVideoJob = (workspaceId: string, id: string, signal?: AbortSignal) => http.get<VideoJob>(`${root}/jobs/${idPath(id)}`, ws(workspaceId, signal));
export const startVideoJob = (workspaceId: string, input: VideoStart, idempotencyKey: string) => {
    if (!idempotencyKey.trim()) throw new Error("提交必须包含恢复键");
    return http.post<VideoJob>(`${root}/jobs`, input, { headers: { ...ws(workspaceId).headers, "X-Idempotency-Key": idempotencyKey } });
};
export const cancelVideoJob = (workspaceId: string, id: string, reason: string) => http.post<VideoJob>(`${root}/jobs/${idPath(id)}/cancel`, { reason }, videoMutationHeaders(workspaceId));
export const retryVideoJob = (workspaceId: string, id: string) => http.post<VideoJob>(`${root}/jobs/${idPath(id)}/retry`, {}, videoMutationHeaders(workspaceId));
export const reconcileVideoJob = (workspaceId: string, input: { video_job_id?: string; idempotency_key?: string }) => http.post<VideoJob>(`${root}/jobs/reconcile`, input, videoMutationHeaders(workspaceId));
export const discoverVideo = (workspaceId: string, input: { source_id: string; limit: number; cursor?: string; window?: { from: string; to: string } }) => http.post<VideoDiscovery>(`${root}/discover`, input, videoMutationHeaders(workspaceId));
export const getVideoDiscovery = (workspaceId: string, operationId: string, signal?: AbortSignal, cursor?: string) => http.get<VideoDiscovery>(`${root}/discover/${idPath(operationId)}`, { ...ws(workspaceId, signal), params: compactApiParams({ cursor, limit: 50 }) });
export const setVideoSourceStatus = (workspaceId: string, id: string, expectedRevision: number, status: "paused" | "active") => http.patch<unknown>(`/intelligence/sources/${idPath(id)}`, { expected_revision: expectedRevision, status }, videoMutationHeaders(workspaceId));
export const runVideoSource = (workspaceId: string, id: string) => http.post<{ operation_id: string; status?: string }>("/intelligence/collection-runs", { source_ids: [id] }, videoMutationHeaders(workspaceId));
export const backfillVideoSource = (workspaceId: string, id: string, input: { from: string; to: string; limit: number }) => http.post<{ operation_id: string; status?: string }>(`${root}/sources/${idPath(id)}/backfill`, input, videoMutationHeaders(workspaceId));
export type VideoDocumentRevision = { document_id: string; revision: number; content_hash: string; title: string; body: string; evidence: { id: string; char_start: number; char_end: number; quote: string }[] };
export const readVideoDocumentRevision = (workspaceId: string, documentId: string, revision: number) => http.get<VideoDocumentRevision>(`/intelligence/documents/${idPath(documentId)}/revisions/${revision}`, ws(workspaceId));
export type VideoCorrectionReceipt = { video_job_id: string; document_id?: string | null; revision: number | null; proposed_revision?: number; previous_revision?: number; state?: VideoJobState; stage?: string; recheck_knowledge_ids?: string[] };
export const correctVideoTranscript = (workspaceId: string, jobId: string, input: { expected_revision: number; expected_content_hash: string; reason: string; patches: { evidence_id: string; text: string }[] }) => http.post<VideoCorrectionReceipt>(`${root}/jobs/${idPath(jobId)}/corrections`, input, videoMutationHeaders(workspaceId));
export const readVideoArtifacts = (workspaceId: string, id: string, cursor?: string, signal?: AbortSignal) => http.get<VideoPage<Record<string, unknown>> & { complete?: boolean; truncated?: boolean }>(`${root}/jobs/${idPath(id)}/artifacts`, { ...ws(workspaceId, signal), params: compactApiParams({ cursor, limit: 20 }) });

export type VideoScheduleInput = { source_ids: string[]; interval_seconds?: number; cron?: string; timezone: string; misfire_policy: "skip" | "coalesce" | "catch_up"; budget_micro_per_window: number };
export const createVideoSchedule = (workspaceId: string, input: VideoScheduleInput) => http.post<{ id: string }>("/intelligence/schedules", input, ws(workspaceId));
export const setVideoScheduleEnabled = (workspaceId: string, id: string, expectedRevision: number, enabled: boolean) => http.patch<unknown>(`/intelligence/schedules/${idPath(id)}`, { enabled, expected_revision: expectedRevision }, videoMutationHeaders(workspaceId));

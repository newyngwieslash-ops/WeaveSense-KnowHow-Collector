import { http } from "./request";
import { videoMutationHeaders } from "./video-knowledge";

export type VideoRetentionAction = "subscription_paused" | "media_expired" | "remote_unavailable" | "revoked" | "erased";
export type VideoRetentionTarget = { source_id: string; asset_id?: never } | { asset_id: string; source_id?: never };
export type VideoRetentionPreview = {
    action: VideoRetentionAction; target: VideoRetentionTarget; preview_hash: string; truncated: false; limit_per_category: number;
    counts: Record<string, number>; dependencies: Record<string, Array<Record<string, string | number | boolean | null>>>;
    current_visibility: { access_revoked_documents: number; remaining_documents_require_live_authorization: number; published_knowledge: number; active_skill_candidates: number };
    after_action: { source_status_changes: boolean; knowledge_revoked: boolean; historical_content_access: string; content_erased: boolean; historical_run_pins: string; unrelated_canvas_messages_finances: string };
    audit_retained: Record<string, boolean | string>;
    physical_cleanup: { pending: number; deleted: number; will_request: number; completion: string };
};
export type VideoRetentionCommand = VideoRetentionTarget & { action: VideoRetentionAction; reason: string; expected_impact_hash: string; idempotency_key: string; confirmation?: VideoRetentionAction };
export type VideoRetentionBatch = { partial: boolean; audit_retained: true; results: Array<{ target: VideoRetentionTarget; action: VideoRetentionAction; idempotency_key: string; ok: boolean; reason?: string; status?: number; data?: { action: VideoRetentionAction; knowledge_revoked: boolean; physical_cleanup?: string; asset_ids?: string[]; knowledge_ids?: string[]; skill_candidate_ids?: string[] } }> };
export const previewVideoRetention = (workspaceId: string, action: VideoRetentionAction, target: VideoRetentionTarget) => http.post<VideoRetentionPreview>("/intelligence/video/retention/preview", { action, ...target }, videoMutationHeaders(workspaceId));
export const applyVideoRetentionBatch = (workspaceId: string, items: VideoRetentionCommand[], requestKey: string) => http.post<VideoRetentionBatch>("/intelligence/video/retention/batch", { items }, videoMutationHeaders(workspaceId, requestKey));

import { compactApiParams, http } from "./request";
import { videoMutationHeaders, type VideoPage } from "./video-knowledge";
import type { VideoTextSlice } from "./video-media";

export type OriginMaterialRef = { document_id: string; revision: number; asset_id: string; revision_hash: string; origin_cluster: string | null };
export type VideoOriginCandidate = { id: string; state: "pending" | "same_origin" | "independent" | "unavailable"; content_hash: string; unavailable?: boolean; proposal?: { left: OriginMaterialRef; right: OriginMaterialRef; score: number; baseline: Record<string, unknown>; evidence_kind: "normalized_text_match" | "near_duplicate_text"; requires_human_review: true }; review?: Record<string, unknown> };
export const listVideoOriginCandidates = (workspaceId: string, state?: string, cursor?: string, signal?: AbortSignal) => http.get<VideoPage<VideoOriginCandidate> & { baseline: Record<string, unknown> }>("/intelligence/knowledge/origin-candidates", { headers: { "X-Workspace-Id": workspaceId }, signal, params: compactApiParams({ state, cursor, limit: 20 }) });
export const reviewVideoOriginCandidate = (workspaceId: string, candidate: VideoOriginCandidate, input: { decision: "same_origin" | "independent"; reason: string; origin_cluster?: string }) => http.post<VideoOriginCandidate>(`/intelligence/knowledge/origin-candidates/${encodeURIComponent(candidate.id)}/review`, { expected_hash: candidate.content_hash, ...input }, videoMutationHeaders(workspaceId));
export async function readOriginMaterial(workspaceId: string, ref: OriginMaterialRef, offset: number, signal?: AbortSignal) {
    const result = await http.post<VideoTextSlice>("/intelligence/documents/read", { document_id: ref.document_id, revision: ref.revision, offset, max_chars: 2000 }, { headers: { "X-Workspace-Id": workspaceId }, signal });
    if (result.document_id !== ref.document_id || result.revision !== ref.revision || result.offset !== offset || result.text.length > 2000) throw new Error("来源修订或分页响应不一致");
    return result;
}

import { compactApiParams, http } from "./request";
import { videoMutationHeaders, type VideoPage } from "./video-knowledge";

const root = "/intelligence/knowledge";
const ws = (workspaceId: string, signal?: AbortSignal) => ({ headers: { "X-Workspace-Id": workspaceId }, signal });
export type KnowledgeExtractionRun = { id: string; video_job_id: string; document_id: string; revision: number; profile_id: string; profile_version: number; state: string; input_hash: string; candidate_ids: string[]; batch_cursor?: number; error?: { code?: string; message?: string } | string | null };
export const listKnowledgeExtractions = (workspaceId: string, videoJobId: string, signal?: AbortSignal) => http.get<VideoPage<KnowledgeExtractionRun>>(`${root}/extractions`, { ...ws(workspaceId, signal), params: { video_job_id: videoJobId, limit: 30 } });
export type KnowledgeState = "candidate" | "in_review" | "approved" | "published" | "rejected" | "withdrawn" | "superseded";
export type EvidenceSnapshot = {
    evidence_id: string; document_id: string; revision: number; snippet_hash: string; quote: string; char_start: number; char_end: number;
    title: string; body: string; source_id: string; url?: string; material_type: string; asset_id?: string; availability?: string;
    start_ms: number | null; end_ms: number | null; frame_ref?: string | null; alignment_method: string; origin_cluster?: string | null; video_job_id?: string | null;
};
export type KnowledgeUnit = {
    type: string; title: string; domain_tags: string[]; statement: string;
    claim_kind: "source_statement" | "observation" | "model_inference" | "cross_source_verified";
    applicability: string[]; conditions: string[]; steps: string[]; parameters: { name: string; value: string | null; unit: string | null; conditions: string[] }[];
    boundaries: string[]; counterexamples: string[]; missing_fields: string[];
    evidence: { evidence_id: string; revision: number; snippet_hash: string }[];
    valid_from: string | null; valid_until: string | null; conflict_key: string | null;
};
export type KnowledgeRecord = { id: string; version: number; content_hash: string; state: KnowledgeState; unit: KnowledgeUnit; profile_id: string; profile_version: number; evidence?: EvidenceSnapshot[]; approval?: Record<string, unknown> | null; release_id?: string | null; reviews?: Record<string, unknown>[]; unavailable?: boolean };
export const listVideoKnowledge = (workspaceId: string, params: { state?: string; profile_id?: string; cursor?: string } = {}, signal?: AbortSignal) => http.get<VideoPage<KnowledgeRecord>>(root, { ...ws(workspaceId, signal), params: compactApiParams({ ...params, limit: 30 }) });
export const searchPublishedKnowledge = (workspaceId: string, q: string, signal?: AbortSignal, cursor?: string) => http.post<VideoPage<KnowledgeRecord>>(`${root}/search`, { q, limit: 30, ...(cursor ? { cursor } : {}) }, ws(workspaceId, signal));
export const getVideoKnowledge = (workspaceId: string, id: string, signal?: AbortSignal, mode: "published" | "review" = "published") => http.get<KnowledgeRecord>(`${root}/${encodeURIComponent(id)}`, { ...ws(workspaceId, signal), params: mode === "review" ? { mode: "review" } : {} });
const expected = (record: KnowledgeRecord) => ({ expected_version: record.version, expected_hash: record.content_hash });
export const editVideoKnowledge = (workspaceId: string, record: KnowledgeRecord, unit: KnowledgeUnit) => http.patch<KnowledgeRecord>(`${root}/${encodeURIComponent(record.id)}`, { ...expected(record), unit }, videoMutationHeaders(workspaceId));
export const reviewVideoKnowledge = (workspaceId: string, record: KnowledgeRecord, decision: "submit" | "approve" | "reject" | "request_changes", reason: string, checks?: { evidence_support: boolean; critical_fields: boolean }) => http.post<KnowledgeRecord>(`${root}/${encodeURIComponent(record.id)}/review`, { ...expected(record), decision, reason, ...(checks ? { checks } : {}) }, videoMutationHeaders(workspaceId));
export const publishVideoKnowledge = (workspaceId: string, record: KnowledgeRecord, reason: string) => http.post<KnowledgeRecord>(`${root}/${encodeURIComponent(record.id)}/publish`, { ...expected(record), reason }, videoMutationHeaders(workspaceId));
export const withdrawVideoKnowledge = (workspaceId: string, record: KnowledgeRecord, reason: string) => http.post<KnowledgeRecord>(`${root}/${encodeURIComponent(record.id)}/withdraw`, { ...expected(record), reason }, videoMutationHeaders(workspaceId));

export type SkillCandidateState = "draft" | "evaluation_running" | "passed" | "approved_for_release" | "release_package_exported" | "deployed" | "workspace_installed" | "rejected" | "retired";
export type SkillCandidate = { id: string; state: SkillCandidateState; candidate_hash: string; native_skill_hash: string; proposal: Record<string, unknown> | null; eval_result?: Record<string, unknown> | null; approval?: Record<string, unknown> | null; receipts?: Record<string, unknown>[]; release_package?: Record<string, unknown> | null; unavailable?: boolean; dependency_status?: string };
const skills = "/intelligence/video/skill-candidates";
export const listVideoSkillCandidates = (workspaceId: string, signal?: AbortSignal, cursor?: string) => http.get<VideoPage<SkillCandidate>>(skills, { ...ws(workspaceId, signal), params: compactApiParams({ limit: 30, cursor }) });
export const getVideoSkillCandidate = (workspaceId: string, id: string, signal?: AbortSignal) => http.get<SkillCandidate>(`${skills}/${encodeURIComponent(id)}`, ws(workspaceId, signal));
export const createVideoSkillCandidate = (workspaceId: string, proposal: Record<string, unknown>) => http.post<SkillCandidate>(skills, proposal, videoMutationHeaders(workspaceId));
export const requestVideoSkillEvaluation = (workspaceId: string, candidate: SkillCandidate) => http.post<SkillCandidate>(`${skills}/${encodeURIComponent(candidate.id)}/evaluation-request`, { expected_hash: candidate.candidate_hash }, videoMutationHeaders(workspaceId));
export const reviewVideoSkillCandidate = (workspaceId: string, candidate: SkillCandidate, decision: "approve" | "reject", reason: string) => http.post<SkillCandidate>(`${skills}/${encodeURIComponent(candidate.id)}/review`, { expected_hash: candidate.candidate_hash, decision, reason }, videoMutationHeaders(workspaceId));
export const exportVideoSkillCandidate = (workspaceId: string, candidate: SkillCandidate) => http.post<Record<string, unknown>>(`${skills}/${encodeURIComponent(candidate.id)}/export`, { expected_hash: candidate.candidate_hash }, videoMutationHeaders(workspaceId));
export const installVideoSkillCandidate = (workspaceId: string, candidate: SkillCandidate, skill: { id: string; version: string }, expectedInstallHash?: string) => http.post<{ installed: { skillId: string; version: string; hash: string }; receipt_status: string; receipt_operation_id: string; deployment: string; run_pins_unchanged: boolean }>(`${skills}/${encodeURIComponent(candidate.id)}/install`, { skill_id: skill.id, version: skill.version, hash: candidate.native_skill_hash, expected_hash: candidate.candidate_hash, ...(expectedInstallHash ? { expected_install_hash: expectedInstallHash } : {}) }, videoMutationHeaders(workspaceId));

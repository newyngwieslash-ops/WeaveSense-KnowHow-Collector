import { compactApiParams, http } from "./request";

export type VideoMetricRecord = { video_job_id: string; profile_id: string; profile_version: number; profile_hash: string; platform: string; state: string; media_sha256: string | null; models: Record<string, string>; processor_fingerprint: string; audio_processed_ratio: number | null; visual_sample_count: number | null; visual_samples_per_minute: number | null; visual_budget_limited: boolean | null; full_frame_analysis: boolean; cache_hit: boolean; reused_from_job_id: string | null; cost_micro: number | null; cost_status: string; cost_micro_per_media_minute: number | null };
export type VideoMetricGroup = { profile_id: string; profile_version: number; profile_hash: string; processor_fingerprint: string; models: Record<string, string>; sample_count: number; pipeline_completed: number; cache_hits: number; known_cost_jobs: number; unknown_cost_jobs: number; settled_cost_micro: number; audio_measured_jobs: number; visual_measured_jobs: number };
export type VideoOperationalMetrics = {
    scope: string; stages: Array<{ stage: string; state: string; count: number; observed_count: number; observed_since: string | null; rate_limit_events: number; auth_required_events: number; duration_samples: number; mean_wall_duration_ms: number | null; oldest_wait_ms: number | null }>;
    ready_latency: { samples: number; mean_ms: number | null; max_ms: number | null }; needs_auth_current: number; completed_with_gaps: number;
    duplicate_suppression: { distinct_request_keys: number; distinct_jobs: number; collapsed_request_keys: number; same_key_replays: number | null };
    discovery: { runs: number; accepted_page_items: number; newly_registered_unique_assets: number; partial_runs: number; mean_finished_wall_ms: number | null }; definitions: Record<string, string>;
};
export type VideoGovernanceMetrics = {
    citation_support: { units: number; units_with_current_evidence_links: number; units_without_current_evidence_links: number; units_with_explicit_support_review: number; model_inference_units: number; semantic_support_accuracy: number | null };
    review_revision: { revised_units: number; additional_versions: number; events_in_window: Record<string, number> };
    source_independence: { candidate_states: Record<string, number>; cross_source_verified_claims: number; calibrated_accuracy: number | null };
    failure_recovery: { jobs: number; observed_failure_jobs: number; completed_after_observed_failure: number; multiple_stage_attempt_jobs: number; unknown_outcomes_current: number }; definitions: Record<string, string>;
};
export type VideoMetrics = { window: { from: string; to: string }; total_matching_jobs: number; sample_count: number; sample_limit: number; sample_truncated: boolean; sample_strategy: string; aggregates_apply_to: string; groups: VideoMetricGroup[]; records: VideoMetricRecord[]; knowledge_review_counts: Record<string, number>; knowledge_review_count_scope: string; operational?: VideoOperationalMetrics; governance?: VideoGovernanceMetrics; quality: { status: string; accuracy: number | null; labelled_sample_count: number | null; suggested_baseline: string[] }; definitions: Record<string, string> };
export const readVideoMetrics = (workspaceId: string, params: { from?: string; to?: string; profile_id?: string } = {}, signal?: AbortSignal) => http.get<VideoMetrics>("/intelligence/video/metrics", { headers: { "X-Workspace-Id": workspaceId }, signal, params: compactApiParams(params) });

import type { Engine } from "./engine.ts";
import type { VideoScope } from "./video-contract.ts";
import { canonicalHash, videoError } from "./video-contract.ts";
import { assertVideoRetentionJournal } from "./video-journal.ts";

const MAX_COHORT = 500;
const DAY = 86_400_000;
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const integer = (v: unknown) => Number.isSafeInteger(Number(v)) && Number(v) >= 0 && v !== null && v !== undefined && v !== "" ? Number(v) : null;

/** Union coverage, not sum: overlapping chunks must never inflate coverage. */
export function coveredMilliseconds(value: unknown, duration: unknown): number | null {
  const d = number(duration);
  if (!d || !Array.isArray(value) || value.length > 10_000) return null;
  const intervals: number[][] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || number(item[0]) === null || number(item[1]) === null || item[0] > item[1] || item[1] > d) return null;
    intervals.push([item[0], item[1]]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let end = 0, count = 0;
  for (const [a, b] of intervals) { count += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  return count;
}

export function videoMetricRecord(row: any) {
  const coverage = row.coverage && typeof row.coverage === "object" ? row.coverage : {};
  const duration = number(coverage.duration_ms) ?? integer(row.actual_media_ms);
  const settled = !!row.budget_closed_at && !!row.budget_reservation_id;
  const cost = settled ? integer(row.actual_usage_micro) : null;
  const processed = coveredMilliseconds(coverage.intervals?.processed, duration);
  const speech = coveredMilliseconds(coverage.intervals?.speech, duration);
  const visual = coverage.visual;
  const timestamps = Array.isArray(visual?.sampled_timestamps_ms) && visual.sampled_timestamps_ms.length <= 10_000
    && visual.sampled_timestamps_ms.every((n: unknown) => number(n) !== null && (duration === null || Number(n) <= duration))
    ? [...new Set<number>(visual.sampled_timestamps_ms)] : null;
  const config = row.config ?? {};
  const models = Object.fromEntries(["embedding_model_id", "vlm_model_id", "summary_model_id", "asr_model_id"].filter(k => typeof config[k] === "string").map(k => [k, config[k]]));
  const processors = row.processors ?? {};
  const usage = row.measured_usage ?? {};
  return {
    video_job_id: row.id, profile_id: row.profile_id, profile_version: Number(row.profile_version), profile_hash: row.profile_hash,
    platform: row.platform, processing_mode: config.processing_mode ?? "subtitles_first", state: row.state,
    media_sha256: row.media_sha256 ?? null, input_manifest_sha256: row.input_manifest_sha256 ?? null,
    processing_manifest_sha256: row.processing_manifest_sha256 ?? null,
    // No raw processor responses, transcripts, model prompts, URLs or credentials.
    models, processor_fingerprint: canonicalHash(processors), duration_ms: duration,
    pipeline_completed: ["completed", "completed_with_gaps"].includes(row.state),
    required_capabilities_missing: Array.isArray(coverage.missing) ? coverage.missing.filter((x: unknown) => typeof x === "string") : null,
    audio_processed_ms: processed, audio_processed_ratio: processed !== null && duration ? processed / duration : null,
    speech_evidence_ms: speech, transcript_status: typeof coverage.transcript_status === "string" ? coverage.transcript_status : null,
    visual_sample_count: timestamps?.length ?? null,
    visual_samples_per_minute: timestamps && duration ? timestamps.length * 60000 / duration : null,
    visual_budget_limited: typeof visual?.budget_limited === "boolean" ? visual.budget_limited : null,
    full_frame_analysis: visual?.full_frame_analysis === true,
    cache_hit: !!row.reused_from_job_id, reused_from_job_id: row.reused_from_job_id ?? null,
    measured_execution: {
      seconds_total: number(usage.execution_seconds_total), quanta: integer(usage.execution_quanta),
      asr_chunk_cache_hits: integer(usage.asr_chunk_cache_hits), ocr_cache_hits: integer(usage.ocr_cache_hits),
      model_result_cache_hits: integer(usage.model_result_cache_hits), temporary_peak_bytes_observed: integer(usage.temporary_peak_bytes_observed),
      source: "accepted processing manifest worker measurements; not financial or quality authority",
    },
    cost_micro: cost, cost_status: cost === null ? "unknown_or_unsettled" : "host_settled",
    cost_micro_per_media_minute: cost !== null && duration ? cost * 60000 / duration : null,
  };
}

/** Bounded operational read model; quality needs independently labelled samples. */
export async function videoMetrics(engine: Engine, scope: VideoScope, opts: { from?: string; to?: string; profile_id?: string } = {}) {
  await assertVideoRetentionJournal(engine, scope);
  const to = opts.to === undefined ? engine.now().getTime() : Date.parse(opts.to);
  const from = opts.from === undefined ? to - 7 * DAY : Date.parse(opts.from);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 90 * DAY || (opts.profile_id !== undefined && (!opts.profile_id || opts.profile_id.length > 120))) throw videoError(400, "INVALID_METRICS_WINDOW");
  const params = [scope.tenant_id, scope.workspace_id, new Date(from).toISOString(), new Date(to).toISOString(), opts.profile_id ?? null, engine.now().toISOString()];
  // Explicit scope predicates even under RLS; source expiry and tombstones are
  // checked again at read time. Metadata is not a way around revocation.
  const where = `j.tenant_id=$1 AND j.workspace_id=$2 AND j.created_at>=$3 AND j.created_at<$4 AND ($5::text IS NULL OR j.profile_id=$5)
    AND a.revoked_at IS NULL AND s.status<>'revoked'
    AND (s.config->>'authorization_expires_at' IS NULL OR (s.config->>'authorization_expires_at')::timestamptz>$6)`;
  const joins = `FROM flow_video_jobs j JOIN flow_video_assets a ON a.tenant_id=j.tenant_id AND a.workspace_id=j.workspace_id AND a.id=j.asset_id
    JOIN flow_sources s ON s.tenant_id=j.tenant_id AND s.workspace_id=j.workspace_id AND s.id=j.source_id`;
  return engine.db.tx(async q => {
    const total = Number((await q.query(`SELECT count(*)::bigint n ${joins} WHERE ${where}`, params)).rows[0]?.n ?? 0);
    const rows = (await q.query(`SELECT j.id,j.profile_id,j.profile_version,j.state,j.coverage,j.reused_from_job_id,j.actual_usage_micro,j.budget_closed_at,j.budget_reservation_id,
      j.input_manifest_sha256,j.processing_manifest_sha256,j.verified_media_sha256 AS media_sha256,a.platform,p.config,p.content_hash AS profile_hash,
      m.manifest->'processors' AS processors,m.manifest->'usage' AS measured_usage,r.actual_media_ms ${joins}
      JOIN flow_video_profiles p ON p.tenant_id=j.tenant_id AND p.workspace_id=j.workspace_id AND p.id=j.profile_id AND p.version=j.profile_version
      LEFT JOIN flow_video_manifests m ON m.tenant_id=j.tenant_id AND m.workspace_id=j.workspace_id AND m.video_job_id=j.id AND m.artifact_stage='processing_complete'
      LEFT JOIN flow_video_resource_admissions r ON r.tenant_id=j.tenant_id AND r.workspace_id=j.workspace_id AND r.video_job_id=j.id
      WHERE ${where} ORDER BY j.created_at DESC,j.id DESC LIMIT ${MAX_COHORT}`, params)).rows;
    const records = rows.map(videoMetricRecord);
    // Audit-only aggregates may include revoked jobs; no source titles, keys,
    // quotes or references are exposed through these operational counters.
    const operationalWhere = `j.tenant_id=$1 AND j.workspace_id=$2 AND j.created_at>=$3 AND j.created_at<$4 AND ($5::text IS NULL OR j.profile_id=$5)`;
    const operationalParams = params.slice(0, 5);
    const stages = (await q.query(`SELECT st.stage,st.state,count(*)::int n,
      count(st.observed_since)::int observed_count,min(st.observed_since) AS observed_since,
      coalesce(sum(st.rate_limit_events),0)::bigint rate_limit_events,coalesce(sum(st.auth_required_events),0)::bigint auth_required_events,
      count(*) FILTER(WHERE st.first_started_at IS NOT NULL AND st.last_finished_at>=st.first_started_at)::int duration_samples,
      avg(extract(epoch FROM st.last_finished_at-st.first_started_at)*1000) FILTER(WHERE st.last_finished_at>=st.first_started_at)::float8 wall_duration_ms,
      max(extract(epoch FROM now()-st.queued_at)*1000) FILTER(WHERE st.state IN ('queued','retry_wait','awaiting_input') AND st.queued_at IS NOT NULL)::float8 oldest_wait_ms
      FROM flow_video_stages st JOIN flow_video_jobs j ON j.tenant_id=st.tenant_id AND j.workspace_id=st.workspace_id AND j.id=st.video_job_id
      WHERE ${operationalWhere} GROUP BY st.stage,st.state ORDER BY st.stage,st.state`, operationalParams)).rows;
    const ready = (await q.query(`SELECT count(*) FILTER(WHERE j.completion_level='knowledge_ready' AND j.finished_at>=j.created_at)::int samples,
      avg(extract(epoch FROM j.finished_at-j.created_at)*1000) FILTER(WHERE j.completion_level='knowledge_ready' AND j.finished_at>=j.created_at)::float8 mean_ms,
      max(extract(epoch FROM j.finished_at-j.created_at)*1000) FILTER(WHERE j.completion_level='knowledge_ready' AND j.finished_at>=j.created_at)::float8 max_ms,
      count(*) FILTER(WHERE j.state='blocked_auth')::int needs_auth,
      count(*) FILTER(WHERE j.state='completed_with_gaps')::int completed_with_gaps
      FROM flow_video_jobs j WHERE ${operationalWhere}`, operationalParams)).rows[0];
    const duplicate = (await q.query(`SELECT count(*)::int requests,count(DISTINCT r.video_job_id)::int jobs
      FROM flow_video_requests r JOIN flow_video_jobs j ON j.tenant_id=r.tenant_id AND j.workspace_id=r.workspace_id AND j.id=r.video_job_id
      WHERE ${operationalWhere}`, operationalParams)).rows[0];
    const discovery = (await q.query(`SELECT count(*)::int runs,coalesce(sum(r.items_new),0)::int accepted_items,
      count(*) FILTER(WHERE r.status='partial')::int partial_runs,
      avg(extract(epoch FROM r.finished_at-r.created_at)*1000) FILTER(WHERE r.finished_at>=r.created_at)::float8 finished_wall_ms
      FROM flow_collection_runs r JOIN flow_sources s ON s.tenant_id=r.tenant_id AND s.workspace_id=r.workspace_id AND s.id=r.source_id
      WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.created_at>=$3 AND r.created_at<$4 AND s.kind IN ('bilibili','douyin')
      AND ($5::text IS NULL OR coalesce(r.video_source_config->>'profile_id',s.config->>'profile_id')=$5)`, operationalParams)).rows[0];
    const newAssets = (await q.query(`SELECT count(DISTINCT a.id)::int n FROM flow_video_assets a
      JOIN flow_video_asset_sources x ON x.tenant_id=a.tenant_id AND x.workspace_id=a.workspace_id AND x.asset_id=a.id
      JOIN flow_sources s ON s.tenant_id=x.tenant_id AND s.workspace_id=x.workspace_id AND s.id=x.source_id
      WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.created_at>=$3 AND a.created_at<$4 AND ($5::text IS NULL OR s.config->>'profile_id'=$5)`, operationalParams)).rows[0];
    const review = (await q.query(`SELECT state,count(*)::int n FROM flow_knowledge_units WHERE tenant_id=$1 AND workspace_id=$2 AND created_at>=$3 AND created_at<$4 AND ($5::text IS NULL OR profile_id=$5) GROUP BY state`, params.slice(0, 5))).rows;
    const citation = (await q.query(`SELECT count(*)::int units,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM flow_knowledge_evidence_refs e WHERE e.tenant_id=u.tenant_id AND e.workspace_id=u.workspace_id AND e.knowledge_id=u.id AND e.version=u.version))::int linked_units,
      count(*) FILTER(WHERE u.version>1)::int revised_units,
      coalesce(sum(u.version-1),0)::int additional_versions,
      count(*) FILTER(WHERE v.unit->>'claim_kind'='model_inference')::int model_inference_units,
      count(*) FILTER(WHERE v.unit->>'claim_kind'='cross_source_verified')::int cross_source_claims,
      count(*) FILTER(WHERE u.approval->'checks'->>'evidence_support'='true' AND u.approval->>'content_hash'=u.content_hash)::int support_reviewed_units
      FROM flow_knowledge_units u JOIN flow_knowledge_versions v ON v.tenant_id=u.tenant_id AND v.workspace_id=u.workspace_id AND v.knowledge_id=u.id AND v.version=u.version
      WHERE u.tenant_id=$1 AND u.workspace_id=$2 AND u.created_at>=$3 AND u.created_at<$4 AND ($5::text IS NULL OR u.profile_id=$5)`, operationalParams)).rows[0];
    const reviewEvents = (await q.query(`SELECT r.decision,count(*)::int n FROM flow_knowledge_reviews r JOIN flow_knowledge_units u ON u.tenant_id=r.tenant_id AND u.workspace_id=r.workspace_id AND u.id=r.knowledge_id
      WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.created_at>=$3 AND r.created_at<$4 AND ($5::text IS NULL OR u.profile_id=$5) GROUP BY r.decision`, operationalParams)).rows;
    const origins = (await q.query(`SELECT c.state,count(*)::int n FROM flow_video_origin_candidates c
      WHERE c.tenant_id=$1 AND c.workspace_id=$2 AND c.created_at>=$3 AND c.created_at<$4 AND ($5::text IS NULL OR EXISTS(
        SELECT 1 FROM flow_video_jobs j WHERE j.tenant_id=c.tenant_id AND j.workspace_id=c.workspace_id AND j.profile_id=$5 AND j.asset_id IN(c.left_asset_id,c.right_asset_id))) GROUP BY c.state`, operationalParams)).rows;
    const recovery = (await q.query(`SELECT count(*)::int jobs,
      count(*) FILTER(WHERE j.state='reconciliation_required')::int unknown_outcomes,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM flow_video_stages st WHERE st.tenant_id=j.tenant_id AND st.workspace_id=j.workspace_id AND st.video_job_id=j.id AND st.failure_events>0))::int observed_failure_jobs,
      count(*) FILTER(WHERE j.state IN ('completed','completed_with_gaps') AND EXISTS(SELECT 1 FROM flow_video_stages st WHERE st.tenant_id=j.tenant_id AND st.workspace_id=j.workspace_id AND st.video_job_id=j.id AND st.failure_events>0))::int recovered_jobs,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM flow_video_stages st WHERE st.tenant_id=j.tenant_id AND st.workspace_id=j.workspace_id AND st.video_job_id=j.id AND st.attempt>1))::int multiple_attempt_jobs
      FROM flow_video_jobs j WHERE ${operationalWhere}`, operationalParams)).rows[0];
    const groups = new Map<string, any>();
    for (const r of records) {
      const key = `${r.profile_id}:${r.profile_version}:${r.processor_fingerprint}`;
      const g = groups.get(key) ?? { profile_id: r.profile_id, profile_version: r.profile_version, profile_hash: r.profile_hash, models: r.models,
        processor_fingerprint: r.processor_fingerprint, sample_count: 0, pipeline_completed: 0, cache_hits: 0, known_cost_jobs: 0, unknown_cost_jobs: 0, settled_cost_micro: 0, priced_media_ms: 0,
        audio_measured_jobs: 0, visual_measured_jobs: 0 };
      g.sample_count++; if (r.pipeline_completed) g.pipeline_completed++; if (r.cache_hit) g.cache_hits++;
      if (r.cost_micro === null) g.unknown_cost_jobs++; else { g.known_cost_jobs++; g.settled_cost_micro += r.cost_micro; if (r.duration_ms) g.priced_media_ms += r.duration_ms; }
      if (r.audio_processed_ratio !== null) g.audio_measured_jobs++; if (r.visual_sample_count !== null) g.visual_measured_jobs++;
      groups.set(key, g);
    }
    return { schema_version: 1, window: { from: params[2], to: params[3] }, total_matching_jobs: total, sample_count: records.length,
      sample_limit: MAX_COHORT, sample_truncated: total > records.length, sample_strategy: "latest_created_desc", aggregates_apply_to: "returned_sample_only",
      groups: [...groups.values()], records, knowledge_review_counts: Object.fromEntries(review.map(r => [r.state, Number(r.n)])),
      operational: {
        scope: "all matching job audit metadata in window/profile, including revoked materials; no material access granted",
        stages: stages.map(s => ({ stage: s.stage, state: s.state, count: Number(s.n), observed_count: Number(s.observed_count), observed_since: s.observed_since,
          rate_limit_events: Number(s.rate_limit_events), auth_required_events: Number(s.auth_required_events), duration_samples: Number(s.duration_samples),
          mean_wall_duration_ms: s.wall_duration_ms === null ? null : Number(s.wall_duration_ms), oldest_wait_ms: s.oldest_wait_ms === null ? null : Math.max(0, Number(s.oldest_wait_ms)) })),
        ready_latency: { samples: Number(ready.samples), mean_ms: ready.mean_ms === null ? null : Number(ready.mean_ms), max_ms: ready.max_ms === null ? null : Number(ready.max_ms) },
        needs_auth_current: Number(ready.needs_auth), completed_with_gaps: Number(ready.completed_with_gaps),
        duplicate_suppression: { distinct_request_keys: Number(duplicate.requests), distinct_jobs: Number(duplicate.jobs), collapsed_request_keys: Math.max(0, Number(duplicate.requests) - Number(duplicate.jobs)), same_key_replays: null },
        discovery: { runs: Number(discovery.runs), accepted_page_items: Number(discovery.accepted_items), newly_registered_unique_assets: Number(newAssets.n), partial_runs: Number(discovery.partial_runs), mean_finished_wall_ms: discovery.finished_wall_ms === null ? null : Number(discovery.finished_wall_ms) },
        definitions: { stage_duration: "first observed start to latest terminal transition wall time, including retries/waits; not CPU time", error_counts: "persisted distinct stage/state/error transitions since observed_since, not HTTP request count; pre-migration history unknown", discovery: "accepted page items may include prior assets; unique first registrations reported separately", ready_latency: "job creation to knowledge_ready; not publication latency or content quality", duplicate_suppression: "different durable request keys resolving to one job; identical-key retries not measured" },
      },
      knowledge_review_count_scope: "current unit states created in selected window/profile; operational counts, not content or quality scores",
      governance: {
        citation_support: { units: Number(citation.units), units_with_current_evidence_links: Number(citation.linked_units), units_without_current_evidence_links: Number(citation.units)-Number(citation.linked_units), units_with_explicit_support_review: Number(citation.support_reviewed_units), model_inference_units: Number(citation.model_inference_units), semantic_support_accuracy: null },
        review_revision: { revised_units: Number(citation.revised_units), additional_versions: Number(citation.additional_versions), events_in_window: Object.fromEntries(reviewEvents.map(r => [r.decision, Number(r.n)])) },
        source_independence: { candidate_states: Object.fromEntries(origins.map(r => [r.state, Number(r.n)])), cross_source_verified_claims: Number(citation.cross_source_claims), calibrated_accuracy: null },
        failure_recovery: { jobs: Number(recovery.jobs), observed_failure_jobs: Number(recovery.observed_failure_jobs), completed_after_observed_failure: Number(recovery.recovered_jobs), multiple_stage_attempt_jobs: Number(recovery.multiple_attempt_jobs), unknown_outcomes_current: Number(recovery.unknown_outcomes) },
        definitions: { citation: "evidence-link completeness and explicit reviewer checks, not independently scored semantic support", independence: "human origin dispositions and governed claim labels, not account-count independence", recovery: "durable transitions observed since telemetry migration; old failure history is unknown, unknown outcomes are not safe retries" },
      },
      quality: { status: "requires_independent_human_labels", accuracy: null, labelled_sample_count: null,
        suggested_baseline: ["stratify by platform/profile/model/media version", "subtitle/no-subtitle/long/silent-visual/noisy/repost samples", "separate transcript completeness, visual support and knowledge-review correctness", "publish denominators and reviewer disagreement, not task success as accuracy"] },
      definitions: { audio_processed_ratio: "union of processed time intervals / known duration; not transcript accuracy", visual_samples_per_minute: "sample density, not full visual coverage", cost_micro: "closed host reservation only; unknown is not zero", cache_hit: "exact coordinator reuse of accepted prior processing revision" } };
  });
}

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, apiClient } from "../src/services/api/request";
import { applyVideoRetentionBatch, previewVideoRetention, type VideoRetentionPreview } from "../src/services/api/video-retention";
import { RETENTION_ACTIONS, VideoRetentionControls, VideoRetentionImpactView } from "../src/pages/intelligence/video-retention-controls";
import { VideoOperationalInsights } from "../src/pages/intelligence/video-insights";
import type { VideoGovernanceMetrics, VideoOperationalMetrics } from "../src/services/api/video-insights";

const preview: VideoRetentionPreview = {
    action: "erased", target: { source_id: "source-fixed" }, preview_hash: "a".repeat(64), truncated: false, limit_per_category: 500,
    counts: { sources: 1, objects: 2, evidence: 3, knowledge: 4, skills: 5 }, dependencies: { sources: [{ id: "source-fixed", status: "active" }], skills: [{ id: "candidate-fixed", state: "deployed" }] },
    current_visibility: { access_revoked_documents: 0, remaining_documents_require_live_authorization: 1, published_knowledge: 4, active_skill_candidates: 5 },
    after_action: { source_status_changes: true, knowledge_revoked: true, historical_content_access: "denied", content_erased: true, historical_run_pins: "retained_not_rewritten", unrelated_canvas_messages_finances: "unchanged" },
    audit_retained: { identifiers: true, financial_events: true, deletion_journal: "required_before_mutation" }, physical_cleanup: { pending: 1, deleted: 0, will_request: 2, completion: "worker_receipt_required" },
};
describe("IF027 bounded preview and explicit retention commands", () => {
    test("host entry remains inert before opening and all five retention semantics are distinct", () => {
        const html = renderToStaticMarkup(<VideoRetentionControls workspaceId="w" sources={[]} onChanged={() => {}} />);
        expect(html).toContain("保留 / 撤权影响与受控批次"); expect(html).not.toContain("执行已确认目标");
        expect(RETENTION_ACTIONS).toHaveLength(5); expect(new Set(RETENTION_ACTIONS.map(x => x.value)).size).toBe(5);
        expect(RETENTION_ACTIONS.find(x => x.value === "subscription_paused")?.label).toContain("不撤销");
    });
    test("actual impact rendering separates audit identity, current visibility, content erasure and pending cleanup", () => {
        const html = renderToStaticMarkup(<VideoRetentionImpactView preview={preview} />);
        for (const label of ["关联来源", "注册对象", "固定证据", "知识单元", "原生 Skill 候选", "candidate-fixed", "历史身份及哈希保留", "访问失效不等于底层物理清理完成", "retained_not_rewritten", "financial_events", preview.preview_hash]) expect(html).toContain(label);
        expect(html).not.toContain("清理已完成"); expect(html).not.toContain("全部删除成功");
    });
    test("preview does not mutate; batch binds exact per-target hash/key and typed confirmation", async () => {
        const original = apiClient.request; const calls: Record<string, any>[] = [];
        apiClient.request = (async (config: Record<string, any>) => { calls.push(config); return { status: 200, data: { code: 0, data: preview }, headers: {} }; }) as typeof apiClient.request;
        try {
            await previewVideoRetention("w", "erased", preview.target);
            expect(calls[0].url).toBe("/intelligence/video/retention/preview"); expect(calls[0].data).toEqual({ action: "erased", source_id: "source-fixed" });
            const items = [{ ...preview.target, action: preview.action, reason: "authorized reason", expected_impact_hash: preview.preview_hash, idempotency_key: "fixed-target-key", confirmation: preview.action }];
            await applyVideoRetentionBatch("w", items, "fixed-batch-key"); await applyVideoRetentionBatch("w", items, "fixed-batch-key");
            expect(calls[1]).toMatchObject({ method: "post", url: "/intelligence/video/retention/batch", data: { items }, headers: { "X-Workspace-Id": "w", "X-Idempotency-Key": "fixed-batch-key" } });
            expect(calls[2].data).toEqual(calls[1].data); expect(calls[2].headers).toEqual(calls[1].headers);
            for (const call of calls) { expect(call.data.scopes).toBeUndefined(); expect(call.data.tenant_id).toBeUndefined(); expect(call.data.actor).toBeUndefined(); }
        } finally { apiClient.request = original; }
    });
    test("stale, denied and unknown failures do not become success or trigger an expanded preview", async () => {
        const original = apiClient.request; let calls = 0;
        apiClient.request = (async () => { calls++; return { status: 409, data: { code: 409, msg: "preview changed", reason: "retention_preview_changed" }, headers: {} }; }) as typeof apiClient.request;
        try {
            await expect(applyVideoRetentionBatch("w", [], "fixed-batch-key")).rejects.toBeInstanceOf(ApiError); expect(calls).toBe(1);
        } finally { apiClient.request = original; }
    });
});

test("operational and governance read models keep unknown quality/history separate from counted transitions", () => {
    const operational: VideoOperationalMetrics = { scope: "audit only", stages: [{ stage: "input", state: "retry_wait", count: 2, observed_count: 0, observed_since: null, rate_limit_events: 1, auth_required_events: 0, duration_samples: 0, mean_wall_duration_ms: null, oldest_wait_ms: null }], ready_latency: { samples: 0, mean_ms: null, max_ms: null }, needs_auth_current: 1, completed_with_gaps: 2, duplicate_suppression: { distinct_request_keys: 4, distinct_jobs: 3, collapsed_request_keys: 1, same_key_replays: null }, discovery: { runs: 1, accepted_page_items: 10, newly_registered_unique_assets: 2, partial_runs: 1, mean_finished_wall_ms: null }, definitions: {} };
    const governance: VideoGovernanceMetrics = { citation_support: { units: 1, units_with_current_evidence_links: 1, units_without_current_evidence_links: 0, units_with_explicit_support_review: 0, model_inference_units: 0, semantic_support_accuracy: null }, review_revision: { revised_units: 0, additional_versions: 0, events_in_window: {} }, source_independence: { candidate_states: { pending: 1 }, cross_source_verified_claims: 0, calibrated_accuracy: null }, failure_recovery: { jobs: 3, observed_failure_jobs: 1, completed_after_observed_failure: 0, multiple_stage_attempt_jobs: 1, unknown_outcomes_current: 1 }, definitions: {} };
    const html = renderToStaticMarkup(<VideoOperationalInsights operational={operational} governance={governance} />);
    for (const text of ["历史未计量", "未知 / 尚未计量", "不可当成零", "非请求数", "账号数量不等于独立来源", "结果不明必须先对账", "不授予材料访问"]) expect(html).toContain(text);
});

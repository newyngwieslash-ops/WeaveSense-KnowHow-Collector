import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApiError, apiClient } from "../src/services/api/request";
import { backfillVideoSource, cancelVideoJob, correctVideoTranscript, getVideoDiscovery, reconcileVideoJob, saveVideoProfile, setVideoScheduleEnabled, setVideoSourceStatus, startVideoJob } from "../src/services/api/video-knowledge";
import { createVideoSkillCandidate, getVideoKnowledge, installVideoSkillCandidate, listKnowledgeExtractions, listVideoSkillCandidates, publishVideoKnowledge, reviewVideoKnowledge, searchPublishedKnowledge, type KnowledgeRecord, type SkillCandidate } from "../src/services/api/video-knowledge-review";
import { evidenceHighlight, formatEvidenceTime, safeEvidenceSourceUrl, VideoEvidencePanel } from "../src/pages/intelligence/video-evidence";
import { describeVideoError, VIDEO_STATE_LABEL, VideoLoadState } from "../src/pages/intelligence/video-common";
import { connectionRecoveryHint } from "../src/pages/intelligence/video-connection-health";
import { VideoKnowledgeReview } from "../src/pages/intelligence/video-knowledge-review";
import { SKILL_STATE_LABEL } from "../src/pages/intelligence/video-skill-candidates";
import { VideoExternalStageSummary } from "../src/pages/intelligence/video-ingestion-jobs";
import type { VideoStage } from "../src/services/api/video-knowledge";

describe("COL024 external stage response is historical evidence, not local state inference", () => {
    const base: VideoStage = { stage: "input", state: "running", attempt: 1 };
    const observed: VideoStage = { ...base, submission_intent_state: "accepted", external_task_known: true, external_observed_state: "pending", external_observed_at: "2026-10-26T00:00:01.000Z" };
    test("older responses with no summary fields remain unknown even when locally completed", () => {
        const html = renderToStaticMarkup(<VideoExternalStageSummary stage={{ ...base, state: "completed" }} hostState="completed" />);
        expect(html).toContain("提交意图：未知"); expect(html).toContain("身份未返回"); expect(html).toContain("未知（尚无确认响应）"); expect(html).not.toContain("历史观测时间"); expect(html).not.toContain("完成（completed）");
    });
    test("accepted pending response includes its actual historical observation, not current time", () => {
        const html = renderToStaticMarkup(<VideoExternalStageSummary stage={observed} />);
        expect(html).toContain("已接收"); expect(html).toContain("身份已确认"); expect(html).toContain("待处理（pending）"); expect(html).toContain("2026-10-26T00:00:01.000Z"); expect(html).toContain("不是当前状态保证");
    });
    test("submitted unknown response does not infer status from an intent or task identity", () => {
        const html = renderToStaticMarkup(<VideoExternalStageSummary stage={{ ...observed, submission_intent_state: "submitted", external_observed_state: "unknown", external_observed_at: null }} />);
        expect(html).toContain("已提交"); expect(html).toContain("身份已确认"); expect(html).toContain("尚无确认响应"); expect(html).not.toContain("待处理（pending）"); expect(html).not.toContain("历史观测时间");
    });
    test("missing/invalid observation time cannot become a confirmed pending response", () => {
        for (const external_observed_at of [undefined, null, "invalid-date"]) {
            const html = renderToStaticMarkup(<VideoExternalStageSummary stage={{ ...observed, external_observed_at }} />);
            expect(html).toContain("尚无确认响应"); expect(html).not.toContain("历史观测时间");
        }
    });
    test("local cancellation preserves pending history and does not assert remote stopped", () => {
        for (const hostState of ["cancel_requested", "cancelled"] as const) {
            const html = renderToStaticMarkup(<VideoExternalStageSummary stage={{ ...observed, state: "cancelled" }} hostState={hostState} />);
            expect(html).toContain("待处理（pending）"); expect(html).toContain("2026-10-26T00:00:01.000Z"); expect(html).toContain("宿主取消不代表远端已停止"); expect(html).toContain("远端取消结果请单独核对"); expect(html).not.toContain("完成（completed）");
        }
    });
});

describe("video evidence uses immutable global UTF-16 coordinates", () => {
    const title = "案例😀";
    const body = "第一段中文😀\n第二段参数 12 kWh";
    const full = `${title}\n\n${body}`;
    test("Chinese, emoji and cross-paragraph evidence highlight exactly", () => {
        const quote = "中文😀\n第二段";
        const char_start = full.indexOf(quote);
        expect(evidenceHighlight({ title, body, quote, char_start, char_end: char_start + quote.length })?.quote).toBe(quote);
        expect(char_start).toBe(title.length + 2 + body.indexOf("中文"));
    });
    test("body-local offsets, invalid boundaries and surrogate splitting cannot fake a highlight", () => {
        expect(evidenceHighlight({ title, body, quote: "第一", char_start: 0, char_end: 2 })).toBeNull();
        expect(evidenceHighlight({ title, body, quote: "", char_start: -1, char_end: 2 })).toBeNull();
        expect(evidenceHighlight({ title, body, quote: full.slice(2, 3), char_start: 2, char_end: 3 })).toBeNull();
        expect(evidenceHighlight({ title, body, quote: "fake", char_start: 0, char_end: 4 })).toBeNull();
    });
    test("unknown timing is never zero and source links cannot execute script", () => {
        expect(formatEvidenceTime(null)).toBe("时间未知");
        expect(formatEvidenceTime(undefined)).toBe("时间未知");
        expect(formatEvidenceTime(0)).toBe("0:00.000");
        expect(formatEvidenceTime(61350)).toBe("1:01.350");
        expect(safeEvidenceSourceUrl("javascript:alert(1)")).toBeUndefined();
        expect(safeEvidenceSourceUrl("data:text/html,test")).toBeUndefined();
        expect(safeEvidenceSourceUrl("https://www.bilibili.com/video/BVtest")).toContain("bilibili.com");
    });
    test("actual evidence panel does not promise playback for subtitle-only input", () => {
        const quote = "第一段"; const start = full.indexOf(quote);
        const html = renderToStaticMarkup(<VideoEvidencePanel evidence={{ evidence_id: "e1", document_id: "d1", revision: 2, snippet_hash: "a".repeat(64), title, body, quote, char_start: start, char_end: start + quote.length, source_id: "s1", material_type: "transcript", availability: "not_acquired", start_ms: null, end_ms: null, alignment_method: "unknown" }} />);
        expect(html).toContain("not_acquired"); expect(html).toContain("时间未知"); expect(html).toContain("不承诺本地播放"); expect(html).toContain("<mark>第一段</mark>");
    });
});

describe("honest host state projection", () => {
    test("all durable states are distinct and actionable", () => {
        expect(Object.keys(VIDEO_STATE_LABEL)).toHaveLength(11);
        expect(new Set(Object.values(VIDEO_STATE_LABEL)).size).toBe(11);
        expect(VIDEO_STATE_LABEL.completed).not.toContain("发布");
        expect(SKILL_STATE_LABEL.approved_for_release).not.toBe(SKILL_STATE_LABEL.deployed);
        expect(SKILL_STATE_LABEL.deployed).not.toBe(SKILL_STATE_LABEL.workspace_installed);
    });
    test("errors are not rendered as empty success", () => {
        const html = renderToStaticMarkup(<VideoLoadState workspaceId="w" loading={false} error="服务不可用" empty="没有任务" onRetry={() => {}} />);
        expect(html).toContain("服务不可用"); expect(html).not.toContain("没有任务");
        expect(describeVideoError(new ApiError("stale", { status: 409 }))).toContain("未覆盖");
    });
    test("default real host knowledge view explicitly refuses unpublished fallback", () => {
        const html = renderToStaticMarkup(<MemoryRouter><VideoKnowledgeReview /></MemoryRouter>);
        expect(html).toContain("普通检索只返回有效的已发布知识"); expect(html).toContain("不会自动回退"); expect(html).toContain("请选择工作区");
    });
    test("MCP recovery never recommends widening SSRF or bypassing approval", () => {
        expect(connectionRecoveryHint({ status: "needs_reapproval", statusReason: "" })).toContain("重新发现并审查");
        expect(connectionRecoveryHint({ status: "approved", statusReason: "private_network_denied" })).toContain("不要关闭 SSRF");
        expect(connectionRecoveryHint({ status: "approved", statusReason: "credential_expired" })).toContain("不要把 Cookie");
    });
});

describe("host HTTP contract and guarded mutations", () => {
    test("calls host http, keeps idempotency recovery without job ID and never claims scope in body", async () => {
        const original = apiClient.request; const calls: Record<string, any>[] = [];
        apiClient.request = (async (config: Record<string, any>) => { calls.push(config); return { status: 200, data: { code: 0, data: { items: [] }, msg: "ok" }, headers: {} }; }) as typeof apiClient.request;
        try {
            await startVideoJob("workspace-1", { source_id: "s1", native_id: "90071992547409930001", content_version: "v1", profile_id: "p1", profile_version: 2 }, "frozen-key");
            await reconcileVideoJob("workspace-1", { idempotency_key: "frozen-key" });
            await cancelVideoJob("workspace-1", "j1", "stop");
            await saveVideoProfile("workspace-1", { id: "p1", expected_version: 2, name: "行业", config: {} });
            expect(calls[0].url).toBe("/intelligence/video/jobs");
            expect(calls[0].headers["X-Idempotency-Key"]).toBe("frozen-key");
            expect(calls[1].data).toEqual({ idempotency_key: "frozen-key" });
            for (const call of calls) { expect(call.headers["X-Workspace-Id"]).toBe("workspace-1"); expect(call.headers["X-Idempotency-Key"]).toBeTruthy(); expect(call.data.workspace_id).toBeUndefined(); expect(call.data.scopes).toBeUndefined(); }
            expect(calls[3].data.expected_version).toBe(2);
        } finally { apiClient.request = original; }
    });
    test("review and publish bind exact version/hash; published search has no fallback request", async () => {
        const original = apiClient.request; const calls: Record<string, any>[] = [];
        apiClient.request = (async (config: Record<string, any>) => { calls.push(config); return { status: 200, data: { code: 0, data: { items: [] }, msg: "ok" }, headers: {} }; }) as typeof apiClient.request;
        try {
            const record = { id: "k1", version: 3, content_hash: "frozen-hash" } as KnowledgeRecord;
            await reviewVideoKnowledge("w1", record, "approve", "checked", { evidence_support: true, critical_fields: true });
            await publishVideoKnowledge("w1", record, "publish checked version");
            await searchPublishedKnowledge("w1", "no answer");
            expect(calls[0].data).toMatchObject({ expected_version: 3, expected_hash: "frozen-hash", checks: { evidence_support: true, critical_fields: true } });
            expect(calls[1].data).toMatchObject({ expected_version: 3, expected_hash: "frozen-hash" });
            expect(calls).toHaveLength(3); expect(calls[2].url).toBe("/intelligence/knowledge/search");
        } finally { apiClient.request = original; }
    });
    test("strong mutation errors propagate rather than becoming success", async () => {
        const original = apiClient.request;
        apiClient.request = (async () => ({ status: 409, data: { code: 409, msg: "conflict", reason: "version_conflict", data: null }, headers: {} })) as typeof apiClient.request;
        try { await expect(saveVideoProfile("w", { id: "p", expected_version: 1, name: "n", config: {} })).rejects.toBeInstanceOf(ApiError); }
        finally { apiClient.request = original; }
    });
    test("discovery pagination is read-only and source transitions preserve revision", async () => {
        const original = apiClient.request; const calls: Record<string, any>[] = [];
        apiClient.request = (async (config: Record<string, any>) => { calls.push(config); return { status: 200, data: { code: 0, data: {}, msg: "ok" }, headers: {} }; }) as typeof apiClient.request;
        try {
            await getVideoDiscovery("w", "op_1", undefined, "50");
            await setVideoSourceStatus("w", "s_1", 7, "paused");
            await backfillVideoSource("w", "s_1", { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z", limit: 10 });
            await setVideoScheduleEnabled("w", "schedule_1", 9, false);
            expect(calls[0]).toMatchObject({ method: "get", url: "/intelligence/video/discover/op_1", params: { cursor: "50", limit: 50 } });
            expect(calls[1].data).toEqual({ expected_revision: 7, status: "paused" });
            expect(calls[2].data.limit).toBe(10);
            expect(calls[3]).toMatchObject({ method: "patch", url: "/intelligence/schedules/schedule_1", data: { expected_revision: 9, enabled: false } });
            expect(calls[3].data.source_ids).toBeUndefined();
        } finally { apiClient.request = original; }
    });
    test("unpublished detail requires explicit review mode, never a fallback", async () => {
        const original = apiClient.request; const calls: Record<string, any>[] = [];
        apiClient.request = (async (config: Record<string, any>) => { calls.push(config); return { status: 200, data: { code: 0, data: {}, msg: "ok" }, headers: {} }; }) as typeof apiClient.request;
        try { await getVideoKnowledge("w", "k"); await getVideoKnowledge("w", "k", undefined, "review"); expect(calls[0].params).toEqual({}); expect(calls[1].params).toEqual({ mode: "review" }); }
        finally { apiClient.request = original; }
    });
    test("candidate pin binds deployed native hash and immutable proposal hash", async () => {
        const original = apiClient.request; let call: Record<string, any> | undefined;
        apiClient.request = (async (config: Record<string, any>) => { call = config; return { status: 200, data: { code: 0, data: {}, msg: "ok" }, headers: {} }; }) as typeof apiClient.request;
        try {
            await installVideoSkillCandidate("w", { id: "candidate1", candidate_hash: "proposal-hash", native_skill_hash: "native-hash" } as SkillCandidate, { id: "method", version: "1.0.1" });
            expect(call?.data).toEqual({ skill_id: "method", version: "1.0.1", hash: "native-hash", expected_hash: "proposal-hash" });
            expect(call?.url).toBe("/intelligence/video/skill-candidates/candidate1/install");
            expect(call?.data.deployed).toBeUndefined(); expect(call?.data.receipt).toBeUndefined();
        } finally { apiClient.request = original; }
    });
    test("historical candidate pagination is a bounded read, not a new candidate submission", async () => {
        const original = apiClient.request; let call: Record<string, any> | undefined;
        apiClient.request = (async (config: Record<string, any>) => { call = config; return { status: 200, data: { code: 0, data: { items: [] }, msg: "ok" }, headers: {} }; }) as typeof apiClient.request;
        try {
            await listVideoSkillCandidates("w", undefined, "candidate_older");
            expect(call).toMatchObject({ method: "get", url: "/intelligence/video/skill-candidates", params: { cursor: "candidate_older", limit: 30 } });
            expect(call?.data).toBeUndefined();
        } finally { apiClient.request = original; }
    });
    test("candidate creation preserves explicit rule-evidence mapping without fabricating support", async () => {
        const original = apiClient.request; let call: Record<string, any> | undefined;
        apiClient.request = (async (config: Record<string, any>) => { call = config; return { status: 200, data: { code: 0, data: {}, msg: "ok" }, headers: {} }; }) as typeof apiClient.request;
        try {
            const rule_evidence = [{ rule: "method", evidence_ids: ["real-host-evidence"] }, { rule: "step:0", evidence_ids: ["real-host-evidence"] }];
            await createVideoSkillCandidate("w", { rule_evidence });
            expect(call?.data.rule_evidence).toEqual(rule_evidence);
            expect(call?.data.approval).toBeUndefined();
        } finally { apiClient.request = original; }
    });
    test("material correction binds the original revision and does not invent timestamps", async () => {
        const original = apiClient.request; const calls: Record<string, any>[] = [];
        apiClient.request = (async (config: Record<string, any>) => { calls.push(config); return { status: 200, data: { code: 0, data: {}, msg: "ok" }, headers: {} }; }) as typeof apiClient.request;
        try {
            await correctVideoTranscript("w", "job", { expected_revision: 4, expected_content_hash: "source-hash", reason: "typo", patches: [{ evidence_id: "e1", text: "校正😀" }] });
            await listKnowledgeExtractions("w", "job");
            expect(calls[0].data).toMatchObject({ expected_revision: 4, expected_content_hash: "source-hash" });
            expect(calls[0].data.patches[0]).toEqual({ evidence_id: "e1", text: "校正😀" });
            expect(calls[1]).toMatchObject({ method: "get", url: "/intelligence/knowledge/extractions", params: { video_job_id: "job", limit: 30 } });
        } finally { apiClient.request = original; }
    });
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, apiClient } from "../src/services/api/request";
import { describeMediaAccessError, readVideoEvidenceSlice, readVideoMediaObjects, readVideoVisualRecords, repairVideoMedia, safeVideoMediaURL, verifyVideoMediaAccess, type VideoMediaDescriptor, type VideoTemporalEvidence, type VideoVisualRecord } from "../src/services/api/video-media";
import { installVideoSkillCandidate, type SkillCandidate } from "../src/services/api/video-knowledge-review";
import { listVideoOriginCandidates, reviewVideoOriginCandidate, type VideoOriginCandidate } from "../src/services/api/video-origin-review";
import { readVideoMetrics } from "../src/services/api/video-insights";
import { AuthorizedVideoMedia } from "../src/pages/intelligence/video-media-preview";
import { alignmentDescription, VideoEvidenceTimeline, VISUAL_TYPE_LABEL } from "../src/pages/intelligence/video-evidence-timeline";
import { correctionCommitted } from "../src/pages/intelligence/video-transcript-correction";
import { metricValue } from "../src/pages/intelligence/video-insights";
import { safeConflictExcerpt, VisualConflictReview } from "../src/pages/intelligence/video-conflict-review";
import { mediaAvailabilityDescription } from "../src/pages/intelligence/video-evidence-utils";

const objectId = "a".repeat(32);
const media: VideoMediaDescriptor = { object_id: objectId, content_type: "video/mp4", bytes: 200, download_path: `/api/intelligence/video/jobs/vj_fixture/media/${objectId}` };
const envelope = (data: unknown) => ({ status: 200, data: { code: 0, data, msg: "ok" }, headers: {} });

describe("authorized host media cannot become an arbitrary URL loader", () => {
    test("only exact registered opaque ID path is accepted with workspace selector, no credentials", () => {
        expect(safeVideoMediaURL("workspace space", "vj_fixture", media)).toBe(`${media.download_path}?workspace_id=workspace%20space`);
        for (const download_path of ["https://evil.invalid/video.mp4", "//evil.invalid/video.mp4", "javascript:alert(1)", `${media.download_path}?token=secret`, `/api/intelligence/video/jobs/other/media/${objectId}`, "/api/intelligence/video/objects?key=internal"]) {
            expect(safeVideoMediaURL("w", "vj_fixture", { ...media, download_path })).toBeUndefined();
        }
        expect(safeVideoMediaURL("w", "vj_fixture", { ...media, object_id: "../raw-key" })).toBeUndefined();
        expect(safeVideoMediaURL("w", "vj_fixture", { ...media, content_type: "image/svg+xml" })).toBeUndefined();
        expect(safeVideoMediaURL("w", "vj_fixture", { ...media, available: false })).toBeUndefined();
        expect(safeVideoMediaURL("", "vj_fixture", media)).toBeUndefined();
    });
    test("one-byte preflight uses host raw boundary, current workspace and actual Range receipt", async () => {
        const original = apiClient.request; let call: Record<string, any> | undefined;
        apiClient.request = (async (config: Record<string, any>) => { call = config; return { status: 206, data: new Uint8Array([1]).buffer, headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/200" } }; }) as typeof apiClient.request;
        try {
            expect(await verifyVideoMediaAccess("w1", "vj_fixture", media)).toContain("workspace_id=w1");
            expect(call).toMatchObject({ method: "get", baseURL: "", responseType: "arraybuffer", maxContentLength: 1024, headers: { Range: "bytes=0-0", "X-Workspace-Id": "w1" } });
            expect(call?.url).toBe(`${media.download_path}?workspace_id=w1`);
            expect(call?.data).toBeUndefined();
        } finally { apiClient.request = original; }
    });
    test("ignoring Range or returning another MIME cannot produce a playable receipt", async () => {
        const original = apiClient.request;
        apiClient.request = (async () => ({ status: 200, data: new Uint8Array([1]).buffer, headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/200" } })) as typeof apiClient.request;
        try { await expect(verifyVideoMediaAccess("w1", "vj_fixture", media)).rejects.toThrow("范围校验失败"); }
        finally { apiClient.request = original; }
    });
    test("expired, revoked and missing are distinct and never trigger another URL", () => {
        expect(describeMediaAccessError(new ApiError("denied", { status: 403 }))).toContain("撤权");
        expect(describeMediaAccessError(new ApiError("missing", { status: 404 }))).toContain("不存在");
        expect(describeMediaAccessError(new ApiError("expired", { status: 410 }))).toContain("过期");
    });
    test("only confirmed missing objects offer explicit repair; expiry/revocation never do", () => {
        for (const unavailable_reason of ["object_expired", "revoked", "erased"]) {
            const html = renderToStaticMarkup(<AuthorizedVideoMedia workspaceId="w" jobId="vj_fixture" media={{ ...media, available: false, download_path: null, unavailable_reason }} label="test" />);
            expect(html).not.toContain("显式申请修复缺失媒体");
        }
        expect(renderToStaticMarkup(<AuthorizedVideoMedia workspaceId="w" jobId="vj_fixture" media={{ ...media, available: false, download_path: null, unavailable_reason: "object_missing" }} label="test" />)).toContain("显式申请修复缺失媒体");
        expect(mediaAvailabilityDescription("subscription_paused")).toContain("不等于撤销");
        expect(mediaAvailabilityDescription("media_expired")).toContain("独立许可");
        expect(mediaAvailabilityDescription("erased")).toContain("不从旧缓存");
    });
    test("repair is an explicit keyed command, never a visual/media GET side effect", async () => {
        const original = apiClient.request; const calls: Record<string, any>[] = [];
        apiClient.request = (async (config: Record<string, any>) => { calls.push(config); return envelope({ state: "queued", stage: "input" }); }) as typeof apiClient.request;
        try {
            await readVideoMediaObjects("w", "vj_fixture"); expect(calls).toHaveLength(1); expect(calls[0].method).toBe("get");
            await repairVideoMedia("w", "vj_fixture", "same-repair-key"); await repairVideoMedia("w", "vj_fixture", "same-repair-key");
            expect(calls[1]).toMatchObject({ method: "post", url: "/intelligence/video/jobs/vj_fixture/repair", data: {}, headers: { "X-Idempotency-Key": "same-repair-key" } });
            expect(calls[2].headers["X-Idempotency-Key"]).toBe(calls[1].headers["X-Idempotency-Key"]);
        } finally { apiClient.request = original; }
    });
    test("actual media component SSR has no image/video/audio src before explicit authorized load", () => {
        const html = renderToStaticMarkup(<AuthorizedVideoMedia workspaceId="w" jobId="vj_fixture" media={media} label="固定产物" startMs={1234} />);
        expect(html).toContain("核对权限并加载");
        expect(html).not.toContain("<video"); expect(html).not.toContain("<audio"); expect(html).not.toContain("<img");
        const closed = renderToStaticMarkup(<VideoEvidenceTimeline workspaceId="w" jobId="vj_fixture" />);
        expect(closed).toContain("展开按需读取"); expect(closed).not.toContain("<video");
    });
});

describe("bounded immutable visual and source timeline", () => {
    test("conflict candidates retain both fixed source sides and never choose truth", () => {
        const side = { text_sha256: "fixed-hash", start_ms: 100, end_ms: 200, text_complete: true, read_ref: { cursor: "9", conflict_offset: 0, text_offset: 0 } };
        const record: VideoVisualRecord = { record_id: "align", type: "alignment", start_ms: 100, end_ms: 200, read_ref: { kind: "visual", cursor: "9", text_offset: 0, limit: 1, record_id: "align", conflict_offset: 0 }, conflict_count: 2, next_conflict_offset: 1, conflict_candidates: [{ relation: "numeric_disagreement_candidate", review_status: "unreviewed", truth_status: "not_asserted", label: "温度", unit: "°C", audio_value: 20, visual_value: 30, audio: { ...side, text: "语音温度为20度", read_ref: { ...side.read_ref, text_field: "audio" } }, visual: { ...side, text: "画面温度为30度", read_ref: { ...side.read_ref, text_field: "visual" } } }] };
        const html = renderToStaticMarkup(<VisualConflictReview workspaceId="w" jobId="vj_fixture" record={record} />);
        expect(html).toContain("语音温度为20度"); expect(html).toContain("画面温度为30度"); expect(html).toContain("not_asserted"); expect(html).toContain("unreviewed"); expect(html).toContain("不能自动选择一方"); expect(html).toContain("下一组分歧候选");
        expect(safeConflictExcerpt("文\ud83d")).toBe("文"); expect(safeConflictExcerpt("文😀")).toBe("文😀");
    });
    test("conflict continuation preserves side, candidate and UTF16 offset", async () => {
        const original = apiClient.request; let call: Record<string, any> | undefined;
        apiClient.request = (async (config: Record<string, any>) => { call = config; return envelope({ items: [] }); }) as typeof apiClient.request;
        try {
            await readVideoVisualRecords("w", "vj_fixture", "9", 500, undefined, { conflict_offset: 2, text_field: "audio" });
            expect(call?.params).toEqual({ kind: "visual", cursor: "9", text_offset: 500, conflict_offset: 2, text_field: "audio", limit: 1 });
            expect(call?.method).toBe("get"); expect(call?.data).toBeUndefined();
        } finally { apiClient.request = original; }
    });
    test("all five visual records distinguish OCR, derived observation, inference and uncertain alignment", () => {
        expect(Object.keys(VISUAL_TYPE_LABEL)).toHaveLength(5);
        expect(VISUAL_TYPE_LABEL.ocr).not.toBe(VISUAL_TYPE_LABEL.model_observation);
        expect(VISUAL_TYPE_LABEL.model_inference).toContain("非画面原文");
        expect(alignmentDescription({ relation: "temporal_overlap", semantic_relation: "not_assessed" })).toContain("不代表同一事实");
        expect(alignmentDescription({ relation: "unaligned", semantic_relation: "not_assessed" })).toContain("未能对齐");
    });
    test("visual text continuation reads one immutable record, media list is a bounded GET", async () => {
        const original = apiClient.request; const calls: Record<string, any>[] = [];
        apiClient.request = (async (config: Record<string, any>) => { calls.push(config); return envelope({ items: [] }); }) as typeof apiClient.request;
        try {
            await readVideoVisualRecords("w", "vj_fixture", "23", 500);
            await readVideoMediaObjects("w", "vj_fixture", "20");
            expect(calls[0]).toMatchObject({ method: "get", url: "/intelligence/video/jobs/vj_fixture/result", params: { kind: "visual", cursor: "23", text_offset: 500, limit: 1 } });
            expect(calls[1]).toMatchObject({ method: "get", params: { kind: "media", cursor: "20", limit: 20 } });
            expect(calls.every(call => call.data === undefined)).toBe(true);
        } finally { apiClient.request = original; }
    });
    test("source slices retain fixed revision and UTF-16 coordinates, never byte offsets or latest revision", async () => {
        const original = apiClient.request; let call: Record<string, any> | undefined;
        const evidence = { document_id: "doc", revision: 4, char_start: 6, char_end: 10 } as VideoTemporalEvidence;
        apiClient.request = (async (config: Record<string, any>) => { call = config; return envelope({ document_id: "doc", revision: 4, offset: 6, text: "中😀文", coverage: { total_chars: 10, returned_chars: 4, next_offset: null } }); }) as typeof apiClient.request;
        try {
            const slice = await readVideoEvidenceSlice("w", evidence, 6);
            expect(slice.text.length).toBe(4);
            expect(call?.data).toEqual({ document_id: "doc", revision: 4, offset: 6, max_chars: 4 });
            await expect(readVideoEvidenceSlice("w", evidence, 5)).rejects.toThrow("偏移无效");
        } finally { apiClient.request = original; }
    });
    test("a changed source revision is rejected rather than silently replacing a citation", async () => {
        const original = apiClient.request;
        apiClient.request = (async () => envelope({ document_id: "doc", revision: 5, offset: 6, text: "变更" })) as typeof apiClient.request;
        try { await expect(readVideoEvidenceSlice("w", { document_id: "doc", revision: 4, char_start: 6, char_end: 10 } as VideoTemporalEvidence, 6)).rejects.toThrow("固定修订片段响应不一致"); }
        finally { apiClient.request = original; }
    });
    test("queued embedding corrections cannot be labelled committed new revisions", () => {
        expect(correctionCommitted({ video_job_id: "j", revision: null, proposed_revision: 3, state: "queued", stage: "embedding" })).toBe(false);
        expect(correctionCommitted({ video_job_id: "j", revision: 3, state: "queued" })).toBe(false);
        expect(correctionCommitted({ video_job_id: "j", revision: 3, state: "completed" })).toBe(true);
        expect(correctionCommitted({ video_job_id: "j", revision: 3 })).toBe(true);
    });
});

describe("installation, origin review and metrics retain distinct authority", () => {
    test("switching a candidate binds current installed hash as well as candidate/native hashes", async () => {
        const original = apiClient.request; let call: Record<string, any> | undefined;
        apiClient.request = (async (config: Record<string, any>) => { call = config; return envelope({}); }) as typeof apiClient.request;
        try {
            await installVideoSkillCandidate("w", { id: "c", candidate_hash: "proposal", native_skill_hash: "next" } as SkillCandidate, { id: "skill", version: "v2" }, "current-native-hash");
            expect(call?.data).toEqual({ skill_id: "skill", version: "v2", hash: "next", expected_hash: "proposal", expected_install_hash: "current-native-hash" });
        } finally { apiClient.request = original; }
    });
    test("near-origin decisions are explicit human guarded writes; candidate read is paginated", async () => {
        const original = apiClient.request; const calls: Record<string, any>[] = [];
        apiClient.request = (async (config: Record<string, any>) => { calls.push(config); return envelope({ items: [] }); }) as typeof apiClient.request;
        try {
            await listVideoOriginCandidates("w", "pending", "last");
            await reviewVideoOriginCandidate("w", { id: "origin", content_hash: "frozen" } as VideoOriginCandidate, { decision: "same_origin", reason: "human checked", origin_cluster: "confirmed-source" });
            expect(calls[0]).toMatchObject({ method: "get", params: { state: "pending", cursor: "last", limit: 20 } });
            expect(calls[1].data).toEqual({ expected_hash: "frozen", decision: "same_origin", reason: "human checked", origin_cluster: "confirmed-source" });
            expect(calls[1].headers["X-Idempotency-Key"]).toBeTruthy();
        } finally { apiClient.request = original; }
    });
    test("unknown cost and unlabelled human quality are not numeric zero", async () => {
        expect(metricValue(null)).toContain("未知"); expect(metricValue(undefined)).toContain("未知"); expect(metricValue(0, " micro")).toBe("0 micro");
        const original = apiClient.request; let call: Record<string, any> | undefined;
        apiClient.request = (async (config: Record<string, any>) => { call = config; return envelope({}); }) as typeof apiClient.request;
        try { await readVideoMetrics("w", { profile_id: "profile-v1" }); expect(call).toMatchObject({ method: "get", url: "/intelligence/video/metrics", params: { profile_id: "profile-v1" } }); }
        finally { apiClient.request = original; }
    });
});

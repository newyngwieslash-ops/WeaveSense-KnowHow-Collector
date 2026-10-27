import { useState } from "react";
import { Button, Card, Space, Tag, Typography } from "antd";
import { Callout } from "@/components/ui/product/callout/callout";
import { readVideoVisualRecords, type VideoVisualRecord, type VisualConflictSide } from "@/services/api/video-media";
import { MutationError, useVideoMutation } from "./video-common";
import { formatEvidenceTime } from "./video-evidence-utils";

// A bounded preview must not render a lone UTF-16 high surrogate; full reads start at the authoritative offset.
export const safeConflictExcerpt = (text: string) => /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
function ConflictSide({ workspaceId, jobId, recordId, side, label }: { workspaceId: string; jobId: string; recordId: string; side: VisualConflictSide; label: string }) {
    const [page, setPage] = useState<VideoVisualRecord>();
    const [unavailable, setUnavailable] = useState(false);
    const mutation = useVideoMutation();
    const read = (offset: number) => mutation.run(async () => {
        try {
            const response = await readVideoVisualRecords(workspaceId, jobId, side.read_ref.cursor, offset, undefined, { conflict_offset: side.read_ref.conflict_offset, text_field: side.read_ref.text_field });
            const row = response.items[0];
            if (!row || row.record_id !== recordId || row.text_field !== side.read_ref.text_field || row.text_offset !== offset || row.read_ref.conflict_offset !== side.read_ref.conflict_offset) throw new Error("冲突来源分页身份不一致，未替换任一方材料");
            setPage(row); setUnavailable(false);
        } catch (error) { setUnavailable(true); setPage(undefined); throw error; }
    });
    return <Card size="small" title={label}>
        <div>{formatEvidenceTime(side.start_ms)} — {formatEvidenceTime(side.end_ms)}</div>
        {!unavailable && <blockquote className="whitespace-pre-wrap break-words">{page?.text ?? safeConflictExcerpt(side.text)}</blockquote>}
        <Typography.Paragraph type="secondary" className="break-all">固定来源全文 hash：{side.text_sha256}</Typography.Paragraph>
        <MutationError error={mutation.error} />
        {!side.text_complete && !page && <Button disabled={mutation.busy} onClick={() => void read(0)}>按固定来源分页读取全文</Button>}
        {page && <Space wrap><Tag>UTF-16 {page.text_offset} / {page.total_text_chars}</Tag><Button disabled={mutation.busy || !page.text_offset} onClick={() => void read(0)}>本方原文首页</Button><Button disabled={mutation.busy || page.next_text_offset == null} onClick={() => page.next_text_offset != null && void read(page.next_text_offset)}>继续本方原文</Button></Space>}
    </Card>;
}
export function VisualConflictReview({ workspaceId, jobId, record }: { workspaceId: string; jobId: string; record: VideoVisualRecord }) {
    const [page, setPage] = useState<VideoVisualRecord | null>(record);
    const mutation = useVideoMutation();
    const read = (offset: number) => mutation.run(async () => {
        try {
            const result = await readVideoVisualRecords(workspaceId, jobId, record.read_ref.cursor, 0, undefined, { conflict_offset: offset, text_field: "text" });
            const row = result.items[0];
            if (!row || row.record_id !== record.record_id || row.read_ref.conflict_offset !== offset) throw new Error("冲突候选分页身份不一致");
            setPage(row);
        } catch (error) { setPage(null); throw error; }
    });
    if (!record.conflict_count && !record.conflict_candidates?.length) return <Callout>未返回冲突候选，不代表已经证明语音与画面一致；语义关系仍未评估。</Callout>;
    return <div className="space-y-3">
        <Callout tone="warning" title="语音 / 画面数值分歧候选 · 未复核">同时保留双方来源。候选不是事实判定，不能自动选择一方、合并原话或把模型判断改写为画面原文。</Callout>
        <MutationError error={mutation.error} />
        {page?.conflict_candidates?.map((candidate, index) => <div key={`${page.read_ref.conflict_offset ?? 0}:${index}`} className="space-y-2">
            <Space wrap><Tag>{candidate.review_status}</Tag><Tag>{candidate.truth_status}</Tag><span>{candidate.label}：语音 {candidate.audio_value} / 画面 {candidate.visual_value} {candidate.unit}</span></Space>
            <div className="grid gap-3 md:grid-cols-2"><ConflictSide workspaceId={workspaceId} jobId={jobId} recordId={record.record_id} side={candidate.audio} label="语音 / 字幕原话（固定来源）" /><ConflictSide workspaceId={workspaceId} jobId={jobId} recordId={record.record_id} side={candidate.visual} label="画面 OCR 原文（固定来源）" /></div>
        </div>)}
        <Space wrap><Tag>候选总数 {page?.conflict_count ?? record.conflict_count ?? "未返回"}；每次读取一组</Tag><Button disabled={mutation.busy || !page?.read_ref.conflict_offset} onClick={() => void read(0)}>冲突候选首页</Button><Button disabled={mutation.busy || page?.next_conflict_offset == null} onClick={() => page?.next_conflict_offset != null && void read(page.next_conflict_offset)}>下一组分歧候选</Button></Space>
    </div>;
}

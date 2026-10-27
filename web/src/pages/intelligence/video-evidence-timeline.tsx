import { useCallback, useState } from "react";
import { Button, Card, List, Select, Space, Tabs, Tag, Typography } from "antd";
import { Callout } from "@/components/ui/product/callout/callout";
import { readVideoEvidenceSlice, readVideoTemporalEvidence, readVideoVisualRecords, type VideoTemporalEvidence, type VideoVisualRecord } from "@/services/api/video-media";
import { MutationError, useVideoMutation, useVideoResource, VideoLoadState } from "./video-common";
import { formatEvidenceTime } from "./video-evidence-utils";
import { AuthorizedVideoMedia, VideoMediaLibrary } from "./video-media-preview";
import { VisualConflictReview } from "./video-conflict-review";

export const VISUAL_TYPE_LABEL: Record<VideoVisualRecord["type"], string> = { frame: "实际采样帧", ocr: "OCR 识别原文 · 未复核", model_observation: "模型视觉观察 · 派生未复核", model_inference: "模型推断 · 非画面原文", alignment: "语音 / 画面时间关联" };
const knownTime = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value >= 0;
export function alignmentDescription(record: Pick<VideoVisualRecord, "relation" | "semantic_relation">) {
    return record.relation === "temporal_overlap" ? "仅有时间重叠，不代表同一事实；语义一致性未评估" : "未能对齐；不猜测语音和画面描述同一事实";
}
function EvidenceText({ workspaceId, evidence, onSeek }: { workspaceId: string; evidence: VideoTemporalEvidence; onSeek: (ms: number) => void }) {
    const mutation = useVideoMutation();
    const [slice, setSlice] = useState<{ text: string; offset: number; next: number | null }>();
    const [unavailable, setUnavailable] = useState(false);
    const load = (offset: number) => mutation.run(async () => {
        try {
            const result = await readVideoEvidenceSlice(workspaceId, evidence, offset);
            const next = result.offset + result.text.length;
            setSlice({ text: result.text, offset: result.offset, next: next < evidence.char_end ? next : null }); setUnavailable(false);
        } catch (error) { setUnavailable(true); setSlice(undefined); throw error; }
    });
    return <div className="space-y-2 w-full">
        <Space wrap><Typography.Text copyable>{evidence.evidence_id}</Typography.Text><Tag>r{evidence.revision}</Tag><Tag>{evidence.material_type ?? "来源文本；具体类别未返回"}</Tag><Button size="small" disabled={!knownTime(evidence.start_ms)} onClick={() => knownTime(evidence.start_ms) && onSeek(evidence.start_ms)}>定位 {formatEvidenceTime(evidence.start_ms)}</Button></Space>
        <div>{formatEvidenceTime(evidence.start_ms)} — {formatEvidenceTime(evidence.end_ms)} · {evidence.alignment_method ?? "unknown"} · UTF-16 [{evidence.char_start}, {evidence.char_end})</div>
        {!unavailable && <blockquote className="whitespace-pre-wrap break-words">{slice?.text ?? evidence.quote ?? evidence.quote_excerpt ?? "未返回可读原文"}</blockquote>}
        <MutationError error={mutation.error} />
        {slice ? <Space wrap><Tag>当前片段偏移 {slice.offset} · 不是整段全文缓存</Tag><Button disabled={mutation.busy} onClick={() => void load(evidence.char_start)}>片段首页</Button><Button disabled={mutation.busy || slice.next === null} onClick={() => slice.next !== null && void load(slice.next)}>继续读取片段</Button></Space> : (!evidence.quote_complete || unavailable) && <Button disabled={mutation.busy} onClick={() => void load(evidence.char_start)}>按固定修订分页读取完整片段</Button>}
        <Typography.Text type="secondary" className="break-all">固定片段 hash：{evidence.snippet_hash}</Typography.Text>
    </div>;
}
function TranscriptTimeline({ workspaceId, jobId, onSeek }: { workspaceId: string; jobId: string; onSeek: (ms: number) => void }) {
    const [cursor, setCursor] = useState<string>();
    const fetcher = useCallback((ws: string, signal: AbortSignal) => readVideoTemporalEvidence(ws, jobId, cursor, signal), [jobId, cursor]);
    const resource = useVideoResource(workspaceId, fetcher, 15000);
    return <div className="space-y-3">
        <VideoLoadState workspaceId={workspaceId} {...resource} empty={resource.data?.items.length === 0 ? "本页没有固定修订来源片段" : undefined} onRetry={resource.refresh} />
        {resource.data && <><Tag>{resource.data.complete ? "资料已就绪；不等于知识发布" : "资料未就绪，不能宣称完成"}</Tag><List dataSource={resource.data.items} renderItem={evidence => <List.Item key={evidence.evidence_id}><EvidenceText key={evidence.evidence_id} workspaceId={workspaceId} evidence={evidence} onSeek={onSeek} /></List.Item>} /></>}
        <Space><Button disabled={!cursor} onClick={() => setCursor(undefined)}>来源片段首页</Button><Button disabled={!resource.data?.next_cursor} onClick={() => setCursor(resource.data!.next_cursor!)}>下一页来源片段</Button></Space>
    </div>;
}
function VisualRecordCard({ workspaceId, jobId, record, onSeek }: { workspaceId: string; jobId: string; record: VideoVisualRecord; onSeek: (ms: number) => void }) {
    const mutation = useVideoMutation();
    const [part, setPart] = useState<VideoVisualRecord | null>(record);
    const read = (offset: number) => mutation.run(async () => {
        try {
            const page = await readVideoVisualRecords(workspaceId, jobId, record.read_ref.cursor, offset);
            const item = page.items[0];
            if (!item || item.record_id !== record.record_id || item.text_offset !== offset) throw new Error("视觉记录分页身份或 UTF-16 偏移不一致");
            setPart(item);
        } catch (error) { setPart(null); throw error; }
    });
    const frames = part ? part.frame_media ? [part.frame_media] : part.frame_media_items ?? [] : [];
    return <Card size="small" title={<Space wrap><Tag>{VISUAL_TYPE_LABEL[record.type]}</Tag><Button size="small" disabled={!knownTime(record.start_ms)} onClick={() => knownTime(record.start_ms) && onSeek(record.start_ms)}>定位 {formatEvidenceTime(record.start_ms)}</Button></Space>}>
        <div className="space-y-3">
            <MutationError error={mutation.error} />
            <div>{formatEvidenceTime(record.start_ms)} — {formatEvidenceTime(record.end_ms)} · 记录 {record.record_id}</div>
            {part && <>
                {(record.type === "model_inference" || record.type === "model_observation") && <Callout tone="warning">派生内容，审阅状态：{part.review_status ?? "未返回"}。不能当作 OCR 原文或已核实知识；必须核对实际输入帧与来源。</Callout>}
                {part.text !== undefined && <Typography.Paragraph className="whitespace-pre-wrap break-words">{part.text}</Typography.Paragraph>}
                {part.total_text_chars !== undefined && part.total_text_chars > 0 && <Space wrap><Tag>UTF-16 {part.text_offset ?? 0} / {part.total_text_chars}；{part.text_complete ? "单次完整返回" : "有界文本分页"}</Tag><Button disabled={mutation.busy || !part.text_offset} onClick={() => void read(0)}>记录首页</Button><Button disabled={mutation.busy || part.next_text_offset == null} onClick={() => part.next_text_offset != null && void read(part.next_text_offset)}>继续读取记录</Button></Space>}
                {record.type === "alignment" && <><Callout>{alignmentDescription(part)}</Callout><List size="small" dataSource={part.audio_segments ?? []} locale={{ emptyText: "没有对应语音区间，不猜测对齐" }} renderItem={segment => <List.Item>{formatEvidenceTime(segment.start_ms)} — {formatEvidenceTime(segment.end_ms)} · 文本 hash {segment.text_sha256}</List.Item>} />{Number(part.audio_segment_count) > (part.audio_segments?.length ?? 0) && <Tag>仅返回部分关联区间，不代表完整对齐</Tag>}</>}
                {record.type === "alignment" && <VisualConflictReview workspaceId={workspaceId} jobId={jobId} record={part} />}
                <div className="grid gap-3 sm:grid-cols-2">{frames.map((frame, index) => <AuthorizedVideoMedia key={`${frame.object_id ?? index}`} workspaceId={workspaceId} jobId={jobId} media={frame} label={`帧 ${part.frame_id ?? part.frame_ids?.[index] ?? index + 1} · ${formatEvidenceTime(part.start_ms)}`} />)}</div>
                {Number(part.frame_ref_count) > frames.length && <Callout>仅显示服务端返回的前 {frames.length} 个帧引用；总引用 {part.frame_ref_count} 个，不表示已覆盖全部帧。</Callout>}
                {part.provenance && <details><summary>派生记录出处（不代表复核通过）</summary><div>实际模型任务 {part.provenance.model_task_count} 个；本页最多显示 4 个计量 / 配置引用。</div><List size="small" dataSource={part.provenance.model_tasks} renderItem={task => <List.Item><div className="break-all">配置 hash {task.model_config_hash}<br />计量引用 {task.usage_ref}</div></List.Item>} /></details>}
            </>}
        </div>
    </Card>;
}
function VisualTimeline({ workspaceId, jobId, onSeek }: { workspaceId: string; jobId: string; onSeek: (ms: number) => void }) {
    const [cursor, setCursor] = useState<string>();
    const [kind, setKind] = useState<VideoVisualRecord["type"]>();
    const fetcher = useCallback((ws: string, signal: AbortSignal) => readVideoVisualRecords(ws, jobId, cursor, undefined, signal), [jobId, cursor]);
    const resource = useVideoResource(workspaceId, fetcher, 15000);
    const records = resource.data?.items.filter(record => !kind || record.type === kind) ?? [];
    return <div className="space-y-3">
        <Callout>抽帧是采样，不是全帧理解。OCR、模型观察、推断和时间关联分别展示；时间重叠不证明语义一致，冲突双方须保留供人工复核。</Callout>
        <Select aria-label="本页视觉记录类型" allowClear value={kind} placeholder="筛选本页记录（不是全量查询）" className="w-full" options={Object.entries(VISUAL_TYPE_LABEL).map(([value, label]) => ({ value, label }))} onChange={setKind} />
        <VideoLoadState workspaceId={workspaceId} {...resource} empty={resource.data && records.length === 0 ? "本页没有此类型记录；不代表整个视频没有" : undefined} onRetry={resource.refresh} />
        {resource.data && <><Tag>{resource.data.complete ? "资料就绪；视觉覆盖仍以实际采样为准" : "未就绪 / 视觉必需处理未完成"}</Tag>{records.map(record => <VisualRecordCard key={`${cursor ?? "0"}:${record.record_id}`} workspaceId={workspaceId} jobId={jobId} record={record} onSeek={onSeek} />)}</>}
        <Space><Button disabled={!cursor} onClick={() => setCursor(undefined)}>视觉首页</Button><Button disabled={!resource.data?.next_cursor} onClick={() => setCursor(resource.data!.next_cursor!)}>下一页视觉记录</Button></Space>
    </div>;
}
export function VideoEvidenceTimeline({ workspaceId, jobId, startMs }: { workspaceId: string; jobId: string; startMs?: number | null }) {
    const [opened, setOpened] = useState(false);
    const [tab, setTab] = useState("transcript");
    const [seekMs, setSeekMs] = useState<number | null | undefined>(startMs);
    const seek = (ms: number) => { setSeekMs(ms); setTab("media"); };
    return <Card size="small" title="固定产物 · 来源时轴 / 视觉证据 / 受权播放" extra={<Button onClick={() => setOpened(!opened)}>{opened ? "关闭并卸载" : "展开按需读取"}</Button>}>
        {opened ? <Tabs activeKey={tab} onChange={setTab} destroyOnHidden items={[
            { key: "transcript", label: "来源文本", children: <TranscriptTimeline workspaceId={workspaceId} jobId={jobId} onSeek={seek} /> },
            { key: "visual", label: "帧 / OCR / 派生观察", children: <VisualTimeline workspaceId={workspaceId} jobId={jobId} onSeek={seek} /> },
            { key: "media", label: "受权播放", children: <VideoMediaLibrary workspaceId={workspaceId} jobId={jobId} startMs={seekMs} /> },
        ]} /> : <Typography.Paragraph>打开后按页加载来源记录；帧与音视频只有在明确点击并通过权限核对后才请求内容，不一次下载所有媒体。</Typography.Paragraph>}
    </Card>;
}

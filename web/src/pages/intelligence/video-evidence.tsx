import { Card, Descriptions, Tag, Typography } from "antd";
import { Callout } from "@/components/ui/product/callout/callout";
import type { EvidenceSnapshot } from "@/services/api/video-knowledge-review";
import { evidenceHighlight, formatEvidenceTime, mediaAvailabilityDescription, safeEvidenceSourceUrl } from "./video-evidence-utils";
import { VideoEvidenceTimeline } from "./video-evidence-timeline";
export { evidenceHighlight, formatEvidenceTime, safeEvidenceSourceUrl } from "./video-evidence-utils";

export function VideoEvidencePanel({ evidence, workspaceId }: { evidence: EvidenceSnapshot; workspaceId?: string }) {
    const highlight = evidenceHighlight(evidence);
    const url = safeEvidenceSourceUrl(evidence.url);
    if (["revoked", "erased"].includes(evidence.availability ?? "")) return <Callout tone="warning" title="来源材料已不可用">{mediaAvailabilityDescription(evidence.availability)}。仅保留证据标识 {evidence.evidence_id}，不展示旧原文。</Callout>;
    return <div className="space-y-4">
        <Callout title="固定修订的来源材料，不是模型结论">文本偏移为标题 + 两个换行 + 正文的 UTF-16 坐标。历史修订不会自动替换为最新文本。</Callout>
        <Descriptions bordered column={1} size="small" items={[
            { key: "id", label: "证据", children: <Typography.Text copyable>{evidence.evidence_id}</Typography.Text> },
            { key: "revision", label: "不可变修订", children: `${evidence.document_id} · r${evidence.revision}` },
            { key: "hash", label: "片段校验", children: <Typography.Text className="break-all" copyable>{evidence.snippet_hash}</Typography.Text> },
            { key: "offset", label: "UTF-16 偏移", children: `[${evidence.char_start}, ${evidence.char_end})` },
            { key: "time", label: "视频时间区间", children: `${formatEvidenceTime(evidence.start_ms)} — ${formatEvidenceTime(evidence.end_ms)}` },
            { key: "alignment", label: "对齐方式", children: evidence.alignment_method || "unknown" },
            { key: "type", label: "材料类型", children: evidence.material_type },
            { key: "origin", label: "原始来源分组", children: evidence.origin_cluster || "未声明；跨平台转载不自动算独立佐证" },
            { key: "availability", label: "媒体可用性", children: <>{evidence.availability && <Tag>{evidence.availability}</Tag>}{mediaAvailabilityDescription(evidence.availability)}</> },
            { key: "frame", label: "帧引用", children: evidence.frame_ref ? "存在固定帧引用；通过下方受权时轴读取，不将内部对象键作为地址" : "无帧证据" },
            { key: "source", label: "原来源", children: url ? <a href={url} target="_blank" rel="noopener noreferrer">打开平台原来源（不保证精确跳转）</a> : "来源链接不可用" },
        ]} />
        <Card size="small" title={evidence.title || "来源原文"}>
            {highlight ? <div className="whitespace-pre-wrap break-words">{highlight.before}<mark>{highlight.quote}</mark>{highlight.after}</div> : <><Callout tone="warning" title="文本与偏移无法一致核对">未伪造高亮或重算偏移；请重新载入或由复核人检查历史修订。</Callout><blockquote className="whitespace-pre-wrap">{evidence.quote}</blockquote></>}
        </Card>
        <Tag>未核对受权宿主播放地址时，不承诺本地播放；来源链接不作为播放器地址</Tag>
        {workspaceId && evidence.video_job_id && <VideoEvidenceTimeline key={`${evidence.video_job_id}:${evidence.revision}`} workspaceId={workspaceId} jobId={evidence.video_job_id} startMs={evidence.start_ms} />}
    </div>;
}

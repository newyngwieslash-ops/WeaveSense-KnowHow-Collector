import { useState } from "react";
import { Button, Input, Select, Space, Typography } from "antd";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { Callout } from "@/components/ui/product/callout/callout";
import { correctVideoTranscript, readVideoDocumentRevision, type VideoCorrectionReceipt, type VideoDocumentRevision, type VideoJob } from "@/services/api/video-knowledge";
import { HostIntelLink, MutationError, useVideoMutation } from "./video-common";

/** Corrections append immutable material revisions; they never edit knowledge or original evidence in place. */
export const correctionCommitted = (receipt: VideoCorrectionReceipt) => Number.isSafeInteger(receipt.revision) && Number(receipt.revision) > 0 && (!receipt.state || ["completed", "completed_with_gaps"].includes(receipt.state));
export function VideoTranscriptCorrection({ workspaceId, job, onChanged, onOpenJob }: { workspaceId: string; job: VideoJob; onChanged: () => void; onOpenJob: (id: string) => void }) {
    const mutation = useVideoMutation();
    const [snapshot, setSnapshot] = useState<VideoDocumentRevision>();
    const [evidenceId, setEvidenceId] = useState<string>();
    const [text, setText] = useState("");
    const [reason, setReason] = useState("");
    const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof correctVideoTranscript>>>();
    const open = () => mutation.run(async () => {
        if (!job.document_id || !job.revision) throw new Error("资料尚未建立可复核修订");
        const revision = await readVideoDocumentRevision(workspaceId, job.document_id, job.revision);
        if (!revision.content_hash || revision.revision !== job.revision) throw new Error("修订校验信息不完整，请重新加载任务");
        setSnapshot(revision); setEvidenceId(undefined); setText(""); setReason("");
    });
    const save = () => mutation.run(async () => {
        if (!snapshot || !evidenceId || !text.trim() || !reason.trim()) return;
        if (!snapshot.evidence.some(e => e.id === evidenceId)) throw new Error("片段不在当前固定修订中");
        setReceipt(await correctVideoTranscript(workspaceId, job.video_job_id, { expected_revision: snapshot.revision, expected_content_hash: snapshot.content_hash, reason: reason.trim(), patches: [{ evidence_id: evidenceId, text }] }));
        setSnapshot(undefined); onChanged();
    });
    return <div className="space-y-2">
        <Button disabled={mutation.busy || job.completion_level !== "knowledge_ready"} onClick={() => void open()}>人工校正转写（新修订）</Button><MutationError error={mutation.error} />
        {receipt && <Callout tone={correctionCommitted(receipt) ? "success" : "warning"} title={correctionCommitted(receipt) ? "校正已生成新修订" : "校正已受理，尚未生成可引用新修订"}><Space wrap><span>{correctionCommitted(receipt) ? `${receipt.document_id} · r${receipt.revision}` : `阶段 ${receipt.stage ?? receipt.state ?? "待核对"} · 拟生成 r${receipt.proposed_revision ?? "待定"}`}</span><Button onClick={() => onOpenJob(receipt.video_job_id)}>查看校正 / 索引任务</Button></Space>{!correctionCommitted(receipt) && <div>必须等待真实向量与资料就绪屏障；旧引用不变，不把排队成功当成新修订已发布。</div>}{correctionCommitted(receipt) && receipt.recheck_knowledge_ids && <div>服务端标记重新复核的已批准 / 已发布知识：{receipt.recheck_knowledge_ids.length} 条。{receipt.recheck_knowledge_ids.length > 0 && <HostIntelLink to={`/intelligence/video-knowledge?review=${encodeURIComponent(receipt.recheck_knowledge_ids[0])}`}>复核受影响知识</HostIntelLink>}</div>}</Callout>}
        <AppModal open={!!snapshot} title="校正来源转写 · 不覆盖历史证据" width={720} onCancel={() => !mutation.busy && setSnapshot(undefined)} onOk={() => void save()} confirmLoading={mutation.busy} okText="生成新修订" okButtonProps={{ disabled: !evidenceId || !text.trim() || !reason.trim() }}>
            <Callout>仅对选定来源片段进行人工更正。历史引用继续指向旧修订；依赖被更正证据的已批准 / 已发布知识将重新复核，不继续默认为有效。此次不提供新的精确时间，对齐以服务端结果为准。</Callout>
            <Typography.Paragraph>固定修订 r{snapshot?.revision} · {snapshot?.title}</Typography.Paragraph>
            <Select aria-label="待校正来源片段" className="w-full" showSearch optionFilterProp="label" placeholder="选择当前修订的证据片段" value={evidenceId} options={snapshot?.evidence.map(e => ({ value: e.id, label: `[${e.char_start}, ${e.char_end}) ${e.quote.slice(0, 100)}` }))} onChange={id => { setEvidenceId(id); setText(snapshot?.evidence.find(e => e.id === id)?.quote ?? ""); }} />
            <Input.TextArea aria-label="校正后的来源文字" value={text} onChange={e => setText(e.target.value)} rows={6} placeholder="校正后的来源文字（不是新增推断）" />
            <Input.TextArea aria-label="转写校正理由" value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="人工校正理由（必填）" /><MutationError error={mutation.error} />
        </AppModal>
    </div>;
}

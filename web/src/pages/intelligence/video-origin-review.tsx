import { useCallback, useEffect, useState } from "react";
import { Button, Card, Checkbox, Input, List, Select, Space, Tag, Typography } from "antd";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { Callout } from "@/components/ui/product/callout/callout";
import { ApiError } from "@/services/api/request";
import { listVideoOriginCandidates, readOriginMaterial, reviewVideoOriginCandidate, type OriginMaterialRef, type VideoOriginCandidate } from "@/services/api/video-origin-review";
import { MutationError, useVideoMutation, useVideoResource, VideoLoadState } from "./video-common";

const labels = { pending: "待人工核对", same_origin: "人工确认同源", independent: "人工确认独立", unavailable: "依据不可用" };
function OriginMaterial({ workspaceId, material, onReadable }: { workspaceId: string; material: OriginMaterialRef; onReadable: (readable: boolean) => void }) {
    const [offset, setOffset] = useState(0);
    const fetcher = useCallback((ws: string, signal: AbortSignal) => readOriginMaterial(ws, material, offset, signal), [material, offset]);
    const resource = useVideoResource(workspaceId, fetcher, 15000);
    useEffect(() => onReadable(!!resource.data && !resource.error), [resource.data, resource.error, onReadable]);
    return <Card size="small" title={`${material.document_id} · r${material.revision}`}>
        <Typography.Paragraph className="break-all">固定 hash：{material.revision_hash}<br />现有来源分组：{material.origin_cluster ?? "未声明"}</Typography.Paragraph>
        <VideoLoadState workspaceId={workspaceId} {...resource} onRetry={resource.refresh} />
        {resource.data && <><blockquote className="whitespace-pre-wrap break-words">{resource.data.text}</blockquote><Tag>UTF-16 {resource.data.offset} / {resource.data.coverage.total_chars}，不将当前页当全文</Tag></>}
        <Space><Button disabled={offset === 0} onClick={() => setOffset(0)}>全文首页</Button><Button disabled={resource.data?.coverage.next_offset == null} onClick={() => setOffset(resource.data!.coverage.next_offset!)}>下一段原文</Button></Space>
    </Card>;
}
function OriginQueue({ workspaceId }: { workspaceId: string }) {
    const [state, setState] = useState<string>("pending");
    const [cursor, setCursor] = useState<string>();
    const [selected, setSelected] = useState<VideoOriginCandidate>();
    const [decision, setDecision] = useState<"same_origin" | "independent">("same_origin");
    const [reason, setReason] = useState("");
    const [cluster, setCluster] = useState("");
    const [checked, setChecked] = useState(false);
    const [readable, setReadable] = useState({ left: false, right: false });
    const leftReadable = useCallback((value: boolean) => setReadable(previous => previous.left === value ? previous : { ...previous, left: value }), []);
    const rightReadable = useCallback((value: boolean) => setReadable(previous => previous.right === value ? previous : { ...previous, right: value }), []);
    const fetcher = useCallback((ws: string, signal: AbortSignal) => listVideoOriginCandidates(ws, state, cursor, signal), [state, cursor]);
    const resource = useVideoResource(workspaceId, fetcher);
    const mutation = useVideoMutation();
    const review = () => mutation.run(async () => {
        if (!selected || !checked || !readable.left || !readable.right || !reason.trim() || decision === "same_origin" && !cluster.trim()) return;
        try { await reviewVideoOriginCandidate(workspaceId, selected, { decision, reason: reason.trim(), ...(decision === "same_origin" ? { origin_cluster: cluster.trim() } : {}) }); setSelected(undefined); resource.refresh(); }
        catch (error) { if (error instanceof ApiError && error.status === 409) { setSelected(undefined); resource.refresh(); } throw error; }
    });
    return <div className="space-y-3">
        <Callout tone="warning" title="相似性仅用于提示，不自动合并来源">当前建议阈值：{String(resource.data?.baseline.threshold ?? "尚未读取")}，属于尚未校准的工程基线，不是“同源概率”或独立性证明。转载不会自动计作多源佐证；同源或独立必须检查双方固定修订并给出人工理由。</Callout>
        <Space><Select aria-label="近重复来源核对状态" value={state} onChange={value => { setState(value); setCursor(undefined); }} options={Object.entries(labels).map(([value, label]) => ({ value, label }))} /><Button onClick={resource.refresh}>刷新实际候选</Button></Space>
        <MutationError error={mutation.error} /><VideoLoadState workspaceId={workspaceId} {...resource} empty={resource.data?.items.length === 0 ? "当前页没有可读近重复候选，不等于已经证明全部来源独立" : undefined} onRetry={resource.refresh} />
        {resource.data && <List dataSource={resource.data.items} renderItem={candidate => <List.Item actions={[<Button key="review" disabled={candidate.state !== "pending" || candidate.unavailable || !candidate.proposal} onClick={() => { setSelected(candidate); setChecked(false); setReadable({ left: false, right: false }); setReason(""); setCluster(""); setDecision("same_origin"); }}>核对双方来源</Button>]}><List.Item.Meta title={<Space><span>{candidate.id}</span><Tag>{labels[candidate.state]}</Tag></Space>} description={candidate.proposal ? <><div>文本相似度指标 {candidate.proposal.score} · {candidate.proposal.evidence_kind}</div><div>{candidate.proposal.left.document_id} r{candidate.proposal.left.revision} ↔ {candidate.proposal.right.document_id} r{candidate.proposal.right.revision}</div></> : "仅保留审计标识，不展示已撤权依据"} /></List.Item>} />}
        <Space><Button disabled={!cursor} onClick={() => setCursor(undefined)}>核对首页</Button><Button disabled={!resource.data?.next_cursor} onClick={() => setCursor(resource.data!.next_cursor!)}>下一页候选</Button></Space>
        <AppModal open={!!selected} title="人工核对近重复来源 · 固定版本与来源分组" width={950} onCancel={() => !mutation.busy && setSelected(undefined)} onOk={() => void review()} confirmLoading={mutation.busy} okText="记录人工决定" okButtonProps={{ disabled: !checked || !readable.left || !readable.right || !reason.trim() || decision === "same_origin" && !cluster.trim() }}>
            {selected?.proposal && <div className="grid gap-3 md:grid-cols-2"><OriginMaterial key={`${selected.id}:left`} workspaceId={workspaceId} material={selected.proposal.left} onReadable={leftReadable} /><OriginMaterial key={`${selected.id}:right`} workspaceId={workspaceId} material={selected.proposal.right} onReadable={rightReadable} /></div>}
            <Typography.Paragraph className="break-all">候选预期 hash：{selected?.content_hash}</Typography.Paragraph>
            <Select aria-label="人工来源关系决定" value={decision} onChange={setDecision} options={[{ value: "same_origin", label: "同源 / 转载" }, { value: "independent", label: "经核对为独立来源" }]} />
            {decision === "same_origin" && <Input aria-label="确认后的原始来源分组" value={cluster} onChange={e => setCluster(e.target.value)} placeholder="人工指定的共同来源分组（必填；不自动生成）" />}
            <Input.TextArea aria-label="近重复来源复核理由" value={reason} onChange={e => setReason(e.target.value)} placeholder="复核依据与理由（必填）" rows={3} />
            <Checkbox checked={checked} onChange={e => setChecked(e.target.checked)}>我已核对双方固定修订及来源关系，不仅凭相似分数作决定</Checkbox>
            <Callout>服务端重新检查两个修订和当前来源分组；并发变更会拒绝并刷新。合并可能使原多源批准失效；不能以“独立”按钮拆开已经确认相同的分组。</Callout><MutationError error={mutation.error} />
        </AppModal>
    </div>;
}
export function VideoOriginReview({ workspaceId }: { workspaceId?: string }) {
    const [opened, setOpened] = useState(false);
    return <Card title="近重复 / 转载来源人工核对" extra={<Button disabled={!workspaceId} onClick={() => setOpened(!opened)}>{opened ? "关闭核对队列" : "读取核对队列"}</Button>}>{opened && workspaceId ? <OriginQueue key={workspaceId} workspaceId={workspaceId} /> : <Typography.Paragraph>显式复核入口；不混入普通已发布知识搜索，也不自动创建同源或独立性判断。</Typography.Paragraph>}</Card>;
}

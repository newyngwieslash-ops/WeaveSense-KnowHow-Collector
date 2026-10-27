import { useState } from "react";
import { Button, Card, Checkbox, Input, List, Select, Space, Tag, Typography } from "antd";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { Callout } from "@/components/ui/product/callout/callout";
import type { IntelSource } from "@/services/api/intelligence";
import { applyVideoRetentionBatch, previewVideoRetention, type VideoRetentionAction, type VideoRetentionBatch, type VideoRetentionPreview, type VideoRetentionTarget } from "@/services/api/video-retention";
import { describeVideoError, MutationError, useVideoMutation } from "./video-common";

export const RETENTION_ACTIONS: Array<{ value: VideoRetentionAction; label: string }> = [
    { value: "subscription_paused", label: "暂停订阅（不撤销已有知识）" },
    { value: "media_expired", label: "媒体访问到期（不清除文本知识）" },
    { value: "remote_unavailable", label: "标记原站不可用（不等于撤权）" },
    { value: "revoked", label: "撤销访问及依赖知识 / Skill" },
    { value: "erased", label: "清除内容及依赖（不可逆）" },
];
const CATEGORY: Record<string, string> = { sources: "关联来源", assets: "视频资产", jobs: "处理任务", objects: "注册对象", documents: "资料文档", evidence: "固定证据", knowledge: "知识单元", skills: "原生 Skill 候选", reports: "依赖报告", research: "依赖研究" };
const targetName = (target: VideoRetentionTarget) => target.source_id ? `来源 ${target.source_id}` : `资产 ${target.asset_id}`;
export function VideoRetentionImpactView({ preview }: { preview: VideoRetentionPreview }) {
    return <Card size="small" title={targetName(preview.target)}>
        <Space wrap>{Object.entries(preview.counts).map(([kind, count]) => <Tag key={kind}>{CATEGORY[kind] ?? kind}: {count}</Tag>)}</Space>
        <Typography.Paragraph>当前：已撤销文档 {preview.current_visibility.access_revoked_documents}；另有 {preview.current_visibility.remaining_documents_require_live_authorization} 份仍需实时授权核对；发布知识 {preview.current_visibility.published_knowledge}；未退休 Skill 候选 {preview.current_visibility.active_skill_candidates}。</Typography.Paragraph>
        <Typography.Paragraph>执行后：{preview.after_action.knowledge_revoked ? "关联知识撤回、Skill 退休，当前及历史内容读取均拒绝" : "不自动撤回知识；保留文本的读取仍受实时授权约束"}。{preview.after_action.content_erased ? "内容将清空；历史身份及哈希保留，不再承载原文。" : "不将本操作描述为全文清除。"}</Typography.Paragraph>
        <Typography.Paragraph>物理对象：已删除 {preview.physical_cleanup.deleted}，待清理 {preview.physical_cleanup.pending}，本次将请求清理 {preview.physical_cleanup.will_request}。访问失效不等于底层物理清理完成。</Typography.Paragraph>
        <details><summary>核对完整有界依赖 ID 与状态（不含原文、密钥或对象路径）</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(preview.dependencies, null, 2)}</pre></details>
        <details><summary>保留的审计与删除范围</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ after_action: preview.after_action, audit_retained: preview.audit_retained }, null, 2)}</pre></details>
        <Typography.Paragraph type="secondary" className="break-all">预览绑定 hash：{preview.preview_hash}；每类最多 {preview.limit_per_category}，超限会拒绝，不隐藏扩展目标。</Typography.Paragraph>
    </Card>;
}

function RetentionDialog({ workspaceId, sources, onChanged, onClose }: { workspaceId: string; sources: IntelSource[]; onChanged: () => void; onClose: () => void }) {
    const mutation = useVideoMutation();
    const [action, setAction] = useState<VideoRetentionAction>("revoked");
    const [mode, setMode] = useState<"sources" | "assets">("sources");
    const [sourceIds, setSourceIds] = useState<string[]>([]);
    const [assetIds, setAssetIds] = useState("");
    const [reason, setReason] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const [typed, setTyped] = useState("");
    const [previews, setPreviews] = useState<Array<{ preview: VideoRetentionPreview; key: string }>>([]);
    const [previewErrors, setPreviewErrors] = useState<string[]>([]);
    const [batchKey, setBatchKey] = useState<string>();
    const [receipt, setReceipt] = useState<VideoRetentionBatch>();
    const [submittedReason, setSubmittedReason] = useState<string>();
    const irreversible = action === "revoked" || action === "erased";
    const resetPreview = () => { setPreviews([]); setPreviewErrors([]); setConfirmed(false); setTyped(""); setReceipt(undefined); setBatchKey(undefined); setSubmittedReason(undefined); };
    const preview = () => mutation.run(async () => {
        resetPreview();
        const ids = mode === "sources" ? sourceIds : assetIds.split(/[\s,，]+/).filter(Boolean);
        if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error("请选择 1 至 20 个不同目标；不允许重复或无界批次");
        if (mode === "assets" && action === "subscription_paused") throw new Error("暂停订阅必须选择来源，不能选择资产");
        const loaded: typeof previews = [], errors: string[] = [];
        for (const id of ids) {
            const target: VideoRetentionTarget = mode === "sources" ? { source_id: id } : { asset_id: id };
            try { loaded.push({ preview: await previewVideoRetention(workspaceId, action, target), key: crypto.randomUUID() }); }
            catch (error) { errors.push(`${targetName(target)}：${describeVideoError(error)}`); }
        }
        setPreviews(loaded); setPreviewErrors(errors); setBatchKey(crypto.randomUUID());
    });
    const apply = () => mutation.run(async () => {
        if (!previews.length || previewErrors.length || !batchKey || !confirmed || !reason.trim() || irreversible && typed !== action) throw new Error("请先完整预览全部目标、填写原因并明确确认范围");
        const fixedReason = submittedReason ?? reason.trim();
        setSubmittedReason(fixedReason);
        const result = await applyVideoRetentionBatch(workspaceId, previews.map(({ preview: row, key }) => ({ ...row.target, action: row.action, reason: fixedReason, expected_impact_hash: row.preview_hash, idempotency_key: key, ...(irreversible ? { confirmation: row.action } : {}) })), batchKey);
        setReceipt(result); onChanged();
    });
    return <AppModal open title="来源 / 资产保留与撤权 · 先预览影响" width={960} onCancel={() => !mutation.busy && onClose()} footer={<Space><Button disabled={mutation.busy} onClick={onClose}>关闭</Button><Button danger={irreversible} loading={mutation.busy} disabled={!previews.length || !!previewErrors.length || !confirmed || !reason.trim() || irreversible && typed !== action} onClick={() => void apply()}>{submittedReason ? "用原键核对同一批操作" : "执行已确认目标"}</Button></Space>}>
        <div className="space-y-3">
            <Callout tone="warning">仅有来源写入权限的人工作业可执行。撤权 / 清除会影响依赖知识与原生 Skill；历史运行 pin、审计身份和财务事件保留，不重写无关画布、消息或财务。底层对象清理由实际 worker 回执确认。</Callout>
            <Select className="w-full" aria-label="保留操作" value={action} disabled={mutation.busy || !!submittedReason} options={RETENTION_ACTIONS} onChange={value => { setAction(value); resetPreview(); }} />
            <Select aria-label="目标类型" value={mode} disabled={mutation.busy || !!submittedReason} options={[{ value: "sources", label: "已授权来源（最多 20 个）" }, { value: "assets", label: "精确资产 ID（用于缩小影响范围）" }]} onChange={value => { setMode(value); resetPreview(); }} />
            {mode === "sources" ? <Select mode="multiple" className="w-full" aria-label="目标来源" value={sourceIds} disabled={mutation.busy || !!submittedReason} options={sources.map(source => ({ value: source.id, label: `${source.title || source.id} · ${source.status}` }))} onChange={value => { setSourceIds(value); resetPreview(); }} /> : <Input.TextArea aria-label="精确资产 ID" placeholder="每行一个 asset_id，最多 20 个；从实际任务详情读取，不输入 URL / 对象 key" value={assetIds} disabled={mutation.busy || !!submittedReason} onChange={event => { setAssetIds(event.target.value); resetPreview(); }} />}
            <Button disabled={mutation.busy} onClick={() => void preview()}>{previews.length || submittedReason ? "重新读取当前影响（将清除旧确认）" : "读取全部目标影响（不执行）"}</Button>
            <MutationError error={mutation.error} />{previewErrors.map(error => <MutationError key={error} error={error} />)}
            {previews.map(row => <VideoRetentionImpactView key={row.key} preview={row.preview} />)}
            {!!previews.length && <><Input.TextArea aria-label="操作审计原因" maxLength={2000} value={reason} disabled={mutation.busy || !!submittedReason} placeholder="说明授权依据及操作原因；不要填写密钥或无关个人信息" onChange={event => setReason(event.target.value)} /><Checkbox checked={confirmed} disabled={mutation.busy} onChange={event => setConfirmed(event.target.checked)}>已逐项核对完整 ID、依赖范围、保留审计与待清理状态；接受部分目标可能因版本变化被拒绝，不自动扩展范围</Checkbox>{irreversible && <Input aria-label="不可逆操作确认" value={typed} disabled={mutation.busy} placeholder={`输入 ${action} 确认${action === "erased" ? "不可逆内容清除" : "访问撤销和依赖失效"}`} onChange={event => setTyped(event.target.value)} />}</>}
            {receipt && <Card size="small" title={receipt.partial ? "部分已处理：其他目标并未视为成功" : "服务端逐目标结果"}><List dataSource={receipt.results} renderItem={result => <List.Item><div><Tag color={result.ok ? "green" : "red"}>{result.ok ? "已记录命令" : "失败 / 需核对"}</Tag>{targetName(result.target)}<div>{result.ok ? `知识撤权：${result.data?.knowledge_revoked ? "是" : "否"}；物理清理：${result.data?.physical_cleanup ?? "本操作未承诺清理完成"}` : `${result.status ?? "未知状态"} · ${result.reason ?? "未返回原因"}`}</div><Typography.Text copyable>{result.idempotency_key}</Typography.Text></div></List.Item>} /><Callout>409 预览变化必须重新预览并再次确认，不自动覆盖。网络 / 5xx 响应不明不代表没有写入；保留原键核对同一批操作，勿更换键重复执行。成功记录也不代表物理清理完成。</Callout></Card>}
        </div>
    </AppModal>;
}

export function VideoRetentionControls({ workspaceId, sources, onChanged }: { workspaceId?: string; sources: IntelSource[]; onChanged: () => void }) {
    const [open, setOpen] = useState(false);
    return <><Button danger disabled={!workspaceId} onClick={() => setOpen(true)}>保留 / 撤权影响与受控批次</Button>{open && workspaceId && <RetentionDialog key={workspaceId} workspaceId={workspaceId} sources={sources} onChanged={onChanged} onClose={() => setOpen(false)} />}</>;
}

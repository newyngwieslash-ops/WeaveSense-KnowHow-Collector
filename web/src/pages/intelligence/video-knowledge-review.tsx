import { useCallback, useEffect, useState } from "react";
import { Button, Card, Checkbox, Descriptions, Input, List, Select, Space, Tag, Typography } from "antd";
import { useNavigate, useSearchParams } from "react-router";
import { AppDrawer } from "@/components/ui/product/app-drawer/app-drawer";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { Callout } from "@/components/ui/product/callout/callout";
import { editVideoKnowledge, getVideoKnowledge, listVideoKnowledge, publishVideoKnowledge, reviewVideoKnowledge, searchPublishedKnowledge, withdrawVideoKnowledge, type EvidenceSnapshot, type KnowledgeRecord, type KnowledgeState, type KnowledgeUnit } from "@/services/api/video-knowledge-review";
import { CanvasHandoffModal, type CanvasHandoffDraft } from "./canvas-handoff-modal";
import { MutationError, useVideoMutation, useVideoResource, VideoLoadState } from "./video-common";
import { VideoEvidencePanel } from "./video-evidence";
import { VideoOriginReview } from "./video-origin-review";

export const KNOWLEDGE_STATE_LABEL: Record<KnowledgeState, string> = { candidate: "候选 · 未审核", in_review: "复核中", approved: "已批准 · 未发布", published: "已发布", rejected: "已拒绝", withdrawn: "已撤回", superseded: "已替代" };
const CLAIM_LABEL = { source_statement: "来源主张", observation: "材料观察", model_inference: "模型推断", cross_source_verified: "跨源核验" };
const renderLines = (items?: string[]) => items?.length ? items.join("；") : "材料未提供";
export function VideoKnowledgeReview({ workspaceId }: { workspaceId?: string }) {
    const [searchParams, setSearchParams] = useSearchParams();
    const [mode, setMode] = useState<"published" | "review">("published");
    const [state, setState] = useState<KnowledgeState>("candidate");
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState("");
    const [cursor, setCursor] = useState<string>();
    const [selected, setSelected] = useState<string>();
    useEffect(() => { const id = searchParams.get("review"); if (id) { setMode("review"); setSelected(id); } }, [searchParams]);
    const fetcher = useCallback((ws: string, signal: AbortSignal) => mode === "published" ? searchPublishedKnowledge(ws, search, signal, cursor) : listVideoKnowledge(ws, { state, cursor }, signal), [mode, state, search, cursor]);
    const resource = useVideoResource(workspaceId, fetcher, 15000);
    return <div className="p-4 space-y-4">
        <Callout title={mode === "published" ? "普通检索只返回有效的已发布知识" : "复核工作区 · 当前内容不代表已核实结论"}>{mode === "published" ? "没有答案时明确返回空，不会自动回退到未审核视频转写或候选知识。" : "来源主张、模型推断、材料就绪与发布状态分开标识。修改后旧批准失效，所有写入检查预期版本与 hash。"}</Callout>
        <Card title="视频知识" extra={<Button onClick={resource.refresh}>刷新</Button>}>
            <Space wrap className="mb-4"><Button aria-pressed={mode === "published"} onClick={() => { setMode("published"); setCursor(undefined); }}>已发布检索</Button><Button aria-pressed={mode === "review"} onClick={() => { setMode("review"); setCursor(undefined); }}>候选与复核</Button>
                {mode === "published" ? <Input.Search aria-label="检索已发布知识" value={query} onChange={e => setQuery(e.target.value)} onSearch={q => { setSearch(q.trim()); setCursor(undefined); }} placeholder="只检索已发布知识" allowClear /> : <Select aria-label="知识复核状态" value={state} onChange={value => { setState(value); setCursor(undefined); }} options={Object.entries(KNOWLEDGE_STATE_LABEL).map(([value, label]) => ({ value, label }))} />}
            </Space>
            <VideoLoadState workspaceId={workspaceId} {...resource} empty={resource.data?.items.length === 0 ? mode === "published" ? "未找到已发布知识；不会回退未审核材料" : "此状态暂无知识候选" : undefined} onRetry={resource.refresh} />
            {resource.data && <List dataSource={resource.data.items} renderItem={record => <List.Item actions={[<Button key="open" onClick={() => setSelected(record.id)}>查看与复核</Button>]}><List.Item.Meta title={<Space wrap>{record.unit.title}<Tag>{KNOWLEDGE_STATE_LABEL[record.state]}</Tag><Tag>{CLAIM_LABEL[record.unit.claim_kind]}</Tag></Space>} description={<><div>{record.unit.statement}</div><div>v{record.version} · 领域 {record.profile_id} v{record.profile_version} · {record.unit.evidence.length} 条证据</div>{record.unit.missing_fields.length > 0 && <Tag>缺失：{record.unit.missing_fields.join("、")}</Tag>}{record.unit.conflict_key && <Tag>冲突关系：{record.unit.conflict_key}</Tag>}</>} /></List.Item>} />}
            <Space className="mt-4"><Button disabled={!cursor} onClick={() => setCursor(undefined)}>首页</Button><Button disabled={!resource.data?.next_cursor} onClick={() => setCursor(resource.data!.next_cursor!)}>下一页</Button></Space>
        </Card>
        {mode === "review" && <VideoOriginReview workspaceId={workspaceId} />}
        <AppDrawer open={!!selected} onClose={() => { setSelected(undefined); if (searchParams.has("review")) { const next = new URLSearchParams(searchParams); next.delete("review"); setSearchParams(next, { replace: true }); } }} title="知识复核与发布" width={800}>
            {selected && workspaceId && <KnowledgeDetail key={`${workspaceId}:${selected}:${mode}`} workspaceId={workspaceId} id={selected} mode={mode} onChanged={resource.refresh} />}
        </AppDrawer>
    </div>;
}
type Decision = "submit" | "approve" | "reject" | "request_changes" | "publish" | "withdraw";
const DECISION_LABEL: Record<Decision, string> = { submit: "提交复核", approve: "批准此版本", reject: "拒绝", request_changes: "要求补证 / 修改", publish: "发布此批准版本", withdraw: "撤回已发布知识" };
function KnowledgeDetail({ workspaceId, id, mode, onChanged }: { workspaceId: string; id: string; mode: "published" | "review"; onChanged: () => void }) {
    const fetcher = useCallback((ws: string, signal: AbortSignal) => getVideoKnowledge(ws, id, signal, mode), [id, mode]);
    const resource = useVideoResource(workspaceId, fetcher, 10000);
    const mutation = useVideoMutation();
    const [evidence, setEvidence] = useState<EvidenceSnapshot>();
    const [decision, setDecision] = useState<{ type: Decision; snapshot: KnowledgeRecord }>();
    const [reason, setReason] = useState("");
    const [checks, setChecks] = useState({ evidence_support: false, critical_fields: false });
    const [editing, setEditing] = useState<{ snapshot: KnowledgeRecord; json: string }>();
    const [handoff, setHandoff] = useState<CanvasHandoffDraft>();
    const navigate = useNavigate();
    const record = resource.data;
    useEffect(() => { if (!record || record.unavailable) { setEvidence(undefined); setHandoff(undefined); setEditing(undefined); setDecision(undefined); } }, [record]);
    const choose = (type: Decision) => { if (record) { setDecision({ type, snapshot: record }); setReason(""); setChecks({ evidence_support: false, critical_fields: false }); } };
    const apply = () => mutation.run(async () => {
        if (!decision || !reason.trim()) return;
        const { type, snapshot } = decision;
        if (type === "publish") await publishVideoKnowledge(workspaceId, snapshot, reason.trim());
        else if (type === "withdraw") await withdrawVideoKnowledge(workspaceId, snapshot, reason.trim());
        else await reviewVideoKnowledge(workspaceId, snapshot, type, reason.trim(), type === "approve" ? checks : undefined);
        setDecision(undefined); setEvidence(undefined); setHandoff(undefined); resource.refresh(); onChanged();
    });
    const exportToCanvas = () => {
        if (!record || record.state !== "published") return;
        setHandoff({ kind: "analysis", title: record.unit.title, content: `[已发布知识 ${record.id} v${record.version}]\n${record.unit.statement}\n\n适用条件：${renderLines(record.unit.conditions)}\n边界：${renderLines(record.unit.boundaries)}`, citations: (record.evidence ?? []).map(e => ({ evidence_id: e.evidence_id, document_id: e.document_id, revision: e.revision, char_start: e.char_start, char_end: e.char_end, title: e.title, snippet: e.quote })), defaultPrompt: "请基于已发布知识和不可变证据完成分析；材料不足时明确说明，不扩展工具权限。" });
    };
    return <div className="space-y-4">
        <VideoLoadState workspaceId={workspaceId} {...resource} onRetry={resource.refresh} /><MutationError error={mutation.error} />
        {record?.unavailable && <Callout tone="warning" title="内容已撤回或被替代">仅保留审计墓碑：{record.id} v{record.version}。不会展示被撤回内容或静默换成其他来源。</Callout>}
        {record && !record.unavailable && <>
            <Typography.Title level={4}>{record.unit.title}</Typography.Title><Space wrap><Tag>{KNOWLEDGE_STATE_LABEL[record.state]}</Tag><Tag>{CLAIM_LABEL[record.unit.claim_kind]}</Tag><Tag>v{record.version}</Tag></Space>
            <Typography.Paragraph>{record.unit.statement}</Typography.Paragraph>
            <Descriptions column={1} bordered size="small" items={[
                { key: "type", label: "知识类型 / 领域", children: `${record.unit.type} / ${record.unit.domain_tags.join("、")}` },
                { key: "applicability", label: "适用对象", children: renderLines(record.unit.applicability) },
                { key: "conditions", label: "适用条件", children: renderLines(record.unit.conditions) },
                { key: "steps", label: "步骤", children: renderLines(record.unit.steps) },
                { key: "parameters", label: "参数与单位", children: record.unit.parameters.length ? record.unit.parameters.map((p, i) => <div key={i}>{p.name}：{p.value ?? "（数值缺失）"} {p.unit || "（单位缺失）"} · {renderLines(p.conditions)}</div>) : "材料未提供" },
                { key: "boundaries", label: "边界 / 反例", children: `${renderLines(record.unit.boundaries)} / ${renderLines(record.unit.counterexamples)}` },
                { key: "validity", label: "有效时间", children: `${record.unit.valid_from ?? "未声明"} — ${record.unit.valid_until ?? "未声明"}` },
                { key: "missing", label: "缺失信息", children: renderLines(record.unit.missing_fields) },
                { key: "conflict", label: "冲突关系", children: record.unit.conflict_key ?? "未声明；不代表没有冲突" },
                { key: "hash", label: "内容 hash", children: <Typography.Text copyable className="break-all">{record.content_hash}</Typography.Text> },
                { key: "release", label: "发布 receipt", children: record.release_id ?? "尚未发布" },
            ]} />
            <Card size="small" title="固定修订证据"><List dataSource={record.evidence ?? []} locale={{ emptyText: "没有可解析的证据快照，不能假定可发布" }} renderItem={e => <List.Item actions={[<Button key="view" onClick={() => setEvidence(e)}>核对原文与时间</Button>]}><List.Item.Meta title={`${e.title || e.document_id} · r${e.revision}`} description={e.quote} /></List.Item>} /></Card>
            <Space wrap>
                <Button disabled={mutation.busy || ["withdrawn", "superseded"].includes(record.state)} onClick={() => setEditing({ snapshot: record, json: JSON.stringify(record.unit, null, 2) })}>编辑为新版本</Button>
                <Button disabled={mutation.busy || !["candidate", "rejected"].includes(record.state)} onClick={() => choose("submit")}>提交复核</Button>
                <Button disabled={mutation.busy || record.state !== "in_review"} onClick={() => choose("approve")}>批准</Button>
                <Button disabled={mutation.busy || !["candidate", "in_review", "approved"].includes(record.state)} onClick={() => choose("request_changes")}>要求补证</Button>
                <Button disabled={mutation.busy || !["candidate", "in_review"].includes(record.state)} danger onClick={() => choose("reject")}>拒绝</Button>
                <Button type="primary" disabled={mutation.busy || record.state !== "approved"} onClick={() => choose("publish")}>发布</Button>
                <Button disabled={mutation.busy || record.state !== "published"} danger onClick={() => choose("withdraw")}>撤回</Button>
                <Button disabled={record.state !== "published"} onClick={exportToCanvas}>在宿主 Canvas 使用</Button>
                <Button onClick={resource.refresh}>重新加载版本</Button>
            </Space>
            <Callout>按钮状态只辅助操作，最终权限、当前证据、审核版本与内容 hash 由服务端检查。编辑不会继承旧批准。</Callout>
            <details><summary>复核与批准审计</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ approval: record.approval, reviews: record.reviews }, null, 2)}</pre></details>
        </>}
        <AppDrawer open={!!evidence} onClose={() => setEvidence(undefined)} title="时间轴与原文证据" width={680}>{evidence && <VideoEvidencePanel evidence={evidence} workspaceId={workspaceId} />}</AppDrawer>
        <AppModal open={!!decision} title={decision ? DECISION_LABEL[decision.type] : "复核"} onCancel={() => !mutation.busy && setDecision(undefined)} onOk={() => void apply()} confirmLoading={mutation.busy} okButtonProps={{ disabled: !reason.trim() || (decision?.type === "approve" && (!checks.evidence_support || !checks.critical_fields)), danger: decision?.type === "withdraw" || decision?.type === "reject" }}>
            <Typography.Paragraph>固定 v{decision?.snapshot.version} / {decision?.snapshot.content_hash}；版本改变会拒绝本次操作，不覆盖新内容。</Typography.Paragraph>
            {decision?.type === "approve" && <Space direction="vertical"><Checkbox checked={checks.evidence_support} onChange={e => setChecks({ ...checks, evidence_support: e.target.checked })}>我已核对原文证据支持该结论</Checkbox><Checkbox checked={checks.critical_fields} onChange={e => setChecks({ ...checks, critical_fields: e.target.checked })}>我已核对关键数值、单位与适用条件</Checkbox></Space>}
            <Input.TextArea aria-label="复核或发布理由" value={reason} onChange={e => setReason(e.target.value)} placeholder="理由（必填）" rows={3} /><MutationError error={mutation.error} />
        </AppModal>
        <AppModal open={!!editing} title="编辑知识 · 产生新版本并使旧批准失效" width={720} onCancel={() => !mutation.busy && setEditing(undefined)} confirmLoading={mutation.busy} onOk={() => void mutation.run(async () => { if (!editing) return; const unit = JSON.parse(editing.json) as KnowledgeUnit; if (!unit || typeof unit !== "object" || !unit.title || !Array.isArray(unit.evidence)) throw new Error("知识内容必须包含标题和证据列表"); await editVideoKnowledge(workspaceId, editing.snapshot, unit); setEditing(undefined); resource.refresh(); onChanged(); })}>
            <Input.TextArea aria-label="完整知识结构 JSON" rows={18} value={editing?.json} onChange={e => editing && setEditing({ ...editing, json: e.target.value })} /><MutationError error={mutation.error} />
        </AppModal>
        <CanvasHandoffModal workspaceId={workspaceId} draft={handoff} onClose={() => setHandoff(undefined)} onNavigate={url => void navigate(url)} />
    </div>;
}

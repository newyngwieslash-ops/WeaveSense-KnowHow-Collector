import { useCallback, useEffect, useState } from "react";
import { Button, Card, Descriptions, Form, Input, InputNumber, List, Select, Space, Table, Tag, Typography } from "antd";
import { AppDrawer } from "@/components/ui/product/app-drawer/app-drawer";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { Callout } from "@/components/ui/product/callout/callout";
import { installSkills, listSkills, type SkillDef, type SkillInstall } from "@/services/api/intelligence";
import { ApiError } from "@/services/api/request";
import { createVideoSkillCandidate, exportVideoSkillCandidate, getVideoSkillCandidate, searchPublishedKnowledge, listVideoSkillCandidates, requestVideoSkillEvaluation, reviewVideoSkillCandidate, installVideoSkillCandidate, type SkillCandidate, type SkillCandidateState } from "@/services/api/video-knowledge-review";
import { MutationError, useVideoMutation, useVideoResource, VideoLoadState } from "./video-common";

export const SKILL_STATE_LABEL: Record<SkillCandidateState, string> = { draft: "候选草稿", evaluation_running: "评测已请求 / 运行中", passed: "评测通过", approved_for_release: "已批准发布", release_package_exported: "源控发布包已导出", deployed: "已部署（未等于安装）", workspace_installed: "工作区已安装并 pin", rejected: "已退回", retired: "已退役" };
const publishedLoader = (ws: string, signal: AbortSignal) => searchPublishedKnowledge(ws, "", signal);
const nativeLoader = (ws: string) => listSkills(ws);
type CandidateForm = { base: string; knowledge: string[]; pack: string; rule_evidence: string; dataset: string; model_id: string; eval_budget: number; eval_max_tokens: number; cases: string };
const displayJson = (value: unknown) => JSON.stringify(value, null, 2) ?? "尚无服务端记录";
export function VideoSkillCandidates({ workspaceId }: { workspaceId?: string }) {
    const [cursor, setCursor] = useState<string>();
    const candidateLoader = useCallback((ws: string, signal: AbortSignal) => listVideoSkillCandidates(ws, signal, cursor), [cursor]);
    const candidates = useVideoResource(workspaceId, candidateLoader);
    const native = useVideoResource(workspaceId, nativeLoader);
    const published = useVideoResource(workspaceId, publishedLoader);
    const mutation = useVideoMutation();
    const [selected, setSelected] = useState<string>();
    const [creating, setCreating] = useState(false);
    const [pin, setPin] = useState<SkillDef>();
    const [pinExpectedHash, setPinExpectedHash] = useState<string>();
    const [form] = Form.useForm<CandidateForm>();
    const selectedKnowledge: string[] = Form.useWatch("knowledge", form) ?? [];
    const selectedEvidence = [...new Map((published.data?.items.filter(k => selectedKnowledge.includes(k.id)) ?? []).flatMap(k => k.unit.evidence).map(e => [e.evidence_id, e])).values()];
    const definitions = native.data?.packs.flatMap(p => p.skills) ?? [];
    const create = () => mutation.run(async () => {
        if (!workspaceId) return;
        const values = await form.validateFields();
        const base = definitions.find(s => `${s.id}:${s.version}:${s.hash}` === values.base);
        if (!base) throw new Error("基础原生 Skill 版本已不可用，请重新加载");
        const basePack = native.data?.packs.find(p => p.id === base.pack_id && p.skills.some(s => s.id === base.id && s.version === base.version && s.hash === base.hash));
        if (!basePack) throw new Error("基础原生包依赖信息缺失，无法冻结权限基线");
        const records = published.data?.items.filter(k => values.knowledge.includes(k.id)) ?? [];
        if (records.length !== values.knowledge.length || records.some(k => !k.release_id || k.state !== "published")) throw new Error("冻结知识必须来自当前有效已发布版本");
        const evidence = [...new Map(records.flatMap(k => k.unit.evidence).map(e => [e.evidence_id, e])).values()];
        const candidate = await createVideoSkillCandidate(workspaceId, { pack: JSON.parse(values.pack), base: { id: base.id, version: base.version, hash: base.hash, required_tools: basePack.required_tools ?? [] }, knowledge_releases: records.map(k => ({ knowledge_id: k.id, version: k.version, release_id: k.release_id, content_hash: k.content_hash })), evidence, rule_evidence: JSON.parse(values.rule_evidence), eval_spec: { dataset_version: values.dataset.trim(), model_config: { model: values.model_id.trim(), budget_micro: values.eval_budget, max_tokens: values.eval_max_tokens }, cases: JSON.parse(values.cases) } });
        setCreating(false); setSelected(candidate.id); candidates.refresh();
    });
    return <div className="p-4 space-y-4">
        <Callout title="方法发布与知识更新是两条独立流程">候选 → 固定评测 → 行业批准 → 源控包 → CI 构建 → 部署 → 工作区安装并 pin。这里不伪造评测、CI 或部署 receipt，也不将普通 SKILL.md 当成原生执行包。</Callout>
        <MutationError error={mutation.error} />
        <Card title="原生方法候选" extra={<Button type="primary" disabled={!workspaceId || !definitions.length || !published.data?.items.length} onClick={() => { form.resetFields(); setCreating(true); }}>创建候选</Button>}>
            <VideoLoadState workspaceId={workspaceId} {...candidates} empty={candidates.data?.items.length === 0 ? "尚无方法候选" : undefined} onRetry={candidates.refresh} />
            {candidates.data && <List dataSource={candidates.data.items} renderItem={candidate => <List.Item actions={[<Button key="detail" onClick={() => setSelected(candidate.id)}>审阅版本与评测</Button>]}><List.Item.Meta title={<Space>{candidate.id}<Tag>{SKILL_STATE_LABEL[candidate.state]}</Tag></Space>} description={<Typography.Text className="break-all">候选 hash：{candidate.candidate_hash}</Typography.Text>} /></List.Item>} />}
            <Space><Button disabled={!cursor} onClick={() => setCursor(undefined)}>候选首页</Button><Button disabled={!candidates.data?.next_cursor} onClick={() => setCursor(candidates.data!.next_cursor!)}>下一页候选</Button></Space>
        </Card>
        <Card title="已部署原生版本与当前工作区 pin" extra={<Button onClick={native.refresh}>刷新部署目录</Button>}>
            <VideoLoadState workspaceId={workspaceId} {...native} onRetry={native.refresh} />
            <Callout>只列出宿主实际加载的原生包。安装或回滚只更换本工作区 pin，不构建、不部署、不批准 MCP 连接，也不扩大工具权限。旧运行继续固定历史版本。</Callout>
            {native.data && <List dataSource={definitions} locale={{ emptyText: "宿主尚未加载可安装原生版本" }} renderItem={definition => {
                const installed = native.data!.installed.find(i => i.skillId === definition.id);
                const current = installed?.version === definition.version && installed.hash === definition.hash;
                return <List.Item actions={[<Button key="pin" disabled={mutation.busy || current} onClick={() => { setPinExpectedHash(installed?.hash); setPin(definition); }}>{current ? "当前 pin" : installed ? "切换 / 回滚到此版本" : "安装并 pin"}</Button>]}><List.Item.Meta title={<Space>{definition.name}<Tag>v{definition.version}</Tag>{current && <Tag>工作区已安装</Tag>}</Space>} description={<><div className="break-all">{definition.hash}</div><div>当前 pin：{installed ? `${installed.version} / ${installed.hash}` : "未安装"}</div></>} /></List.Item>;
            }} />}
        </Card>
        <AppDrawer open={!!selected} onClose={() => setSelected(undefined)} title="方法候选审阅" width={800}>{selected && workspaceId && <SkillCandidateDetail key={`${workspaceId}:${selected}`} workspaceId={workspaceId} id={selected} definitions={definitions} installed={native.data?.installed} onChanged={() => { candidates.refresh(); native.refresh(); }} />}</AppDrawer>
        <AppModal open={!!pin} title="确认更换原生 Skill 版本 pin" onCancel={() => !mutation.busy && setPin(undefined)} confirmLoading={mutation.busy} onOk={() => void mutation.run(async () => { if (!workspaceId || !pin) return; try { const candidate = candidates.data?.items.find(c => c.native_skill_hash === pin.hash); if (candidate) { if (candidate.unavailable) throw new Error("候选依赖已不可用，不能安装或通过回滚恢复已撤权依据。"); await installVideoSkillCandidate(workspaceId, candidate, pin, pinExpectedHash); } else { if (native.data?.packs.find(p => p.id === pin.pack_id)?.kind === "video-method") throw new Error("此方法必须从对应候选审阅页安装。请在候选列表翻页找到匹配 hash 的版本，不绕过部署与依赖检查。"); await installSkills(workspaceId, { skillId: pin.id, version: pin.version }); } setPin(undefined); native.refresh(); candidates.refresh(); } catch (error) { if (error instanceof ApiError && error.status === 409) { native.refresh(); candidates.refresh(); setPin(undefined); } throw error; } })}>
            <Typography.Paragraph>{pin?.name} · v{pin?.version}</Typography.Paragraph><Typography.Paragraph className="break-all">Hash: {pin?.hash}</Typography.Paragraph><Callout>服务端重新检查权限、部署和依赖，并比较打开确认框时的当前 pin：{pinExpectedHash ?? "尚未安装"}。并发冲突会刷新目录，必须重新确认，不自动覆盖。</Callout><MutationError error={mutation.error} />
        </AppModal>
        <AppModal open={creating} title="创建可执行原生方法候选" width={800} onCancel={() => !mutation.busy && setCreating(false)} confirmLoading={mutation.busy} onOk={() => void create()} okText="冻结候选">
            <MutationError error={mutation.error || published.error || native.error} />
            <Form form={form} layout="vertical" initialValues={{ eval_max_tokens: 8000 }}>
                <Form.Item name="base" label="基础原生版本（已部署）" rules={[{ required: true }]}><Select options={definitions.map(s => ({ value: `${s.id}:${s.version}:${s.hash}`, label: `${s.name} v${s.version}` }))} /></Form.Item>
                <Form.Item name="knowledge" label="冻结已发布知识与证据" rules={[{ required: true }]}><Select mode="multiple" options={published.data?.items.map(k => ({ value: k.id, label: `${k.unit.title} v${k.version}` }))} /></Form.Item>
                {published.data?.next_cursor && <Callout>这里只加载当前前 30 条有效已发布知识，不代表全部资料。其他知识请先在已发布检索页核对；本次仅能冻结已加载的明确版本。</Callout>}
                <Form.Item name="pack" label="完整原生 JSON skillpack（不是 SKILL.md，服务端执行 schema 校验）" rules={[{ required: true }]}><Input.TextArea rows={8} /></Form.Item>
                <Callout title="逐条规则的真实证据支持">请人工核对并填写 method 与每个 step:0、step:1 等规则的证据映射。只能使用下方已选发布版本的证据 ID；系统不会替你编造“支持”关系。</Callout>
                <details open><summary>当前冻结可用证据 ID / 修订 / hash</summary><pre className="whitespace-pre-wrap break-all">{displayJson(selectedEvidence)}</pre></details>
                <Form.Item name="rule_evidence" label="逐规则证据映射 JSON（method 与每一步均须唯一映射）" rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={5} placeholder='[{"rule":"method","evidence_ids":["已核对的真实证据ID"]},{"rule":"step:0","evidence_ids":["已核对的真实证据ID"]}]' /></Form.Item>
                <Form.Item name="dataset" label="固定评测集版本" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
                <Form.Item name="model_id" label="固定宿主模型 ID（不填写 API key）" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
                <Form.Item name="eval_budget" label="固定模型预算（micro）" rules={[{ required: true }, { type: "number", min: 1 }]}><InputNumber min={1} precision={0} /></Form.Item>
                <Form.Item name="eval_max_tokens" label="单次输出 token 上限" rules={[{ required: true }]}><InputNumber min={1} max={16384} precision={0} /></Form.Item>
                <Form.Item name="cases" label="评测用例 JSON（positive / negative / boundary / missing_material / regression）" rules={[{ required: true }]}><Input.TextArea rows={6} placeholder='[{"id":"…","kind":"positive","input":"…","expected":"…"}]' /></Form.Item>
                <Callout>真实评测比较基础版本、无 Skill 基线与候选。当前评分器 exact_expected_output_v1 精确比较 expected 字符串，不替代行业人工复核。未取得评测服务结果前，不会自动通过或成为生产可用 Skill。</Callout>
            </Form>
        </AppModal>
    </div>;
}
type EvalCase = { id: string; critical_failure: boolean; base: { score: number; passed: boolean }; without_skill: { score: number; passed: boolean }; candidate: { score: number; passed: boolean } };
function SkillCandidateDetail({ workspaceId, id, definitions, installed, onChanged }: { workspaceId: string; id: string; definitions: SkillDef[]; installed?: SkillInstall[]; onChanged: () => void }) {
    const fetcher = useCallback((ws: string, signal: AbortSignal) => getVideoSkillCandidate(ws, id, signal), [id]);
    const resource = useVideoResource(workspaceId, fetcher, 10000);
    const mutation = useVideoMutation();
    const [decision, setDecision] = useState<{ candidate: SkillCandidate; action: "approve" | "reject" }>();
    const [reason, setReason] = useState("");
    const [release, setRelease] = useState<Record<string, unknown>>();
    const [installing, setInstalling] = useState<SkillCandidate>();
    const [installExpectedHash, setInstallExpectedHash] = useState<string>();
    const [installReceipt, setInstallReceipt] = useState<Awaited<ReturnType<typeof installVideoSkillCandidate>>>();
    const candidate = resource.data;
    useEffect(() => { if (!candidate || candidate.unavailable) { setRelease(undefined); setInstallReceipt(undefined); setDecision(undefined); setInstalling(undefined); } }, [candidate]);
    const frozenBase = candidate?.proposal?.base as { id?: string; version?: string; hash?: string; required_tools?: string[] } | undefined;
    const baseDefinition = definitions.find(d => d.id === frozenBase?.id && d.version === frozenBase?.version && d.hash === frozenBase?.hash);
    const proposedPack = candidate?.proposal?.pack as { required_tools?: string[]; skills?: { method?: string; steps?: string[] }[] } | undefined;
    const proposedMethod = proposedPack?.skills?.[0];
    const evalCases = Array.isArray(candidate?.eval_result?.cases) ? candidate.eval_result.cases as EvalCase[] : [];
    const act = (action: () => Promise<unknown>) => mutation.run(async () => { try { await action(); resource.refresh(); onChanged(); } catch (error) { if (error instanceof ApiError && error.status === 409) { resource.refresh(); onChanged(); } throw error; } });
    return <div className="space-y-4"><VideoLoadState workspaceId={workspaceId} {...resource} onRetry={resource.refresh} /><MutationError error={mutation.error} />
        {candidate?.unavailable && <Callout tone="warning" title="候选内容或依赖已不可用">仅保留审计标识 {candidate.id}；不会展示被清除的方法、证据或发布包，也不能安装或通过历史版本回滚恢复失效依据。</Callout>}
        {candidate && !candidate.unavailable && <>
            <Tag>{SKILL_STATE_LABEL[candidate.state]}</Tag>
            <Descriptions bordered column={1} size="small" items={[
                { key: "hash", label: "候选 hash", children: <Typography.Text copyable className="break-all">{candidate.candidate_hash}</Typography.Text> },
                { key: "native", label: "原生 Skill hash", children: candidate.native_skill_hash },
                { key: "approval", label: "行业批准", children: candidate.approval ? displayJson(candidate.approval) : "未批准" },
                { key: "deployment", label: "部署 / 安装凭证", children: candidate.receipts?.length ? <pre className="whitespace-pre-wrap break-all">{displayJson(candidate.receipts)}</pre> : "无实际 receipt；批准和导出均不代表已部署或安装" },
            ]} />
            <Card size="small" title="方法版本对比">
                <div className="grid gap-4 md:grid-cols-2"><div><Typography.Title level={5}>基础版本 {frozenBase?.version}</Typography.Title>{baseDefinition ? <><Typography.Paragraph>{baseDefinition.method}</Typography.Paragraph><ol>{baseDefinition.steps?.map((step, index) => <li key={index}>{step}</li>)}</ol></> : <Callout tone="warning">当前构建未加载匹配此 hash 的历史基础包。保留冻结标识，不用最新版本冒充比较基线。</Callout>}</div><div><Typography.Title level={5}>候选方法</Typography.Title><Typography.Paragraph>{proposedMethod?.method ?? "未提供"}</Typography.Paragraph><ol>{proposedMethod?.steps?.map((step, index) => <li key={index}>{step}</li>)}</ol></div></div>
                <div>基础工具：{frozenBase?.required_tools?.join("、") || "无"}</div><div>候选工具：{proposedPack?.required_tools?.join("、") || "无"}</div>
                <details><summary>冻结证据、知识版本、评测输入与完整规则</summary><pre className="whitespace-pre-wrap break-all">{displayJson(candidate.proposal)}</pre></details>
            </Card>
            <Card size="small" title="固定评测结果">
                {evalCases.length > 0 ? <Table<EvalCase> rowKey="id" size="small" pagination={{ pageSize: 10 }} dataSource={evalCases} columns={[
                    { title: "用例", dataIndex: "id" },
                    { title: "原版本", render: (_, row) => row.base ? `${row.base.score} · ${row.base.passed ? "通过" : "失败"}` : "未返回" },
                    { title: "无 Skill", render: (_, row) => row.without_skill ? `${row.without_skill.score} · ${row.without_skill.passed ? "通过" : "失败"}` : "未返回" },
                    { title: "候选", render: (_, row) => row.candidate ? `${row.candidate.score} · ${row.candidate.passed ? "通过" : "失败"}` : "未返回" },
                    { title: "关键错误", render: (_, row) => row.critical_failure ? <Tag>阻断发布</Tag> : "未标记" },
                ]} /> : <Typography.Paragraph>尚无服务端评测结果，不显示模拟分数。</Typography.Paragraph>}
                <details><summary>评测原始记录与运行 / usage 引用</summary><pre className="whitespace-pre-wrap break-all">{displayJson(candidate.eval_result)}</pre></details>{candidate.state === "evaluation_running" && <Callout title={candidate.eval_result?.blocked_reason ? "固定评测被阻断" : "等待真实评测服务"}>请求已持久化；如果评测器或模型预算未就绪，将保持等待，不模拟分数或自动批准。{candidate.eval_result?.blocked_reason ? ` 原因：${String(candidate.eval_result.blocked_reason)}` : ""}</Callout>}
            </Card>
            <Space wrap>
                <Button disabled={mutation.busy || !(candidate.state === "draft" || (candidate.state === "evaluation_running" && candidate.eval_result?.blocked_reason))} onClick={() => void act(() => requestVideoSkillEvaluation(workspaceId, candidate))}>{candidate.eval_result?.blocked_reason ? "核对授权 / 预算后恢复固定评测" : "请求固定评测"}</Button>
                <Button type="primary" disabled={mutation.busy || candidate.state !== "passed"} onClick={() => { setReason(""); setDecision({ candidate, action: "approve" }); }}>批准发布候选</Button>
                <Button danger disabled={mutation.busy || candidate.state !== "passed"} onClick={() => { setReason(""); setDecision({ candidate, action: "reject" }); }}>退回</Button>
                <Button disabled={mutation.busy || candidate.state !== "approved_for_release"} onClick={() => void act(async () => setRelease(await exportVideoSkillCandidate(workspaceId, candidate)))}>生成源控发布包</Button>
                <Button disabled={mutation.busy || !installed || !["deployed", "workspace_installed"].includes(candidate.state)} onClick={() => { const pack = candidate.proposal?.pack as { skills?: { id: string }[] } | undefined; setInstallExpectedHash(installed?.find(i => i.skillId === pack?.skills?.[0]?.id)?.hash); setInstalling(candidate); }}>安装 / 回滚到此候选版本</Button>
                <Button onClick={resource.refresh}>刷新实际状态</Button>
            </Space>
            {(release || candidate.release_package) && <Card size="small" title="已生成的源控发布包"><Callout>需进入现有代码评审、CI 与部署流程。此操作没有执行部署或安装。</Callout><pre className="whitespace-pre-wrap break-all">{displayJson(release ?? candidate.release_package)}</pre><Button onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(release ?? candidate.release_package, null, 2)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `skill-candidate-${candidate.id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>保存发布包 JSON</Button></Card>}
            {installReceipt && <Callout title="宿主安装命令已返回"><div>版本：{installReceipt.installed.version} · 回执状态：{installReceipt.receipt_status}</div><Typography.Text copyable>{installReceipt.receipt_operation_id}</Typography.Text><div>历史运行 pin：{installReceipt.run_pins_unchanged ? "保持不变" : "以服务端审计为准"}</div></Callout>}
        </>}
        <AppModal open={!!decision} title={decision?.action === "approve" ? "批准候选进入源控发布" : "退回候选"} onCancel={() => !mutation.busy && setDecision(undefined)} confirmLoading={mutation.busy} okButtonProps={{ disabled: !reason.trim() }} onOk={() => void act(async () => { if (!decision) return; await reviewVideoSkillCandidate(workspaceId, decision.candidate, decision.action, reason.trim()); setDecision(undefined); })}>
            <Typography.Paragraph className="break-all">冻结 hash：{decision?.candidate.candidate_hash}</Typography.Paragraph><Input.TextArea aria-label="方法候选审阅理由" value={reason} onChange={e => setReason(e.target.value)} placeholder="行业审阅理由（必填）" /><MutationError error={mutation.error} />
        </AppModal>
        <AppModal open={!!installing} title="确认安装并 pin 已部署候选" onCancel={() => !mutation.busy && setInstalling(undefined)} confirmLoading={mutation.busy} onOk={() => void act(async () => { if (!installing || installing.unavailable) return; const pack = installing.proposal?.pack as { skills?: { id: string; version: string }[] } | undefined; const skill = pack?.skills?.[0]; if (!skill?.id || !skill.version) throw new Error("候选缺少可验证原生版本"); setInstallReceipt(await installVideoSkillCandidate(workspaceId, installing, skill, installExpectedHash)); setInstalling(undefined); })}>
            <Callout>服务端必须核对已部署 receipt、实际嵌入包 hash、当前证据依赖与工作区权限。当前 pin 预期值：{installExpectedHash ?? "尚未安装"}。冲突后刷新并重新确认，不自动覆盖；回滚不能恢复已撤权依据。</Callout><Typography.Paragraph className="break-all">候选：{installing?.candidate_hash}</Typography.Paragraph><MutationError error={mutation.error} />
        </AppModal>
    </div>;
}

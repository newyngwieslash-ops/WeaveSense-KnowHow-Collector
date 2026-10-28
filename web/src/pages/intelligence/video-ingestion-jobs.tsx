import { useCallback, useEffect, useState } from "react";
import { Button, Card, Collapse, Descriptions, Input, List, Select, Space, Table, Tag, Typography } from "antd";
import { Link, useSearchParams } from "react-router";
import { AppDrawer } from "@/components/ui/product/app-drawer/app-drawer";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { Callout } from "@/components/ui/product/callout/callout";
import { cancelVideoJob, getVideoJob, listVideoJobs, readVideoArtifacts, reconcileVideoJob, retryVideoJob, type VideoJob, type VideoStage } from "@/services/api/video-knowledge";
import { listKnowledgeExtractions, retryKnowledgeExtraction, type KnowledgeExtractionRun } from "@/services/api/video-knowledge-review";
import { MutationError, useVideoMutation, useVideoResource, VideoLoadState, VIDEO_STATE_LABEL, VideoState } from "./video-common";
import { VideoTranscriptCorrection } from "./video-transcript-correction";
import { VideoEvidenceTimeline } from "./video-evidence-timeline";
import { VideoInsights } from "./video-insights";

const terminal = new Set(["completed", "completed_with_gaps", "cancelled", "failed"]);
const errorText = (value: VideoJob["error"]) => typeof value === "string" ? value : value ? `${value.code ?? ""} ${value.message ?? ""}` : "—";
const INTENT_LABEL: Record<NonNullable<VideoStage["submission_intent_state"]>, string> = { none: "无记录", prepared: "已准备", submitted: "已提交", accepted: "已接收", resume_requested: "已请求恢复", terminal: "意图终态", unknown: "未知" };
const EXTERNAL_LABEL: Record<NonNullable<VideoStage["external_observed_state"]>, string> = { unknown: "未知", pending: "待处理（pending）", completed: "完成（completed）", failed: "失败（failed）", reconciliation_required: "结果不明，需核对（reconciliation_required）" };
export function KnowledgeExtractionRecovery({ run, busy, onRetry }: { run: KnowledgeExtractionRun; busy: boolean; onRetry: () => void }) {
    const retryable = ["failed", "blocked_auth", "blocked_budget", "reconciliation_required"].includes(run.state);
    if (!retryable) return null;
    const reconcileOnly = run.state === "reconciliation_required" || Boolean(run.external_task_id && !["failed", "cancelled", "succeeded"].includes(run.external_task_status ?? ""));
    return <Space direction="vertical"><Typography.Text type="secondary">冻结版本与已发生费用不变。只有确认终态才创建新尝试，仍受原总预算限制；结果不明只核对原任务。</Typography.Text><Button disabled={busy} onClick={onRetry}>{reconcileOnly ? "核对整理结果" : "恢复知识整理"}</Button></Space>;
}
/** An observed response is historical; local cancellation/completion is never remote evidence. */
export function VideoExternalStageSummary({ stage, hostState }: { stage: VideoStage; hostState?: VideoJob["state"] }) {
    const observed = stage.external_observed_state && EXTERNAL_LABEL[stage.external_observed_state];
    const confirmed = stage.external_task_known === true && observed && stage.external_observed_state !== "unknown" && stage.external_observed_at && Number.isFinite(Date.parse(stage.external_observed_at));
    return <div aria-label="外部执行状态摘要" className="space-y-1">
        <Typography.Text type="secondary">提交意图：{INTENT_LABEL[stage.submission_intent_state ?? "unknown"] ?? "未知"} · 外部任务：{stage.external_task_known === true ? "身份已确认" : stage.external_task_known === false ? "身份未确认" : "身份未返回"} · 最近已确认外部状态：{confirmed ? observed : "未知（尚无确认响应）"}</Typography.Text>
        {confirmed && <div>历史观测时间：{stage.external_observed_at}；不是当前状态保证。</div>}
        {(hostState === "cancelled" || hostState === "cancel_requested" || stage.state === "cancelled") && <div>宿主取消不代表远端已停止；保留最后观测，远端取消结果请单独核对。</div>}
    </div>;
}
export function VideoIngestionJobs({ workspaceId }: { workspaceId?: string }) {
    const [searchParams, setSearchParams] = useSearchParams();
    const [state, setState] = useState<string>();
    const [cursor, setCursor] = useState<string>();
    const [selected, setSelected] = useState<string>();
    useEffect(() => { const jobId = searchParams.get("job"); if (jobId) setSelected(jobId); }, [searchParams]);
    const [recoveryKey, setRecoveryKey] = useState("");
    const fetcher = useCallback((ws: string, signal: AbortSignal) => listVideoJobs(ws, { state, cursor }, signal), [state, cursor]);
    const resource = useVideoResource(workspaceId, fetcher, 10000);
    const mutation = useVideoMutation();
    const groups = new Map<string, VideoJob[]>();
    for (const job of resource.data?.items ?? []) groups.set(job.operation_id, [...(groups.get(job.operation_id) ?? []), job]);
    return <div className="p-4 space-y-4">
        <Callout title="阶段来自服务端持久任务，不使用估算百分比">资料就绪、知识发布与 Skill 安装各自独立。外部停止状态未知时，宿主取消不代表远端已经停止，实际 usage 仍保留。</Callout>
        <Card title="视频任务" extra={<Button onClick={resource.refresh}>刷新</Button>}>
            <Space wrap className="mb-4"><Select aria-label="任务状态" allowClear placeholder="全部状态" value={state} className="min-w-48" onChange={value => { setState(value); setCursor(undefined); }} options={Object.entries(VIDEO_STATE_LABEL).map(([value, label]) => ({ value, label }))} />
                <Input aria-label="丢失响应的提交恢复键" placeholder="提交恢复键（即使没有 job ID 也可找回）" value={recoveryKey} onChange={e => setRecoveryKey(e.target.value)} />
                <Button disabled={!workspaceId || !recoveryKey.trim() || mutation.busy} onClick={() => void mutation.run(async () => { const job = await reconcileVideoJob(workspaceId!, { idempotency_key: recoveryKey.trim() }); setSelected(job.video_job_id); resource.refresh(); })}>核对并找回</Button>
            </Space>
            <MutationError error={mutation.error} />
            <VideoLoadState workspaceId={workspaceId} {...resource} empty={resource.data?.items.length === 0 ? "没有符合条件的视频任务" : undefined} onRetry={resource.refresh} />
            {resource.data && <><Typography.Paragraph type="secondary">按批次展开视频 / 分P；数量是当前分页中的任务数，不是未加载批次的总量。</Typography.Paragraph><Collapse items={[...groups].map(([operationId, jobs]) => ({ key: operationId, label: <Space wrap><span>{operationId}</span><Tag>本页 {jobs.length} 个视频任务</Tag><Tag>{jobs.filter(j => j.completion_level === "knowledge_ready").length} 个资料就绪</Tag></Space>, children: <Table<VideoJob> rowKey="video_job_id" dataSource={jobs} pagination={false} scroll={{ x: true }} columns={[
                { title: "批次 / 视频任务", key: "id", render: (_, job) => <><Typography.Text copyable>{job.operation_id}</Typography.Text><div><Button type="link" onClick={() => setSelected(job.video_job_id)}>{job.video_job_id}</Button></div>{job.part_id && <Tag>分P {job.part_id}</Tag>}</> },
                { title: "真实阶段", key: "state", render: (_, job) => <><VideoState state={job.state} /><div>{job.stage}</div></> },
                { title: "独立就绪状态", key: "ready", render: (_, job) => <><Tag>{job.completion_level === "knowledge_ready" ? "资料已就绪" : job.completion_level === "input_ready" ? "输入已获取，待处理/索引" : "资料未就绪"}</Tag><div>知识发布：{job.publication_state ?? "请在知识复核页确认"}</div></> },
                { title: "来源 / 冻结领域", key: "scope", render: (_, job) => <>{job.source_id}<div>{job.profile_id} v{job.profile_version}</div></> },
                { title: "缺口 / 原因", key: "reason", render: (_, job) => <>{job.coverage?.missing?.length ? <Tag>必需缺口 {job.coverage.missing.join("、")}</Tag> : null}<div>{errorText(job.error)}</div></> },
            ]} /> }))} /></>}
            <Space className="mt-4"><Button disabled={!cursor} onClick={() => setCursor(undefined)}>回到首页</Button><Button disabled={!resource.data?.next_cursor} onClick={() => setCursor(resource.data!.next_cursor!)}>下一页</Button></Space>
        </Card>
        <VideoInsights workspaceId={workspaceId} onOpenJob={setSelected} />
        <AppDrawer open={!!selected} onClose={() => { setSelected(undefined); if (searchParams.has("job")) { const next = new URLSearchParams(searchParams); next.delete("job"); setSearchParams(next, { replace: true }); } }} title="视频任务详情" width={760}>
            {workspaceId && selected && <VideoIngestionDetail key={`${workspaceId}:${selected}`} workspaceId={workspaceId} jobId={selected} onChanged={resource.refresh} onOpenJob={setSelected} />}
        </AppDrawer>
    </div>;
}
function VideoIngestionDetail({ workspaceId, jobId, onChanged, onOpenJob }: { workspaceId: string; jobId: string; onChanged: () => void; onOpenJob: (id: string) => void }) {
    const fetcher = useCallback((ws: string, signal: AbortSignal) => getVideoJob(ws, jobId, signal), [jobId]);
    const resource = useVideoResource(workspaceId, fetcher, 5000);
    const extractionFetcher = useCallback((ws: string, signal: AbortSignal) => listKnowledgeExtractions(ws, jobId, signal), [jobId]);
    const extractions = useVideoResource(workspaceId, extractionFetcher, 10000);
    const mutation = useVideoMutation();
    const [cancelOpen, setCancelOpen] = useState(false);
    const [reason, setReason] = useState("");
    const [artifacts, setArtifacts] = useState<Awaited<ReturnType<typeof readVideoArtifacts>>>();
    const job = resource.data;
    const act = (action: () => Promise<unknown>) => mutation.run(async () => { await action(); resource.refresh(); onChanged(); });
    return <div className="space-y-4">
        <VideoLoadState workspaceId={workspaceId} {...resource} onRetry={resource.refresh} />
        <MutationError error={mutation.error} />
        {job && <>
            <Space wrap><VideoState state={job.state} /><Tag>{job.stage}</Tag><Button disabled={mutation.busy || terminal.has(job.state) || job.state === "cancel_requested"} danger onClick={() => setCancelOpen(true)}>请求取消</Button>
                <Button disabled={mutation.busy || !["failed", "retry_wait", "blocked_auth", "blocked_budget"].includes(job.state)} onClick={() => void act(() => retryVideoJob(workspaceId, jobId))}>重试失败阶段</Button>
                <Button disabled={mutation.busy} onClick={() => void act(() => reconcileVideoJob(workspaceId, { video_job_id: jobId }))}>核对外部结果</Button></Space>
            {job.state === "blocked_auth" && <Callout tone="warning" title="需要更新授权">请由来源维护人检查有效授权或凭据。<Link to="/intelligence/mcp">打开连接与授权</Link>；此处不会收集 Cookie 或绕过登录。</Callout>}
            {job.state === "blocked_budget" && <Callout tone="warning" title="预算阻断">请在宿主工作区预算中核对额度，恢复后再重试。已发生 usage 不会清零。<Link to="/intelligence/connections">打开工作区管理</Link></Callout>}
            {job.state === "reconciliation_required" && <Callout tone="warning" title="远端是否接单尚不明确">仅核对现有任务，禁止通过重复提交尝试恢复。需要提供方确认时保持阻断。</Callout>}
            <Descriptions column={1} bordered size="small" items={[
                { key: "operation", label: "Operation", children: <Typography.Text copyable>{job.operation_id}</Typography.Text> },
                { key: "job", label: "Video job", children: <Typography.Text copyable>{job.video_job_id}</Typography.Text> },
                { key: "source", label: "来源 / 资产", children: `${job.source_id} / ${job.asset_id}` },
                { key: "profile", label: "冻结领域版本", children: `${job.profile_id} v${job.profile_version}` },
                { key: "ready", label: "资料就绪", children: job.completion_level },
                { key: "publication", label: "知识发布", children: job.publication_state ?? "独立复核发布，任务成功不代表已发布" },
                { key: "remote", label: "远端取消结果", children: job.remote_cancel_status ?? "未请求 / 未确认" },
                { key: "media", label: "媒体可用性", children: job.media_availability ?? "未确认，不承诺可播放" },
                { key: "document", label: "文档修订", children: job.document_id ? `${job.document_id} · r${job.revision ?? "未知"}` : "尚未建立" },
                { key: "error", label: "失败原因", children: errorText(job.error) },
            ]} />
            <Card size="small" title="阶段与尝试"><List dataSource={job.stages ?? []} locale={{ emptyText: "服务端尚未返回阶段记录" }} renderItem={stage => <List.Item><div className="space-y-2"><Space wrap><Tag>{stage.stage}</Tag>{stage.state === "completed" ? <Tag>阶段完成</Tag> : <VideoState state={stage.state} />}<span>尝试 {stage.attempt}</span>{stage.next_poll_at && <span>下次轮询 {stage.next_poll_at}</span>}<Typography.Text type={stage.error ? "danger" : "secondary"}>{errorText(stage.error)}</Typography.Text></Space><VideoExternalStageSummary stage={stage} hostState={job.state} /></div></List.Item>} /></Card>
            <Card size="small" title="真实覆盖与能力"><div>可用能力：{job.available_capabilities?.join("、") || "尚未返回"}</div><pre className="whitespace-pre-wrap break-all">{JSON.stringify(job.coverage ?? {}, null, 2)}</pre></Card>
            <VideoEvidenceTimeline workspaceId={workspaceId} jobId={jobId} />
            <VideoTranscriptCorrection workspaceId={workspaceId} job={job} onChanged={() => { resource.refresh(); onChanged(); }} onOpenJob={onOpenJob} />
            <Card size="small" title="已记录 usage"><pre className="whitespace-pre-wrap break-all">{job.usage ? JSON.stringify(job.usage, null, 2) : "尚未返回计量，不等于零成本"}</pre></Card>
            <Card size="small" title="ready 后独立知识整理运行">
                <VideoLoadState workspaceId={workspaceId} {...extractions} empty={extractions.data?.items.length === 0 ? "尚无关联整理运行；资料就绪不等于候选已生成" : undefined} onRetry={extractions.refresh} />
                {extractions.data && <List dataSource={extractions.data.items} renderItem={run => <List.Item><div className="space-y-2"><Typography.Text copyable>{run.id}</Typography.Text><div><Tag>{({ queued: "等待整理", running: "正在整理", submitted: "模型任务已提交", completed: "候选已生成 · 未发布", blocked_budget: "模型或预算阻断", blocked_auth: "整理授权阻断", failed: "整理失败", reconciliation_required: "整理结果待核对" } as Record<string, string>)[run.state] ?? run.state}</Tag>领域 {run.profile_id} v{run.profile_version} · 修订 {run.revision} · 模型代次 {run.model_generation ?? 0}</div>{run.error && <MutationError error={errorText(run.error)} />}<Space wrap>{run.candidate_ids?.map(id => <Link key={id} to={`/intelligence/video-knowledge?review=${encodeURIComponent(id)}`}>复核候选 {id}</Link>)}</Space><KnowledgeExtractionRecovery run={run} busy={mutation.busy} onRetry={() => void mutation.run(async () => { await retryKnowledgeExtraction(workspaceId, run); extractions.refresh(); })} />{run.state === "blocked_budget" && <Callout tone="warning">检查冻结领域版本的知识整理模型与预算；已有运行不会被新配置静默改写。<Link to="/intelligence/domains">查看领域版本</Link></Callout>}</div></List.Item>} />}
            </Card>
            <Card size="small" title="分页产物清单" extra={<Button disabled={mutation.busy} onClick={() => void mutation.run(async () => setArtifacts(await readVideoArtifacts(workspaceId, jobId)))}>读取</Button>}>
                {artifacts && <><Tag>{artifacts.complete ? "清单完整" : "清单尚未完整"}</Tag>{artifacts.truncated && <Tag>返回有界分页</Tag>}<pre className="whitespace-pre-wrap break-all">{JSON.stringify(artifacts.items, null, 2)}</pre><Button disabled={!artifacts.next_cursor || mutation.busy} onClick={() => void mutation.run(async () => setArtifacts(await readVideoArtifacts(workspaceId, jobId, artifacts.next_cursor!)))}>下一页</Button></>}
            </Card>
        </>}
        <AppModal open={cancelOpen} title="请求取消此视频任务" onCancel={() => !mutation.busy && setCancelOpen(false)} confirmLoading={mutation.busy} okButtonProps={{ danger: true, disabled: !reason.trim() }} onOk={() => void act(async () => { await cancelVideoJob(workspaceId, jobId, reason.trim()); setCancelOpen(false); })} okText="确认取消">
            <Callout tone="warning">先持久化宿主取消并阻止继续处理和发布，再尝试远端停止。已发生费用保留，远端停止以实际结果为准。</Callout>
            <Input.TextArea aria-label="取消理由" value={reason} onChange={e => setReason(e.target.value)} placeholder="取消理由（必填）" /><MutationError error={mutation.error} />
        </AppModal>
    </div>;
}

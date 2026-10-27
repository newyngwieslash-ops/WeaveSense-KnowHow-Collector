import { useCallback, useState } from "react";
import { Button, Card, Form, Input, Space, Table, Tag, Typography } from "antd";
import { Callout } from "@/components/ui/product/callout/callout";
import { readVideoMetrics, type VideoMetricGroup, type VideoMetricRecord, type VideoOperationalMetrics, type VideoGovernanceMetrics } from "@/services/api/video-insights";
import { MutationError, useVideoMutation, useVideoResource, VideoLoadState } from "./video-common";

export const metricValue = (value: number | null | undefined, suffix = "") => value == null || !Number.isFinite(value) ? "未知 / 尚未计量" : `${Number(value.toFixed(2))}${suffix}`;
export function VideoOperationalInsights({ operational: o, governance: g }: { operational?: VideoOperationalMetrics; governance?: VideoGovernanceMetrics }) {
    return <div className="space-y-3">
        {o && <Card size="small" title="全窗口运行审计（不授予材料访问）">
            <Typography.Paragraph type="secondary">{o.scope}。与上方最近 500 条样本口径不同；只计已记录的状态转移，不补造迁移前历史。</Typography.Paragraph>
            <Space wrap><Tag>当前待授权 {o.needs_auth_current}</Tag><Tag>完成但有缺口 {o.completed_with_gaps}</Tag><Tag>就绪延迟样本 {o.ready_latency.samples}</Tag><Tag>平均 {metricValue(o.ready_latency.mean_ms, " ms")}</Tag><Tag>最大 {metricValue(o.ready_latency.max_ms, " ms")}</Tag></Space>
            <Typography.Paragraph>发现批次 {o.discovery.runs} · 已接受分页条目 {o.discovery.accepted_page_items}（可能包含已有资产）· 首次登记独立资产 {o.discovery.newly_registered_unique_assets} · 部分批次 {o.discovery.partial_runs} · 已完成批次平均墙钟 {metricValue(o.discovery.mean_finished_wall_ms, " ms")}。</Typography.Paragraph>
            <Typography.Paragraph>不同持久键 {o.duplicate_suppression.distinct_request_keys} → 任务 {o.duplicate_suppression.distinct_jobs}；折叠请求键 {o.duplicate_suppression.collapsed_request_keys}；同一键重放次数 {metricValue(o.duplicate_suppression.same_key_replays)}，不可当成零。</Typography.Paragraph>
            <Table size="small" scroll={{ x: true }} rowKey={row => `${row.stage}:${row.state}`} pagination={{ pageSize: 8 }} dataSource={o.stages} columns={[
                { title: "阶段 / 当前状态 / 数量", render: (_, row) => `${row.stage} / ${row.state} / ${row.count}` },
                { title: "观测起点", render: (_, row) => `${row.observed_since ?? "历史未计量"} · ${row.observed_count} 条` },
                { title: "限流 / 授权状态转移（非请求数）", render: (_, row) => `${row.rate_limit_events} / ${row.auth_required_events}` },
                { title: "墙钟耗时 / 样本", render: (_, row) => `${metricValue(row.mean_wall_duration_ms, " ms")} / ${row.duration_samples}` },
                { title: "最久排队等待", render: (_, row) => metricValue(row.oldest_wait_ms, " ms") },
            ]} />
            <details><summary>运行口径定义</summary><pre className="whitespace-pre-wrap">{JSON.stringify(o.definitions, null, 2)}</pre></details>
        </Card>}
        {g && <Card size="small" title="知识治理与恢复（不是准确率）">
            <Typography.Paragraph>单元 {g.citation_support.units} · 当前证据关联 {g.citation_support.units_with_current_evidence_links} · 缺少关联 {g.citation_support.units_without_current_evidence_links} · 明确人工支持复核 {g.citation_support.units_with_explicit_support_review} · 模型推断 {g.citation_support.model_inference_units}；语义支持准确率 {metricValue(g.citation_support.semantic_support_accuracy)}。</Typography.Paragraph>
            <Typography.Paragraph>修改过的单元 {g.review_revision.revised_units}，追加版本 {g.review_revision.additional_versions}。窗口复核事件：{Object.entries(g.review_revision.events_in_window).map(([key, value]) => <Tag key={key}>{key}: {value}</Tag>)}</Typography.Paragraph>
            <Typography.Paragraph>来源候选裁定：{Object.entries(g.source_independence.candidate_states).map(([key, value]) => <Tag key={key}>{key}: {value}</Tag>)}；跨来源已核验声明 {g.source_independence.cross_source_verified_claims}；独立性校准准确率 {metricValue(g.source_independence.calibrated_accuracy)}。账号数量不等于独立来源。</Typography.Paragraph>
            <Typography.Paragraph>任务 {g.failure_recovery.jobs} · 观测到失败 {g.failure_recovery.observed_failure_jobs} · 失败后完成 {g.failure_recovery.completed_after_observed_failure} · 多阶段尝试 {g.failure_recovery.multiple_stage_attempt_jobs} · 当前结果不明 {g.failure_recovery.unknown_outcomes_current}。结果不明必须先对账，不是安全重试许可。</Typography.Paragraph>
            <details><summary>治理口径定义</summary><pre className="whitespace-pre-wrap">{JSON.stringify(g.definitions, null, 2)}</pre></details>
        </Card>}
    </div>;
}
function Insights({ workspaceId, onOpenJob }: { workspaceId: string; onOpenJob: (id: string) => void }) {
    const [query, setQuery] = useState<{ from?: string; to?: string; profile_id?: string }>({});
    const [form] = Form.useForm<{ from?: string; to?: string; profile_id?: string }>();
    const mutation = useVideoMutation();
    const fetcher = useCallback((ws: string, signal: AbortSignal) => readVideoMetrics(ws, query, signal), [query]);
    const resource = useVideoResource(workspaceId, fetcher);
    const metrics = resource.data;
    const apply = () => mutation.run(async () => {
        const values = await form.validateFields();
        if (values.from || values.to) {
            const from = Date.parse(values.from ?? ""), to = Date.parse(values.to ?? "");
            if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 90 * 86400000) throw new Error("自定义窗口须同时提供起止 ISO 时间，递增且不超过 90 天");
        }
        setQuery({ from: values.from?.trim(), to: values.to?.trim(), profile_id: values.profile_id?.trim() });
    });
    return <div className="space-y-4">
        <Callout>默认最近 7 天，最多取最近创建的 500 个任务。处理完成率、音频时间覆盖、视觉采样密度、知识复核数量和人工准确率是不同指标。</Callout>
        <Form form={form} layout="inline"><Form.Item name="from" label="起始 ISO 时间"><Input /></Form.Item><Form.Item name="to" label="结束 ISO 时间"><Input /></Form.Item><Form.Item name="profile_id" label="领域 ID"><Input /></Form.Item><Button disabled={mutation.busy} onClick={() => void apply()}>读取窗口</Button><Button onClick={resource.refresh}>刷新</Button></Form>
        <MutationError error={mutation.error} /><VideoLoadState workspaceId={workspaceId} {...resource} onRetry={resource.refresh} />
        {metrics && <>
            <Space wrap><Tag>样本 {metrics.sample_count} / 符合条件 {metrics.total_matching_jobs}</Tag><span>{metrics.window.from} — {metrics.window.to}</span></Space>
            {metrics.sample_truncated && <Callout tone="warning" title="样本被截断">只统计返回的最近 {metrics.sample_limit} 个任务，不能据此推断全量准确率或总成本。</Callout>}
            <Callout tone="warning" title="人工准确率尚待独立标签">状态 {metrics.quality.status}；准确率 {metricValue(metrics.quality.accuracy)}；人工标注样本 {metricValue(metrics.quality.labelled_sample_count)}。任务成功、OCR 完成与模型自评不能替代行业人工质量评估。</Callout>
            <Card size="small" title="知识复核状态数量（独立统计口径）"><Space wrap>{Object.entries(metrics.knowledge_review_counts).map(([state, count]) => <Tag key={state}>{state}: {count}</Tag>)}</Space><Typography.Paragraph type="secondary">按所选时间 / 领域中新建单元的当前状态计数，不是准确率，也不是上方视频样本的发布比例。{metrics.knowledge_review_count_scope}</Typography.Paragraph></Card>
            <VideoOperationalInsights operational={metrics.operational} governance={metrics.governance} />
            <Table<VideoMetricGroup> size="small" scroll={{ x: true }} rowKey={row => `${row.profile_id}:${row.profile_version}:${row.processor_fingerprint}`} pagination={{ pageSize: 5 }} dataSource={metrics.groups} columns={[
                { title: "固定领域 / 处理版本", render: (_, row) => <>{row.profile_id} v{row.profile_version}<details><summary>版本校验与模型</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ profile_hash: row.profile_hash, processor_fingerprint: row.processor_fingerprint, models: row.models }, null, 2)}</pre></details></> },
                { title: "样本 / 流水线完成 / 缓存复用", render: (_, row) => `${row.sample_count} / ${row.pipeline_completed} / ${row.cache_hits}` },
                { title: "已结算成本（micro）", render: (_, row) => <>{row.settled_cost_micro}<div>已知 {row.known_cost_jobs} · 未知 {row.unknown_cost_jobs} 个任务（不计为零）</div></> },
            ]} />
            <Table<VideoMetricRecord> size="small" scroll={{ x: true }} rowKey="video_job_id" pagination={{ pageSize: 10 }} dataSource={metrics.records} columns={[
                { title: "固定任务 / 媒体版本", render: (_, row) => <><Button type="link" onClick={() => onOpenJob(row.video_job_id)}>{row.video_job_id}</Button><div>{row.platform} · {row.state}</div><details><summary>媒体与模型版本</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ media_sha256: row.media_sha256, models: row.models, processor_fingerprint: row.processor_fingerprint }, null, 2)}</pre></details></> },
                { title: "音频处理时间比（非转写准确率）", render: (_, row) => metricValue(row.audio_processed_ratio == null ? null : row.audio_processed_ratio * 100, "%") },
                { title: "视觉采样密度（非全帧覆盖）", render: (_, row) => <>{metricValue(row.visual_samples_per_minute, " 帧/分钟")}<div>采样 {metricValue(row.visual_sample_count)} 帧 · {row.visual_budget_limited === null ? "预算覆盖未知" : row.visual_budget_limited ? "受预算限制" : "未标记预算截断"}</div></> },
                { title: "成本 / 复用", render: (_, row) => <>{metricValue(row.cost_micro, " micro")}<div>{row.cost_status}</div><div>{row.cache_hit ? `精确复用 ${row.reused_from_job_id}` : "未复用"}</div></> },
            ]} />
        </>}
    </div>;
}
export function VideoInsights({ workspaceId, onOpenJob }: { workspaceId?: string; onOpenJob: (id: string) => void }) {
    const [opened, setOpened] = useState(false);
    return <Card title="视频洞察 · 有界运行与质量口径" extra={<Button disabled={!workspaceId} onClick={() => setOpened(!opened)}>{opened ? "收起" : "读取实际指标"}</Button>}>{opened && workspaceId ? <Insights key={workspaceId} workspaceId={workspaceId} onOpenJob={onOpenJob} /> : <Typography.Paragraph>按需读取真实样本、成本与覆盖；人工质量未标注时保持未知。</Typography.Paragraph>}</Card>;
}

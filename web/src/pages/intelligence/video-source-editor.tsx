import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, List, Select, Space, Tag, Typography } from "antd";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { Callout } from "@/components/ui/product/callout/callout";
import { createSource, listSources, listSchedules, type IntelSource, type CollectionSchedule } from "@/services/api/intelligence";
import { backfillVideoSource, createVideoSchedule, discoverVideo, getVideoDiscovery, listVideoProfiles, reconcileVideoJob, runVideoSource, setVideoScheduleEnabled, setVideoSourceStatus, startVideoJob, type VideoDiscovery, type VideoProfile, type VideoJob } from "@/services/api/video-knowledge";
import { HostIntelLink, MutationError, useVideoMutation, useVideoResource, VideoLoadState } from "./video-common";
import { VideoRetentionControls } from "./video-retention-controls";

type SourceForm = { platform: "bilibili" | "douyin"; source_type: "video" | "account"; title: string; url: string; native_id: string; part_id?: string; author_id: string; profile: string; usage_basis: string; allowed_uses: string[]; authorization_expires_at?: string; processing_mode: string };
type ScheduleForm = { kind: "interval" | "cron"; interval_minutes: number; cron: string; timezone: string; misfire_policy: "skip" | "coalesce" | "catch_up"; budget: number };
const sourceLoader = async (workspaceId: string) => (await listSources(workspaceId)).filter((s) => s.kind === "bilibili" || s.kind === "douyin");
const scheduleLoader = async (workspaceId: string) => listSchedules(workspaceId);

/** Extends the host SourcesPanel; this is not a second collector or credential manager. */
export function VideoSourcesPanel({ workspaceId }: { workspaceId?: string }) {
    const sources = useVideoResource(workspaceId, sourceLoader);
    const profiles = useVideoResource(workspaceId, listVideoProfiles);
    const schedules = useVideoResource(workspaceId, scheduleLoader);
    const mutation = useVideoMutation();
    const [sourceForm] = Form.useForm<SourceForm>();
    const [scheduleForm] = Form.useForm<ScheduleForm>();
    const [creating, setCreating] = useState(false);
    const [scheduling, setScheduling] = useState<IntelSource>();
    const [scheduleAction, setScheduleAction] = useState<CollectionSchedule>();
    const [preview, setPreview] = useState<{ source: IntelSource; result: VideoDiscovery }>();
    const [submission, setSubmission] = useState<{ key: string; job?: VideoJob; uncertain?: boolean }>();
    const [sourceAction, setSourceAction] = useState<{ source: IntelSource; action: "pause" | "resume" | "run" | "backfill" }>();
    const [backfill, setBackfill] = useState({ from: "", to: "", limit: 50 });
    const [operation, setOperation] = useState<{ operation_id: string; status?: string }>();
    const sourceType = Form.useWatch("source_type", sourceForm);
    const sourcePlatform = Form.useWatch("platform", sourceForm);
    const scheduleKind = Form.useWatch("kind", scheduleForm);
    const findProfile = (value: string): VideoProfile | undefined => profiles.data?.items.find(p => `${p.id}:${p.version}` === value);
    const create = () => mutation.run(async () => {
        if (!workspaceId) return;
        const values = await sourceForm.validateFields();
        const profile = findProfile(values.profile);
        if (!profile) throw new Error("领域版本已不可用，请重新选择");
        if (values.processing_mode === "visual_required" && !(profile.config.required_capabilities as string[] | undefined)?.includes("vision")) throw new Error("视觉必需来源必须选择已将 vision 列为必需能力的领域版本");
        const part = values.platform === "bilibili" && values.source_type === "video" ? values.part_id?.trim() || new URL(values.url).searchParams.get("p") : undefined;
        await createSource(workspaceId, { kind: values.platform, title: values.title.trim(), url: values.url.trim(), config: { source_type: values.source_type, ...(values.source_type === "video" ? { native_id: values.native_id.trim(), ...(part ? { part_id: part } : {}) } : { author_id: values.author_id.trim() }), profile_id: profile.id, profile_version: profile.version, usage_basis: values.usage_basis.trim(), allowed_uses: values.allowed_uses, processing_mode: values.processing_mode, ...(values.authorization_expires_at ? { authorization_expires_at: values.authorization_expires_at } : {}) } });
        setCreating(false); sources.refresh();
    });
    const discover = (source: IntelSource, cursor?: string) => mutation.run(async () => {
        if (!workspaceId) return;
        setPreview({ source, result: await discoverVideo(workspaceId, { source_id: source.id, limit: 10, ...(cursor ? { cursor } : {}) }) });
    });
    const start = (source: IntelSource, item: NonNullable<VideoDiscovery["items"]>[number]) => mutation.run(async () => {
            if (!workspaceId || submission?.uncertain) return;
            if (!source.config?.profile_id || !source.config.profile_version) throw new Error("来源未绑定领域版本，不能提交");
            // Create the recovery key inside the synchronous mutation lock: a second
            // click must not replace the key of an in-flight, potentially lost start.
            const key = crypto.randomUUID();
            setSubmission({ key, uncertain: true });
            const job = await startVideoJob(workspaceId, { source_id: source.id, native_id: item.native_id, part_id: item.part_id, canonical_url: item.canonical_url, content_version: item.content_version, profile_id: String(source.config.profile_id), profile_version: Number(source.config.profile_version) }, key);
            setSubmission({ key, job, uncertain: false });
    });
    const saveSchedule = () => mutation.run(async () => {
        if (!workspaceId || !scheduling) return;
        const values = await scheduleForm.validateFields();
        await createVideoSchedule(workspaceId, { source_ids: [scheduling.id], ...(values.kind === "interval" ? { interval_seconds: values.interval_minutes * 60 } : { cron: values.cron }), timezone: values.timezone, misfire_policy: values.misfire_policy, budget_micro_per_window: values.budget });
        setScheduling(undefined); schedules.refresh();
    });
    const changeSource = () => mutation.run(async () => {
        if (!workspaceId || !sourceAction) return;
        const { source, action } = sourceAction;
        if (action === "pause" || action === "resume") {
            if (!Number.isSafeInteger(source.revision)) throw new Error("来源缺少并发版本，不能安全修改；请重新加载");
            await setVideoSourceStatus(workspaceId, source.id, source.revision!, action === "pause" ? "paused" : "active");
        } else if (action === "run") setOperation(await runVideoSource(workspaceId, source.id));
        else {
            if (!Number.isFinite(Date.parse(backfill.from)) || !Number.isFinite(Date.parse(backfill.to)) || Date.parse(backfill.from) >= Date.parse(backfill.to)) throw new Error("补采必须提供有效且递增的起止时间");
            if (Date.parse(backfill.to) - Date.parse(backfill.from) > 90 * 86400000) throw new Error("一次补采窗口不得超过 90 天");
            setOperation(await backfillVideoSource(workspaceId, source.id, { from: new Date(backfill.from).toISOString(), to: new Date(backfill.to).toISOString(), limit: backfill.limit }));
        }
        setSourceAction(undefined); sources.refresh(); schedules.refresh();
    });
    return <div className="p-4 space-y-4">
        <Card title="视频来源 · B站 / 抖音" extra={<Button type="primary" disabled={!workspaceId || !profiles.data?.items.length} onClick={() => { sourceForm.resetFields(); setCreating(true); }}>添加视频来源</Button>}>
            <VideoRetentionControls workspaceId={workspaceId} sources={sources.data ?? []} onChanged={() => { sources.refresh(); schedules.refresh(); }} />
            <Callout title="由 Loom 持续调度">关闭聊天或浏览器不影响已保存的服务端任务。发现不等于下载，资料就绪不等于知识已发布。<HostIntelLink to="/intelligence/domains"> 管理知识域</HostIntelLink> · <HostIntelLink to="/intelligence/mcp">授权与连接管理</HostIntelLink></Callout>
            <MutationError error={mutation.error} />
            {profiles.error && <MutationError error={`读取知识域失败：${profiles.error}`} />}
            <VideoLoadState workspaceId={workspaceId} {...sources} empty={sources.data?.length === 0 ? "尚无视频来源" : undefined} onRetry={sources.refresh} />
            {sources.data && <List dataSource={sources.data} renderItem={s => <List.Item actions={[
                <Button key="preview" disabled={mutation.busy || s.status !== "active"} onClick={() => void discover(s)}>发现预览</Button>,
                <Button key="schedule" disabled={mutation.busy || s.status !== "active"} onClick={() => { scheduleForm.resetFields(); setScheduling(s); }}>设置持续调度</Button>,
                <Button key="run" disabled={mutation.busy || s.status !== "active"} onClick={() => setSourceAction({ source: s, action: "run" })}>立即运行</Button>,
                <Button key="backfill" disabled={mutation.busy || s.status !== "active"} onClick={() => { setBackfill({ from: "", to: "", limit: 50 }); setSourceAction({ source: s, action: "backfill" }); }}>有界补采</Button>,
                <Button key="pause" disabled={mutation.busy || !["active", "paused"].includes(s.status) || !Number.isSafeInteger(s.revision)} onClick={() => setSourceAction({ source: s, action: s.status === "active" ? "pause" : "resume" })}>{s.status === "paused" ? "恢复" : "暂停"}</Button>,
            ]}><List.Item.Meta title={<Space><Tag>{s.kind === "bilibili" ? "B站" : "抖音"}</Tag>{s.title || s.url}<Tag>{s.status}</Tag></Space>} description={<div className="space-y-1">
                <div>{s.config?.source_type === "account" ? "账号增量" : "单视频"} · 领域 {String(s.config?.profile_id ?? "未绑定")} v{String(s.config?.profile_version ?? "—")} · 策略 {String(s.config?.processing_mode ?? "未配置")}</div>
                <div>凭据引用：{String(s.config?.credential_ref ?? "未绑定")} · 凭据状态：{String(s.config?.credential_status ?? "未确认，请由管理员检查")} · 使用依据：{String(s.config?.usage_basis ?? "未记录")}</div>
                <div>允许用途：{Array.isArray(s.config?.allowed_uses) ? s.config.allowed_uses.join("、") : "未记录"}</div>
                {s.last_error && <Typography.Text type="danger">{s.last_error}</Typography.Text>}
                {schedules.data?.filter(sc => sc.source_ids.includes(s.id)).map(sc => <div key={sc.id}><Tag>{sc.enabled ? "已启用调度" : "调度已停用"}</Tag>{sc.kind === "cron" ? sc.cron : `${sc.interval_seconds} 秒`} · {sc.timezone} · 下次 {sc.next_run_at} {sc.blocked_reason && <Typography.Text type="danger">{sc.blocked_reason}</Typography.Text>} {sc.monitor_id ? <HostIntelLink to="/intelligence/keywords">由监控管理启停</HostIntelLink> : <Button size="small" disabled={mutation.busy || !Number.isSafeInteger(sc.revision)} onClick={() => setScheduleAction(sc)}>{sc.enabled ? "停用此调度" : "启用此调度"}</Button>}</div>)}
            </div>} /></List.Item>} />}
            {schedules.error && <MutationError error={`读取调度失败：${schedules.error}`} />}
        </Card>
        {operation && <Callout tone="success" title="采集命令已被服务端接受"><Typography.Text copyable>{operation.operation_id}</Typography.Text> · {operation.status ?? "等待执行"}。这不代表视频已经下载或知识已发布。<HostIntelLink to="/intelligence/jobs">查看批次</HostIntelLink> / <HostIntelLink to="/intelligence/video-jobs">查看视频任务</HostIntelLink></Callout>}
        {preview && <Card title={`发现预览 · ${preview.source.title || preview.source.id}`} extra={<Button onClick={() => setPreview(undefined)}>关闭</Button>}>
            <Typography.Paragraph>状态：{preview.result.state ?? "已返回"} · 只展示实际发现条目，不表示已采集或入库。</Typography.Paragraph>
            {preview.result.operation_id && <Typography.Paragraph copyable>发现批次 {preview.result.operation_id}</Typography.Paragraph>}
            {(preview.result.discovery_handle || preview.result.operation_id) && <Button disabled={mutation.busy} onClick={() => void mutation.run(async () => { if (workspaceId) setPreview({ source: preview.source, result: await getVideoDiscovery(workspaceId, preview.result.discovery_handle ?? preview.result.operation_id!) }); })}>刷新发现结果（不重复提交）</Button>}
            {preview.result.error && <MutationError error={preview.result.error} />}
            <pre className="whitespace-pre-wrap break-all">{JSON.stringify(preview.result.coverage ?? {}, null, 2)}</pre>
            {preview.result.partial && <Callout tone="warning" title="发现覆盖不完整">稳定 watermark 尚未追平，保留分页恢复点；不能把已发现条数当作全部视频。</Callout>}
            {preview.result.checkpoint && <details><summary>分页恢复点</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(preview.result.checkpoint, null, 2)}</pre></details>}
            <List dataSource={preview.result.items ?? []} locale={{ emptyText: preview.result.discovery_id || preview.result.discovery_handle ? "后台发现进行中，请刷新实际结果" : "本页未发现视频" }} renderItem={item => <List.Item actions={[<Button key="process" disabled={mutation.busy || submission?.uncertain} onClick={() => void start(preview.source, item)}>提交处理</Button>]}>{item.title || item.native_id} {item.part_id ? `· 分P ${item.part_id}` : ""}</List.Item>} />
            {preview.result.next_cursor && preview.result.operation_id && <Button disabled={mutation.busy} onClick={() => void mutation.run(async () => { if (workspaceId) setPreview({ source: preview.source, result: await getVideoDiscovery(workspaceId, preview.result.operation_id!, undefined, preview.result.next_cursor!) }); })}>下一页（只读，不重新发现）</Button>}
        </Card>}
        {submission && <Callout tone={submission.uncertain ? "warning" : "success"} title={submission.uncertain ? "提交结果尚未确认，请先核对，勿重复提交" : "任务已由服务端持久化"}>
            <Typography.Paragraph copyable>{submission.key}</Typography.Paragraph>
            {submission.job ? <><div>任务 {submission.job.video_job_id}</div><HostIntelLink to="/intelligence/video-jobs">查看真实阶段</HostIntelLink></> : <Button disabled={mutation.busy} onClick={() => void mutation.run(async () => { if (workspaceId) setSubmission({ key: submission.key, job: await reconcileVideoJob(workspaceId, { idempotency_key: submission.key }), uncertain: false }); })}>使用恢复键找回任务</Button>}
        </Callout>}
        <AppModal open={creating} title="配置视频来源" onCancel={() => !mutation.busy && setCreating(false)} onOk={() => void create()} confirmLoading={mutation.busy} okText="保存来源">
            <MutationError error={mutation.error} /><Form form={sourceForm} layout="vertical" initialValues={{ platform: "bilibili", source_type: "video", processing_mode: "subtitles_first", allowed_uses: ["knowledge"] }}>
                <Form.Item name="platform" label="平台" rules={[{ required: true }]}><Select options={[{ value: "bilibili", label: "B站" }, { value: "douyin", label: "抖音" }]} /></Form.Item>
                <Form.Item name="source_type" label="来源方式" rules={[{ required: true }]}><Select options={[{ value: "video", label: "单视频" }, { value: "account", label: "账号增量订阅" }]} /></Form.Item>
                <Form.Item name="title" label="来源名称" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
                <Form.Item name="url" label="原始链接" rules={[{ required: true }, { type: "url" }]}><Input /></Form.Item>
                {sourceType === "account" ? <Form.Item name="author_id" label="平台作者 ID（原样保留字符串）" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item> : <Form.Item name="native_id" label="平台视频 ID" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>}
                {sourceType === "video" && sourcePlatform === "bilibili" && <Form.Item name="part_id" label="分P ID（链接含 p 参数时自动读取，作为资产身份保留）" rules={[{ pattern: /^[1-9]\d*$/, message: "分P须为正整数形式的字符串" }]}><Input /></Form.Item>}
                <Form.Item name="profile" label="冻结知识域版本" rules={[{ required: true }]}><Select options={profiles.data?.items.map(p => ({ value: `${p.id}:${p.version}`, label: `${p.name} · v${p.version}` }))} /></Form.Item>
                <Form.Item name="processing_mode" label="处理模式" rules={[{ required: true }]}><Select options={[{ value: "subtitles_first", label: "字幕优先" }, { value: "audio", label: "音频" }, { value: "full_video", label: "完整视频" }, { value: "visual_required", label: "视觉必需" }]} /></Form.Item>
                <Callout>音频模式不承诺减少首次下载流量。未获取或到期的媒体不能在本地播放。平台 Cookie、密钥不在这里填写。</Callout>
                <Form.Item name="usage_basis" label="内容使用依据" rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={2} /></Form.Item>
                <Form.Item name="allowed_uses" label="获授权用途（本功能要求知识提炼授权）" rules={[{ required: true }, { validator: (_, value: string[]) => value?.includes("knowledge") ? Promise.resolve() : Promise.reject(new Error("需要有效的知识提炼用途授权")) }]}><Select mode="multiple" options={[{ value: "research", label: "研究" }, { value: "knowledge", label: "知识提炼" }, { value: "skill", label: "方法评测" }]} /></Form.Item>
                <Form.Item name="authorization_expires_at" label="授权到期时间（ISO 8601，可空）"><Input placeholder="2027-01-01T00:00:00Z" /></Form.Item>
            </Form>
        </AppModal>
        <AppModal open={!!scheduling} title="启用服务端持续调度" onCancel={() => !mutation.busy && setScheduling(undefined)} onOk={() => void saveSchedule()} confirmLoading={mutation.busy} okText="确认启用">
            <MutationError error={mutation.error} /><Form form={scheduleForm} layout="vertical" initialValues={{ kind: "interval", interval_minutes: 60, timezone: "Asia/Shanghai", misfire_policy: "coalesce", budget: 0 }}>
                <Form.Item name="kind" label="调度方式"><Select options={[{ value: "interval", label: "固定间隔" }, { value: "cron", label: "Cron" }]} /></Form.Item>
                {scheduleKind === "cron" ? <Form.Item name="cron" label="五字段 Cron" rules={[{ required: true }]}><Input placeholder="0 9 * * *" /></Form.Item> : <Form.Item name="interval_minutes" label="间隔（分钟）" rules={[{ required: true }]}><InputNumber min={5} precision={0} /></Form.Item>}
                <Form.Item name="timezone" label="IANA 时区" rules={[{ required: true }]}><Input /></Form.Item>
                <Form.Item name="misfire_policy" label="错过窗口"><Select options={[{ value: "coalesce", label: "合并到最近窗口" }, { value: "skip", label: "跳过" }, { value: "catch_up", label: "有界补跑（服务端上限）" }]} /></Form.Item>
                <Form.Item name="budget" label="每窗口预算（micro）" rules={[{ required: true }]}><InputNumber min={0} precision={0} /></Form.Item>
                <Callout>持续运行受当前授权与预算约束；权限失效或额度不足会保留阻断任务，不会绕过授权继续采集。</Callout>
            </Form>
        </AppModal>
        <AppModal open={!!scheduleAction} title={scheduleAction?.enabled ? "确认停用此调度" : "确认启用此调度"} onCancel={() => !mutation.busy && setScheduleAction(undefined)} confirmLoading={mutation.busy} onOk={() => void mutation.run(async () => { if (!workspaceId || !scheduleAction || !Number.isSafeInteger(scheduleAction.revision)) throw new Error("调度缺少并发版本，请重新加载"); await setVideoScheduleEnabled(workspaceId, scheduleAction.id, scheduleAction.revision!, !scheduleAction.enabled); setScheduleAction(undefined); schedules.refresh(); })}>
            <Typography.Paragraph>{scheduleAction?.id} · 修订 {scheduleAction?.revision}</Typography.Paragraph><Callout>仅改变未来调度启停，不修改频率、预算、授权或已有任务。启用仍须来源有效且预算可用；监控拥有的调度须由现有监控管理。</Callout><MutationError error={mutation.error} />
        </AppModal>
        <AppModal open={!!sourceAction} title={{ pause: "暂停未来采集", resume: "恢复未来采集", run: "立即执行一个采集批次", backfill: "有界补采" }[sourceAction?.action ?? "pause"]} onCancel={() => !mutation.busy && setSourceAction(undefined)} onOk={() => void changeSource()} confirmLoading={mutation.busy}>
            <Typography.Paragraph>{sourceAction?.source.title} · 来源修订 {sourceAction?.source.revision ?? "未返回"}</Typography.Paragraph>
            <Callout>暂停来源只停止未来发现，不等于撤销内容授权或擦除历史证据。运行和补采受当前授权、预算与服务器上限限制。</Callout>
            {sourceAction?.action === "backfill" && <Space direction="vertical" className="w-full"><Input aria-label="补采开始时间" placeholder="开始时间（ISO 8601）" value={backfill.from} onChange={e => setBackfill({ ...backfill, from: e.target.value })} /><Input aria-label="补采结束时间" placeholder="结束时间（ISO 8601）" value={backfill.to} onChange={e => setBackfill({ ...backfill, to: e.target.value })} /><InputNumber aria-label="补采条数上限" min={1} max={200} value={backfill.limit} onChange={value => setBackfill({ ...backfill, limit: value ?? 1 })} /></Space>}
            <MutationError error={mutation.error} />
        </AppModal>
    </div>;
}

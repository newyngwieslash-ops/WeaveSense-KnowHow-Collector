import { useState } from "react";
import { Button, Card, Form, Input, InputNumber, List, Select, Space, Tag, Typography } from "antd";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { Callout } from "@/components/ui/product/callout/callout";
import { listVideoProfiles, saveVideoProfile, type VideoProfile } from "@/services/api/video-knowledge";
import { MutationError, useVideoMutation, useVideoResource, VideoLoadState } from "./video-common";

type ProfileForm = { name: string; questions: string; terms: string; included: string; excluded: string; knowledge_types: string[]; reviewers: string; budget: number; retention_policy: string; processing_mode: string; required_capabilities: string[]; optional_capabilities: string[]; embedding_model_id: string; embedding_budget_micro: number; embedding_dimensions?: number | null; max_duration_minutes: number; max_video_bytes: number; max_discovery_pages: number; knowledge_model_id: string; knowledge_budget_micro: number; knowledge_max_tokens: number };
const capabilityOptions = [{ value: "transcript", label: "时间轴文本" }, { value: "vision", label: "视觉理解" }, { value: "ocr", label: "OCR" }, { value: "vlm", label: "视觉模型观察" }, { value: "summary", label: "派生摘要" }, { value: "embedding", label: "向量索引" }];
const engineeringRetentionDefaults = { version: 1, media: { access_seconds: 86400, maximum_seconds: 2592000 }, audio: { access_seconds: 86400, maximum_seconds: 2592000 }, frame: { access_seconds: 604800, maximum_seconds: 2592000 }, transcript: { access_seconds: 2592000, maximum_seconds: 2592000 }, evidence: { access_seconds: 2592000, maximum_seconds: 2592000 } };
const lines = (text: string) => text.split(/\n/).map((v) => v.trim()).filter(Boolean);
const textLines = (value: unknown) => Array.isArray(value) ? value.join("\n") : "";
export function VideoDomainProfiles({ workspaceId }: { workspaceId?: string }) {
    const resource = useVideoResource(workspaceId, listVideoProfiles);
    const mutation = useVideoMutation();
    const [editing, setEditing] = useState<VideoProfile | "new">();
    const [draftId, setDraftId] = useState<string>();
    const [form] = Form.useForm<ProfileForm>();
    const open = (profile: VideoProfile | "new") => {
        setDraftId(profile === "new" ? `vp_${crypto.randomUUID().replaceAll("-", "")}` : profile.id);
        const config = profile === "new" ? {} : profile.config;
        form.setFieldsValue({ name: profile === "new" ? "" : profile.name, questions: textLines(config.questions), terms: textLines(config.terms), included: textLines(config.included_topics), excluded: textLines(config.excluded_topics), knowledge_types: Array.isArray(config.knowledge_types) ? config.knowledge_types as string[] : ["fact", "procedure"], reviewers: textLines(config.reviewers), budget: Number(config.budget_micro ?? 0), retention_policy: JSON.stringify(config.retention_policy ?? engineeringRetentionDefaults, null, 2), processing_mode: String(config.processing_mode ?? "subtitles_first"), required_capabilities: Array.isArray(config.required_capabilities) ? config.required_capabilities as string[] : ["transcript"], max_duration_minutes: Number(config.max_duration_ms ?? 14400000) / 60000, max_video_bytes: Number(config.max_video_bytes ?? 2000000000), max_discovery_pages: Number(config.max_discovery_pages ?? 5) });
        form.setFieldsValue({ knowledge_model_id: String(config.knowledge_model_id ?? ""), knowledge_budget_micro: Number(config.knowledge_budget_micro ?? 0), knowledge_max_tokens: Number(config.knowledge_max_tokens ?? 8000) });
        form.setFieldsValue({ optional_capabilities: Array.isArray(config.optional_capabilities) ? config.optional_capabilities as string[] : [], embedding_model_id: String(config.embedding_model_id ?? ""), embedding_budget_micro: Number(config.embedding_budget_micro ?? 0), embedding_dimensions: typeof config.embedding_dimensions === "number" ? config.embedding_dimensions : null });
        setEditing(profile);
    };
    const save = async () => {
        if (!workspaceId || !editing) return;
        await mutation.run(async () => {
            const values = await form.validateFields();
            const current = editing === "new" ? undefined : editing;
            if (values.processing_mode === "visual_required" && !values.required_capabilities.includes("vision")) throw new Error("视觉必需策略必须将 vision 列为必需能力");
            if (values.optional_capabilities.some(capability => values.required_capabilities.includes(capability))) throw new Error("同一能力不能同时声明必需和可选");
            if (values.embedding_budget_micro > values.budget) throw new Error("向量索引预算包含在媒体任务总预算中，不得超过总预算");
            if (!draftId) throw new Error("领域草稿标识已失效，请重新打开编辑器");
            await saveVideoProfile(workspaceId, { id: current?.id ?? draftId, expected_version: current?.version ?? 0, name: values.name.trim(), config: { ...current?.config, questions: lines(values.questions), terms: lines(values.terms), included_topics: lines(values.included), excluded_topics: lines(values.excluded), knowledge_types: values.knowledge_types, reviewers: lines(values.reviewers), review_policy: "human_approval_required", budget_micro: values.budget, retention_policy: JSON.parse(values.retention_policy), processing_mode: values.processing_mode, required_capabilities: values.required_capabilities, optional_capabilities: values.optional_capabilities, embedding_model_id: values.embedding_model_id?.trim() || null, embedding_budget_micro: values.embedding_budget_micro, embedding_dimensions: values.embedding_dimensions ?? null, max_duration_ms: values.max_duration_minutes * 60000, max_video_bytes: values.max_video_bytes, max_discovery_pages: values.max_discovery_pages, knowledge_model_id: values.knowledge_model_id?.trim() || null, knowledge_budget_micro: values.knowledge_budget_micro, knowledge_max_tokens: values.knowledge_max_tokens } });
            setEditing(undefined); resource.refresh();
        });
    };
    return <div className="p-4 space-y-4">
        <Callout title="领域配置按版本冻结">保存创建不可变版本；历史任务仍使用启动时的领域版本。来源授权、预算与发布权限由服务端重新检查。</Callout>
        <Card title="知识域" extra={<Button type="primary" disabled={!workspaceId} onClick={() => open("new")}>新建知识域</Button>}>
            <VideoLoadState workspaceId={workspaceId} {...resource} empty={resource.data?.items.length === 0 ? "尚未配置知识域" : undefined} onRetry={resource.refresh} />
            {resource.data && <List dataSource={resource.data.items} renderItem={(p) => <List.Item actions={[<Button key="edit" onClick={() => open(p)}>编辑并保存新版本</Button>]}><List.Item.Meta title={<Space>{p.name}<Tag>v{p.version}</Tag></Space>} description={<><Typography.Text copyable>{p.id}</Typography.Text><div className="break-all">Hash: {p.content_hash}</div></>} /></List.Item>} />}
        </Card>
        <AppModal open={!!editing} title={editing === "new" ? "新建知识域" : `编辑知识域 · 基于 v${editing?.version ?? ""}`} onCancel={() => !mutation.busy && setEditing(undefined)} onOk={() => void save()} confirmLoading={mutation.busy} okText="保存新版本">
            <MutationError error={mutation.error} />
            <Form form={form} layout="vertical">
                <Form.Item name="name" label="领域名称" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
                <Form.Item name="questions" label="目标问题（每行一项）" rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={3} /></Form.Item>
                <Form.Item name="terms" label="术语与同义词（每行一组）"><Input.TextArea rows={2} /></Form.Item>
                <Form.Item name="included" label="包含主题"><Input.TextArea rows={2} /></Form.Item>
                <Form.Item name="excluded" label="排除主题"><Input.TextArea rows={2} /></Form.Item>
                <Form.Item name="knowledge_types" label="知识类型" rules={[{ required: true }]}><Select mode="multiple" options={["definition", "fact", "procedure", "example", "pitfall", "parameter", "constraint", "risk"].map(value => ({ value, label: value }))} /></Form.Item>
                <Form.Item name="reviewers" label="复核人标识（不授予权限）"><Input.TextArea rows={2} /></Form.Item>
                <Form.Item name="processing_mode" label="处理策略"><Select options={[{ value: "subtitles_first", label: "字幕优先" }, { value: "audio", label: "音频处理" }, { value: "full_video", label: "完整视频" }, { value: "visual_required", label: "视觉必需" }]} /></Form.Item>
                <Form.Item name="required_capabilities" label="必需处理能力（缺失则阻止就绪）" rules={[{ required: true }]}><Select mode="multiple" options={capabilityOptions} /></Form.Item>
                <Form.Item name="optional_capabilities" label="可选处理能力（明确缺失可带缺口就绪）"><Select mode="multiple" options={capabilityOptions} /></Form.Item>
                <Form.Item name="max_duration_minutes" label="单视频时长上限（分钟）" rules={[{ required: true }]}><InputNumber min={1} max={1440} precision={0} /></Form.Item>
                <Form.Item name="max_video_bytes" label="单视频字节上限" rules={[{ required: true }]}><InputNumber min={1} max={10000000000} precision={0} /></Form.Item>
                <Form.Item name="max_discovery_pages" label="每轮发现页上限（未完成保留恢复点）" rules={[{ required: true }]}><InputNumber min={1} max={100} precision={0} /></Form.Item>
                <Form.Item name="budget" label="每任务预算（micro，0 不代表无限额）" rules={[{ required: true }]}><InputNumber min={0} precision={0} /></Form.Item>
                <Form.Item name="embedding_model_id" label="宿主向量模型 ID（不填写密钥）"><Input /></Form.Item>
                <Form.Item name="embedding_budget_micro" label="向量索引预算（包含于每任务总预算内，micro）" rules={[{ required: true }]}><InputNumber min={0} precision={0} /></Form.Item>
                <Form.Item name="embedding_dimensions" label="向量维度（可空，按宿主模型实际能力）"><InputNumber min={1} max={65536} precision={0} /></Form.Item>
                <Callout>选择必需向量索引时，真实向量未提交前资料不会就绪；选择可选时，明确不可用会显示缺口。人工校正也须等待新修订索引，不能沿用旧向量伪装成功。</Callout>
                <Form.Item name="knowledge_model_id" label="宿主知识整理模型 ID（须为已配置可用模型）"><Input /></Form.Item>
                <Form.Item name="knowledge_budget_micro" label="资料就绪后知识整理总预算（micro）" rules={[{ required: true }]}><InputNumber min={0} precision={0} /></Form.Item>
                <Form.Item name="knowledge_max_tokens" label="每次整理输出 token 上限" rules={[{ required: true }]}><InputNumber min={1} max={16384} precision={0} /></Form.Item>
                <Callout>未指定可用整理模型或正预算时，ready 后整理运行会明确预算阻断，不会伪造知识候选。整理在宿主模型网关计量，且与媒体任务独立。</Callout>
                <Form.Item name="retention_policy" label="五类冻结保留策略 JSON（秒；访问期限 / 最大保留期限）" rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={14} /></Form.Item>
                <Callout>media / audio / frame / transcript / evidence 五类均须明确 access_seconds 与 maximum_seconds，访问期限不能超过最大期限。默认值是工程配置，不是合规建议。文本访问期限取转写与证据较短值，到期撤销关联可读性；最大期限触发清除。服务端拒绝违反来源依赖关系的期限，旧任务不静默使用新策略。</Callout>
            </Form>
        </AppModal>
    </div>;
}

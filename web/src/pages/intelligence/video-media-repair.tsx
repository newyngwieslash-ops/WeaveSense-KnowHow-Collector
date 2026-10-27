import { useState } from "react";
import { Button, Typography } from "antd";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { Callout } from "@/components/ui/product/callout/callout";
import { repairVideoMedia } from "@/services/api/video-media";
import type { VideoJob } from "@/services/api/video-knowledge";
import { HostIntelLink, MutationError, useVideoMutation } from "./video-common";

/** Mounted only after a registered object is reported missing; no read starts repair work. */
export function VideoMediaRepair({ workspaceId, jobId }: { workspaceId: string; jobId: string }) {
    const [open, setOpen] = useState(false);
    const [key, setKey] = useState<string>();
    const [receipt, setReceipt] = useState<VideoJob>();
    const mutation = useVideoMutation();
    return <div className="space-y-2">
        <Button disabled={mutation.busy} onClick={() => { setKey(previous => previous ?? crypto.randomUUID()); setOpen(true); }}>显式申请修复缺失媒体</Button>
        {receipt && <Callout title="修复任务已受理，尚不代表原媒体已恢复">{receipt.video_job_id} · {receipt.state} / {receipt.stage}。<HostIntelLink to={`/intelligence/video-jobs?job=${encodeURIComponent(receipt.video_job_id)}`}>查看真实修复结果</HostIntelLink>；restored、partial、changed_media 以服务端覆盖记录为准。</Callout>}
        <MutationError error={mutation.error} />
        <AppModal open={open} title="确认申请缺失媒体修复" onCancel={() => !mutation.busy && setOpen(false)} confirmLoading={mutation.busy} okText="提交同一恢复键的修复请求" onOk={() => void mutation.run(async () => { if (!key) return; setReceipt(await repairVideoMedia(workspaceId, jobId, key)); setOpen(false); })}>
            <Callout tone="warning">这是新的受权采集工作，可能产生费用，不是重新读取。仅平台来源、已就绪且尚未到期的缺失对象可修复；不能恢复已撤权 / 已清除材料，也不能把重采到的不同内容替换成旧证据。</Callout>
            <Typography.Paragraph copyable>{key}</Typography.Paragraph><Typography.Paragraph>响应不明时保留此键，重新提交只核对同一个修复命令，不自动创建另一份任务。</Typography.Paragraph><MutationError error={mutation.error} />
        </AppModal>
    </div>;
}

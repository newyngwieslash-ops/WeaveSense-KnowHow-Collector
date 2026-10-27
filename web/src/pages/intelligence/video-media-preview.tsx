import { useCallback, useEffect, useRef, useState } from "react";
import { Button, List, Space, Typography } from "antd";
import { Callout } from "@/components/ui/product/callout/callout";
import { captureUserSession } from "@/lib/user-scope";
import { describeMediaAccessError, readVideoMediaObjects, safeVideoMediaURL, verifyVideoMediaAccess, type VideoMediaDescriptor } from "@/services/api/video-media";
import { isAborted, useVideoResource, VideoLoadState } from "./video-common";
import { formatEvidenceTime } from "./video-evidence-utils";
import { ApiError } from "@/services/api/request";
import { VideoMediaRepair } from "./video-media-repair";

export function AuthorizedVideoMedia({ workspaceId, jobId, media, label, startMs }: { workspaceId: string; jobId: string; media: VideoMediaDescriptor; label: string; startMs?: number | null }) {
    const [activeURL, setActiveURL] = useState<string>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [missing, setMissing] = useState(media.unavailable_reason === "object_missing");
    const mediaRef = useRef<HTMLMediaElement | null>(null);
    const request = useRef<AbortController | undefined>(undefined);
    const locked = useRef(false);
    const safeURL = safeVideoMediaURL(workspaceId, jobId, media);
    const stop = () => { request.current?.abort(); mediaRef.current?.pause(); setActiveURL(undefined); };
    const load = async () => {
        if (locked.current) return;
        locked.current = true; setBusy(true); setError(undefined);
        const controller = new AbortController(); request.current = controller;
        try { const url = await verifyVideoMediaAccess(workspaceId, jobId, media, controller.signal); if (!controller.signal.aborted) setActiveURL(url); }
        catch (e) { if (!isAborted(e)) { setError(describeMediaAccessError(e)); if (e instanceof ApiError) setMissing(e.status === 404); } }
        finally { locked.current = false; setBusy(false); }
    };
    const seek = useCallback(() => {
        const element = mediaRef.current;
        if (!element || !element.readyState || startMs == null || !Number.isFinite(startMs) || startMs < 0) return;
        if (Number.isFinite(element.duration) && startMs / 1000 > element.duration) { setError("证据时间超出该固定媒体时长，未猜测定位"); return; }
        element.currentTime = startMs / 1000;
    }, [startMs]);
    useEffect(seek, [seek, activeURL]);
    useEffect(() => {
        if (!activeURL) return;
        const controller = new AbortController(), session = captureUserSession();
        let checking = false;
        const invalidate = () => { mediaRef.current?.pause(); setActiveURL(undefined); controller.abort(); };
        const hidden = () => { if (document.hidden) invalidate(); };
        session.signal.addEventListener("abort", invalidate);
        document.addEventListener("visibilitychange", hidden);
        const timer = setInterval(() => { if (checking) return; checking = true; void verifyVideoMediaAccess(workspaceId, jobId, media, controller.signal).catch(e => { if (!isAborted(e)) { invalidate(); setError(describeMediaAccessError(e)); if (e instanceof ApiError) setMissing(e.status === 404); } }).finally(() => { checking = false; }); }, 15000);
        return () => { controller.abort(); clearInterval(timer); session.signal.removeEventListener("abort", invalidate); document.removeEventListener("visibilitychange", hidden); };
    }, [activeURL, workspaceId, jobId, media]);
    useEffect(() => () => { request.current?.abort(); }, []);
    const failed = () => { mediaRef.current?.pause(); setActiveURL(undefined); setError("媒体解码或受权读取失败。请重新核对访问；不承诺浏览器支持该编码，不替换来源。"); };
    return <div className="space-y-2">
        <Typography.Text>{label}</Typography.Text>
        {!safeURL && <Callout tone="warning">媒体不可播放：{media.unavailable_reason ?? "缺少受权同源描述符或不支持安全预览的格式"}。不会拼接对象键或外部地址。</Callout>}
        {error && <Callout tone="error" role="alert">{error}</Callout>}
        {missing && <VideoMediaRepair workspaceId={workspaceId} jobId={jobId} />}
        <Space wrap><Button disabled={!safeURL || busy} loading={busy} onClick={() => void load()}>{activeURL ? "重新核对访问" : "核对权限并加载"}</Button>{activeURL && <Button onClick={stop}>停止并卸载媒体</Button>}{startMs != null && <span>定位 {formatEvidenceTime(startMs)}</span>}</Space>
        {activeURL && (media.content_type?.startsWith("image/") ? <img src={activeURL} alt={label} loading="lazy" className="max-h-80 max-w-full object-contain" onError={failed} /> : media.content_type?.startsWith("audio/") ? <audio ref={element => { mediaRef.current = element; }} src={activeURL} controls preload="metadata" onLoadedMetadata={seek} onError={failed} className="w-full" /> : <video ref={element => { mediaRef.current = element; }} src={activeURL} controls playsInline preload="metadata" onLoadedMetadata={seek} onError={failed} className="max-h-96 w-full" />)}
    </div>;
}

export function VideoMediaLibrary({ workspaceId, jobId, startMs }: { workspaceId: string; jobId: string; startMs?: number | null }) {
    const [cursor, setCursor] = useState<string>();
    const [selected, setSelected] = useState<VideoMediaDescriptor>();
    const fetcher = useCallback((ws: string, signal: AbortSignal) => readVideoMediaObjects(ws, jobId, cursor, signal), [jobId, cursor]);
    const resource = useVideoResource(workspaceId, fetcher, 15000);
    useEffect(() => { setSelected(undefined); }, [resource.error, cursor]);
    const playable = resource.data?.items.filter(item => /^(audio|video)\//.test(item.content_type ?? "")) ?? [];
    return <div className="space-y-3">
        <Callout>仅加载当前任务登记的固定产物。每个 Range 请求重新检查宿主身份和授权，不自动播放；切换工作区、失去访问或页面隐藏时卸载媒体。</Callout>
        <VideoLoadState workspaceId={workspaceId} {...resource} onRetry={resource.refresh} />
        {resource.data && <List dataSource={playable} locale={{ emptyText: resource.data.complete ? "本页没有音视频对象；字幕输入可能从未采集媒体，可继续翻页核对" : "资料未就绪，没有可播放产物" }} renderItem={item => <List.Item actions={[<Button key="select" onClick={() => setSelected(item)}>选择固定产物</Button>]}>{item.content_type} · {item.bytes ?? "未知"} bytes · {item.object_id}</List.Item>} />}
        <Space><Button disabled={!cursor} onClick={() => setCursor(undefined)}>媒体首页</Button><Button disabled={!resource.data?.next_cursor} onClick={() => setCursor(resource.data!.next_cursor!)}>下一页媒体</Button></Space>
        {selected && <AuthorizedVideoMedia key={selected.object_id} workspaceId={workspaceId} jobId={jobId} media={selected} label="当前固定音视频产物" startMs={startMs} />}
    </div>;
}

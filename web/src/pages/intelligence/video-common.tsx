import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Spin, Tag } from "antd";
import { Link, useInRouterContext } from "react-router";
import { Callout } from "@/components/ui/product/callout/callout";
import { EmptyState } from "@/components/ui/product/empty-state/empty-state";
import { ApiError } from "@/services/api/request";
import type { VideoJobState } from "@/services/api/video-knowledge";

export const VIDEO_STATE_LABEL: Record<VideoJobState, string> = {
    queued: "排队中", running: "运行中", retry_wait: "等待重试", blocked_auth: "授权阻断", blocked_budget: "预算阻断",
    reconciliation_required: "外部结果不明 · 需核对", cancel_requested: "已请求取消", cancelled: "宿主已取消", failed: "失败",
    completed: "资料就绪", completed_with_gaps: "资料就绪 · 可选缺口",
};
export function VideoState({ state }: { state: string }) {
    return <Tag>{VIDEO_STATE_LABEL[state as VideoJobState] ?? state}</Tag>;
}
export function describeVideoError(error: unknown): string {
    if (error instanceof ApiError) {
        if (error.status === 409) return `版本或幂等冲突，请重新加载后核对；未覆盖其他人的修改。${error.message}`;
        if (error.status === 403) return `当前工作区权限不足或授权已失效。${error.message}`;
        return `${error.reason ? `[${error.reason}] ` : ""}${error.message}`;
    }
    return error instanceof Error ? error.message : "请求失败，请重试或联系管理员";
}
export const isAborted = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Clears data on scope changes and rejects stale responses; no false empty state on failure. */
export function useVideoResource<T>(workspaceId: string | undefined, fetcher: (workspaceId: string, signal: AbortSignal) => Promise<T>, pollMs?: number) {
    const [data, setData] = useState<T>();
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(false);
    const [generation, setGeneration] = useState(0);
    const refresh = useCallback(() => setGeneration((n) => n + 1), []);
    useEffect(() => {
        setData(undefined);
        setError(undefined);
        if (!workspaceId) { setLoading(false); return; }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = async () => {
            setLoading(true);
            try {
                const result = await fetcher(workspaceId, controller.signal);
                if (!controller.signal.aborted) { setData(result); setError(undefined); }
            } catch (e) {
                if (!controller.signal.aborted && !isAborted(e)) { setData(undefined); setError(describeVideoError(e)); }
            } finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                    if (pollMs) timer = setTimeout(() => void read(), pollMs);
                }
            }
        };
        void read();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [workspaceId, fetcher, generation, pollMs]);
    return { data, error, loading, refresh };
}
export function useVideoMutation() {
    const lock = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const run = async (action: () => Promise<unknown>) => {
        if (lock.current) return false;
        lock.current = true; setBusy(true); setError(undefined);
        try { await action(); return true; }
        catch (e) { if (!isAborted(e)) setError(describeVideoError(e)); return false; }
        finally { lock.current = false; setBusy(false); }
    };
    return { busy, error, run };
}
export function VideoLoadState({ workspaceId, error, loading, empty, onRetry }: { workspaceId?: string; error?: string; loading: boolean; empty?: string; onRetry: () => void }) {
    if (!workspaceId) return <EmptyState title="请选择工作区" description="沿用宿主工作区身份，不创建独立账号。" />;
    if (error) return <Callout tone="error" title="读取失败" role="alert" action={<Button onClick={onRetry}>重新加载</Button>}>{error}</Callout>;
    if (loading) return <Spin tip="正在读取服务端记录"><div className="p-4" /></Spin>;
    if (empty) return <EmptyState title={empty} description="这里只显示服务端持久记录，不以样例或浏览器缓存冒充已完成任务。" />;
    return null;
}
export function MutationError({ error }: { error?: string }) { return error ? <Callout tone="error" title="操作未完成" role="alert">{error}</Callout> : null; }
/** Keep the existing workspace selection on host SPA navigation; standalone SSR remains supported. */
export function HostIntelLink({ to, children }: { to: string; children: ReactNode }) {
    const inRouter = useInRouterContext();
    return inRouter ? <Link to={to}>{children}</Link> : <a href={to}>{children}</a>;
}

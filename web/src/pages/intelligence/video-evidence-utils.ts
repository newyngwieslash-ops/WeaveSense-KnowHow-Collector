import type { EvidenceSnapshot } from "@/services/api/video-knowledge-review";

/** JavaScript string coordinates are UTF-16, matching the immutable document contract. */
export function evidenceHighlight(evidence: Pick<EvidenceSnapshot, "title" | "body" | "char_start" | "char_end" | "quote">) {
    const text = `${evidence.title}\n\n${evidence.body}`;
    const { char_start: start, char_end: end } = evidence;
    const cutsSurrogate = (offset: number) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length || cutsSurrogate(start) || cutsSurrogate(end)) return null;
    const quote = text.slice(start, end);
    if (quote !== evidence.quote) return null;
    return { before: text.slice(Math.max(0, start - 250), start), quote, after: text.slice(end, Math.min(text.length, end + 250)) };
}
export function formatEvidenceTime(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "时间未知";
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}.${String(Math.floor(ms % 1000)).padStart(3, "0")}`;
}
export function safeEvidenceSourceUrl(raw?: string): string | undefined {
    if (!raw) return;
    try { const url = new URL(raw); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return; }
}
export function mediaAvailabilityDescription(value?: string) {
    const labels: Record<string, string> = {
        available: "登记为可用；播放仍须重新检查当前授权与固定对象",
        not_acquired: "从未采集媒体（如仅字幕），不能承诺本地播放",
        subscription_paused: "仅暂停未来采集，不等于撤销历史文本授权",
        remote_unavailable: "平台来源不可用；本地材料许可与对象可用性分别检查",
        media_expired: "媒体访问已过期；文本是否仍可读取决于独立许可",
        revoked: "已撤权，不继续显示或播放原材料",
        erased: "已清除，不从旧缓存恢复原材料",
    };
    return value ? labels[value] ?? `${value}（未作额外可用性推断）` : "未知，不承诺可播放";
}

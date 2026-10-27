import { Callout } from "@/components/ui/product/callout/callout";
import type { McpConnection } from "@/services/api/intelligence";

export function connectionRecoveryHint(connection: Pick<McpConnection, "status" | "statusReason">): string {
    if (connection.status === "pending") return "由工作区管理员审查工具清单和 schema hash 后批准；安装 Skill 不会自动批准连接。";
    if (connection.status === "needs_reapproval") return "工具 schema 或权限发生变化。重新发现并审查差异后批准，不继续使用旧授权。";
    if (connection.status === "revoked") return "授权已撤销。请联系工作区管理员，不能通过重试绕过撤权。";
    const reason = connection.statusReason;
    if (["credential_expired", "credential_invalid", "auth_required", "needs_auth"].includes(reason)) return "凭据无效或过期。请管理员在服务端 secret reference / OAuth 管理中更新；不要把 Cookie 发送到聊天。";
    if (["private_network_denied", "internal_endpoint_not_allowed", "internal_mcp_not_allowed", "egress_denied", "ssrf_blocked"].includes(reason)) return "连接被网络策略拒绝。请平台运维核对固定服务地址、身份与 audience allowlist；不要关闭 SSRF 或全局允许私网。";
    return "已批准工具仍按工作区来源授权、当前 schema 与预算检查；连接健康不代表媒体已可获取或知识已发布。";
}
export function VideoConnectionHealth({ connection }: { connection: McpConnection }) {
    return <Callout tone={connection.status === "approved" && !connection.statusReason ? "info" : "warning"} title={`传输：${connection.transport || "服务端未声明"}`}>
        {connectionRecoveryHint(connection)}
        {connection.statusReason && <div>服务端原因：{connection.statusReason}</div>}
    </Callout>;
}

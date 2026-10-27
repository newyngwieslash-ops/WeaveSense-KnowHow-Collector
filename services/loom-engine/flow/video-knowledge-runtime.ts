import type { Engine } from "./engine.ts";
import type { ExecutionContext } from "./auth.ts";
import { sign } from "./auth.ts";
import { fail } from "./video-knowledge-contract.ts";

export type ModelTask = { task_id: string; status: string; output?: any; reservation_id?: string; cost_micro?: number; model_config_hash?: string; usage_ref?: string; input_hash?: string };
export function assertKnowledgeModelReceipt(task: ModelTask, budget: number) {
  if (!task.task_id || !task.reservation_id || task.usage_ref !== `model_task:${task.task_id}` || !/^[a-f0-9]{64}$/.test(task.model_config_hash ?? "")
    || !/^[a-f0-9]{64}$/.test(task.input_hash ?? "") || !Number.isSafeInteger(task.cost_micro) || task.cost_micro! < 0 || task.cost_micro! > budget) fail("model_usage_receipt_invalid");
}
export type KnowledgeRuntime = {
  resolveBase?: (ctx: ExecutionContext, base: { id: string; version: string }) => Promise<{ id: string; version: string; hash: string; required_tools: string[] }>;
  modelTask?: (scope: { tenant_id: string; workspace_id: string }, id: string, purpose: "video_knowledge_extract" | "video_skill_evaluate" | "video_embedding", request: any, taskId?: string) => Promise<ModelTask>;
  closeModelBudget?: (scope: { tenant_id: string; workspace_id: string }, id: string, purpose: "video_knowledge_extract" | "video_skill_evaluate") => Promise<{ reservation_id: string; status: string; cost_micro: number }>;
};
const runtime = new WeakMap<Engine, KnowledgeRuntime>();
export const configureVideoKnowledge = (engine: Engine, config: KnowledgeRuntime) => runtime.set(engine, config);
export const knowledgeRuntime = (engine: Engine) => runtime.get(engine) ?? {};
export function assertKnowledgeEnabled(engine: Engine, scope: { workspace_id: string }) {
  const allowed = (process.env.FLOW_VIDEO_WORKSPACES ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (!engine.video.enabled || (allowed.length && !allowed.includes(scope.workspace_id))) fail("VIDEO_DISABLED", 503);
}

/** Fixed deployment destination only, using the existing internal signing key and audience. */
export function platformKnowledgeRuntime(config: { baseURL: string; signingKey: string; audience: string }): KnowledgeRuntime {
  const base = new URL(config.baseURL);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("invalid internal platform base URL");
  async function call(scope: { tenant_id: string; workspace_id: string }, job: string, path: string, method: string, body: any, id: string, scopes: string[]) {
    const token = sign(config.signingKey, { ...scope, iss: "loom-engine", aud: config.audience, actor: { type: "service_principal", id }, job_id: job, scopes, policy_version: "policy_v1" });
    const response = await fetch(new URL(path, base), { method, redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      const error: any = await response.json().catch(() => ({}));
      fail(typeof error.reason === "string" && /^[a-zA-Z0-9_]{1,100}$/.test(error.reason) ? error.reason : `platform_knowledge_${response.status}`, response.status);
    }
    const envelope: any = await response.json();
    if (envelope.code !== 0 || !envelope.data) fail("platform_knowledge_contract", 502);
    return envelope.data;
  }
  return {
    closeModelBudget: (scope, id, purpose) => call(scope, id, "/api/internal/flow/video/model-budget/close", "POST", { purpose }, purpose === "video_skill_evaluate" ? "video-model-evaluator" : "video-knowledge-extractor", ["intel.video.model", ...(purpose === "video_skill_evaluate" ? ["intel.skills.evaluate"] : [])]),
    resolveBase: (ctx, ref) => call(ctx, "", `/api/internal/flow/video/skills/${encodeURIComponent(ref.id)}?version=${encodeURIComponent(ref.version)}`, "GET", undefined, "video-knowledge-governance", ["intel.skills.read"]),
    modelTask: (scope, id, purpose, request, taskId) => call(scope, id, taskId ? `/api/internal/flow/video/model-tasks/${encodeURIComponent(taskId)}` : "/api/internal/flow/video/model-tasks",
      taskId ? "GET" : "POST", taskId ? undefined : { ...request, purpose }, purpose === "video_skill_evaluate" ? "video-model-evaluator" : purpose === "video_embedding" ? "loom-video-indexer" : "video-knowledge-extractor", ["intel.video.model", ...(purpose === "video_skill_evaluate" ? ["intel.skills.evaluate"] : [])]),
  };
}

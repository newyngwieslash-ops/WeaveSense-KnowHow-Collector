import type { Engine } from "./engine.ts";
import type { ExecutionContext } from "./auth.ts";
import { VideoKnowledgeService } from "./video-knowledge.ts";
import { VideoKnowledgeSkills } from "./video-knowledge-skills.ts";
import { knowledgeRuntime, assertKnowledgeEnabled, assertKnowledgeModelReceipt } from "./video-knowledge-runtime.ts";
import { knowledgeHash, fail } from "./video-knowledge-contract.ts";
import { closeKnowledgeBudget } from "./video-knowledge-budget.ts";

/** Three actual executions per frozen case. A model never supplies its own passing score. */
export class VideoKnowledgeEvaluator {
  k: VideoKnowledgeService;
  skills: VideoKnowledgeSkills;
  constructor(engine: Engine) { this.k = new VideoKnowledgeService(engine); this.skills = new VideoKnowledgeSkills(this.k); }
  get db() { return this.k.db; }
  async workOnce(owner: string): Promise<boolean> {
    const hooks = knowledgeRuntime(this.k.e);
    if (!hooks.modelTask || !hooks.resolveBase || !this.k.e.video.enabled) return false;
    await closeKnowledgeBudget(this.k.e, "video_skill_evaluate");
    // Reconcile a crash after the last durable comparison but before the evaluation commit.
    const complete = (await this.db.query(`SELECT c.* FROM flow_video_skill_candidates c WHERE c.state='evaluation_running'
      AND EXISTS(SELECT 1 FROM flow_video_skill_eval_tasks t WHERE t.tenant_id=c.tenant_id AND t.workspace_id=c.workspace_id AND t.candidate_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM flow_video_skill_eval_tasks t WHERE t.tenant_id=c.tenant_id AND t.workspace_id=c.workspace_id AND t.candidate_id=c.id AND t.state<>'completed') ORDER BY c.id LIMIT 1`)).rows[0];
    if (complete) { await this.finalize(complete); return true; }
    const task = await this.db.tx(async q => {
      const t = (await q.query(`SELECT t.* FROM flow_video_skill_eval_tasks t JOIN flow_video_skill_candidates c ON c.tenant_id=t.tenant_id AND c.workspace_id=t.workspace_id AND c.id=t.candidate_id
        WHERE c.state='evaluation_running' AND t.state IN ('queued','submitted') AND t.next_poll_at<=now() AND (t.lease_expires_at IS NULL OR t.lease_expires_at<now()) ORDER BY t.candidate_id,t.case_id,t.variant FOR UPDATE OF t SKIP LOCKED LIMIT 1`)).rows[0];
      if (!t) return null;
      return (await q.query(`UPDATE flow_video_skill_eval_tasks SET lease_owner=$6,lease_expires_at=now()+interval '60 seconds',fencing_token=fencing_token+1 WHERE tenant_id=$1 AND workspace_id=$2 AND candidate_id=$3 AND case_id=$4 AND variant=$5 RETURNING *`,
        [t.tenant_id, t.workspace_id, t.candidate_id, t.case_id, t.variant, owner])).rows[0];
    });
    if (!task) return false;
    const p = [task.tenant_id, task.workspace_id, task.candidate_id, task.case_id, task.variant, owner, task.fencing_token];
    const ctx = { tenant_id: task.tenant_id, workspace_id: task.workspace_id, actor: { type: "service_principal", id: "video-model-evaluator" }, scopes: ["intel.skills.evaluate"], policy_version: "policy_v1" } as ExecutionContext;
    try {
      assertKnowledgeEnabled(this.k.e, task);
      const candidate = await this.skills.row(ctx, task.candidate_id), proposal = candidate.proposal;
      await this.skills.dependencies(ctx, proposal.knowledge_releases, proposal.evidence);
      const grant = candidate.eval_result?.grant_actor;
      if (!grant || (this.k.e.authorize && !await this.k.e.authorize({ ...ctx, grant_actor: grant }, "intel.skills.release"))) fail("evaluation_grant_revoked", 403);
      const spec = proposal.eval_spec, config = spec.model_config, c = spec.cases.find((x: any) => x.id === task.case_id);
      const base: any = await hooks.resolveBase(ctx, proposal.base);
      if (base.hash !== proposal.base.hash || !base.skill) fail("frozen_native_base_unavailable", 409);
      if (!Number.isSafeInteger(config.budget_micro) || config.budget_micro < spec.cases.length * 3) fail("evaluation_budget_required", 402);
      const method = task.variant === "base" ? base.skill : task.variant === "candidate" ? proposal.pack.skills[0] : null;
      const evidence = await this.k.resolveEvidence(ctx, proposal.evidence);
      const request = task.model_request ?? { key: `skill-eval:${candidate.id}:${task.case_id}:${task.variant}`, model_id: config.model,
        budget_micro: Math.min(20000000, Math.floor(config.budget_micro / (spec.cases.length * 3))), max_tokens: config.max_tokens ?? 4000,
        input: { case_id: c.id, input: c.input, method, variant: task.variant, candidate_hash: candidate.candidate_hash,
          evidence: evidence.map(({ body: _body, ...e }) => e) } };
      if (!task.model_request) {
        const saved = await this.db.query(`UPDATE flow_video_skill_eval_tasks SET model_request=$8 WHERE tenant_id=$1 AND workspace_id=$2 AND candidate_id=$3 AND case_id=$4 AND variant=$5 AND lease_owner=$6 AND fencing_token=$7 AND lease_expires_at>now() RETURNING case_id`, [...p, JSON.stringify(request)]);
        if (!saved.rows.length) fail("stale_evaluation_lease", 409);
      }
      const result = await hooks.modelTask(ctx, candidate.id, "video_skill_evaluate", request, task.task_id ?? undefined);
      if (!result.task_id || (task.task_id && task.task_id !== result.task_id)) fail("evaluation_task_contract", 502);
      if (result.status !== "succeeded") {
        if (["failed", "cancelled", "reconciliation_required"].includes(result.status)) fail(`evaluation_model_${result.status}`, 409);
        await this.db.query(`UPDATE flow_video_skill_eval_tasks SET task_id=$8,state='submitted',lease_owner=NULL,lease_expires_at=NULL,next_poll_at=now()+interval '5 seconds' WHERE tenant_id=$1 AND workspace_id=$2 AND candidate_id=$3 AND case_id=$4 AND variant=$5 AND lease_owner=$6 AND fencing_token=$7`, [...p, result.task_id]);
        return true;
      }
      assertKnowledgeModelReceipt(result, request.budget_micro);
      let response = result.output;
      if (typeof response === "string") { try { response = JSON.parse(response); } catch { fail("evaluation_invalid_json"); } }
      if (!response || response.case_id !== c.id || typeof response.output !== "string" || !Array.isArray(response.unsupported_claims) || !Array.isArray(response.permission_violations) || !Array.isArray(response.missing_evidence)) fail("evaluation_output_schema");
      // Exact frozen expected-output scoring is intentionally conservative and documented.
      // It is a deterministic executable gate, not model confidence or an invented human rating.
      const critical_failure = response.unsupported_claims.length > 0 || response.permission_violations.length > 0;
      const passed = !critical_failure && response.output.trim() === c.expected.trim();
      const stored = { score: passed ? 1 : 0, passed, critical_failure, run_id: result.task_id, usage_ref: result.usage_ref, output: response,
        scorer: "exact_expected_output_v1", expected_hash: knowledgeHash(c.expected), actual_model_config_hash: result.model_config_hash };
      if (!stored.usage_ref || !/^[a-f0-9]{64}$/.test(stored.actual_model_config_hash ?? "")) fail("evaluation_usage_and_model_receipt_required");
      await this.db.tx(async q => {
        const live = (await q.query(`SELECT state,eval_result FROM flow_video_skill_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, p.slice(0, 3))).rows[0];
        if (live?.state !== "evaluation_running") fail("evaluation_no_longer_active", 409);
        if (live.eval_result?.actual_model_config_hash && live.eval_result.actual_model_config_hash !== stored.actual_model_config_hash) fail("evaluation_model_configuration_changed", 409);
        await q.query(`UPDATE flow_video_skill_candidates SET eval_result=eval_result || $4::jsonb WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...p.slice(0, 3), JSON.stringify({ actual_model_config_hash: stored.actual_model_config_hash })]);
        const update = await q.query(`UPDATE flow_video_skill_eval_tasks SET task_id=$8,result=$9,state='completed',lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND candidate_id=$3 AND case_id=$4 AND variant=$5 AND lease_owner=$6 AND fencing_token=$7 AND lease_expires_at>now() RETURNING case_id`, [...p, result.task_id, JSON.stringify(stored)]);
        if (!update.rows.length) fail("stale_evaluation_lease", 409);
      });
      await this.finalize(candidate);
    } catch (error: any) {
      const blocked = [402, 403, 409, 422].includes(error.status);
      await this.db.query(`UPDATE flow_video_skill_eval_tasks SET state=$8,result=$9,lease_owner=NULL,lease_expires_at=NULL,next_poll_at=now()+interval '30 seconds' WHERE tenant_id=$1 AND workspace_id=$2 AND candidate_id=$3 AND case_id=$4 AND variant=$5 AND lease_owner=$6 AND fencing_token=$7`, [...p, blocked ? "blocked" : "queued", JSON.stringify({ error: error.reason ?? "evaluation_provider_error", retryable: !blocked })]);
      if (blocked) await this.db.query(`UPDATE flow_video_skill_candidates SET eval_result=eval_result || $4::jsonb WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND state='evaluation_running'`, [...p.slice(0, 3), JSON.stringify({ blocked_reason: error.reason ?? "evaluation_blocked" })]);
    }
    return true;
  }
  async finalize(candidate: any) {
    const all = (await this.db.query(`SELECT case_id,variant,state,result FROM flow_video_skill_eval_tasks WHERE tenant_id=$1 AND workspace_id=$2 AND candidate_id=$3`, [candidate.tenant_id, candidate.workspace_id, candidate.id])).rows;
    const proposal = candidate.proposal, spec = proposal.eval_spec;
    if (all.length !== spec.cases.length * 3 || !all.every(x => x.state === "completed")) return;
    const modelHashes = new Set(all.map(x => x.result.actual_model_config_hash));
    if (modelHashes.size !== 1 || !/^[a-f0-9]{64}$/.test([...modelHashes][0] ?? "")) fail("evaluation_model_configuration_changed", 409);
    const report = { candidate_hash: candidate.candidate_hash, eval_spec_hash: knowledgeHash(spec), dataset_version: spec.dataset_version, model_config_hash: knowledgeHash(spec.model_config), base_hash: proposal.base.hash,
      actual_model_config_hash: [...modelHashes][0],
      scorer: "exact_expected_output_v1", cases: spec.cases.map((c: any) => {
        const scores = Object.fromEntries(all.filter(x => x.case_id === c.id).map(x => [x.variant, x.result]));
        return { id: c.id, input_hash: knowledgeHash({ input: c.input, expected: c.expected }), critical_failure: scores.candidate.critical_failure, ...scores };
      }) };
    const ctx = { ...candidate, actor: { type: "service_principal", id: "video-model-evaluator" }, scopes: ["intel.skills.evaluate"], policy_version: "policy_v1" } as ExecutionContext;
    await this.skills.evaluate(ctx, candidate.id, `eval-complete:${candidate.candidate_hash}`, { expected_hash: candidate.candidate_hash, report });
  }
}

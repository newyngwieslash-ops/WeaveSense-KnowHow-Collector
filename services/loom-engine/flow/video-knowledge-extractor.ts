import type { Engine } from "./engine.ts";
import type { Q } from "./db.ts";
import type { ExecutionContext } from "./auth.ts";
import { newVideoId } from "./video-contract.ts";
import { VideoKnowledgeService } from "./video-knowledge.ts";
import { VideoKnowledgeSkills } from "./video-knowledge-skills.ts";
import { knowledgeRuntime, assertKnowledgeEnabled, assertKnowledgeModelReceipt } from "./video-knowledge-runtime.ts";
import { knowledgeHash, evidenceRefs, fail, VIDEO_KNOWLEDGE_METHOD } from "./video-knowledge-contract.ts";
import { closeKnowledgeBudget } from "./video-knowledge-budget.ts";
import { enqueueVideoOriginCheck } from "./video-origin-candidates.ts";

type Scope = { tenant_id: string; workspace_id: string };
export async function enqueueVideoKnowledgeReady(q: Q, scope: Scope, ready: { video_job_id: string; document_id: string; revision: number; profile_id: string; profile_version: number; grant_actor: string; policy_version?: string }) {
  const profile = (await q.query(`SELECT name,config,content_hash FROM flow_video_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND version=$4`, [scope.tenant_id, scope.workspace_id, ready.profile_id, ready.profile_version])).rows[0];
  if (!profile) fail("profile_not_found", 404);
  await enqueueVideoOriginCheck(q, scope, ready);
  const evidence = (await q.query(`SELECT id AS evidence_id,revision,snippet_hash FROM flow_evidence WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4 ORDER BY char_start,id`, [scope.tenant_id, scope.workspace_id, ready.document_id, ready.revision])).rows;
  // Each model call uses <=100 immutable segments; the durable cursor covers every batch.
  // Media readiness never waits for curation.
  const state = !evidence.length ? "blocked_input_limit" : "queued";
  const frozen_input = { profile_id: ready.profile_id, profile_version: ready.profile_version, profile, evidence, method_version: VIDEO_KNOWLEDGE_METHOD.version };
  const result = await q.query(`INSERT INTO flow_video_knowledge_runs(id,tenant_id,workspace_id,video_job_id,document_id,revision,profile_id,profile_version,grant_actor,policy_version,state,frozen_input,input_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(tenant_id,workspace_id,document_id,revision,profile_id,profile_version) DO NOTHING RETURNING id`,
    [newVideoId("vkr_"), scope.tenant_id, scope.workspace_id, ready.video_job_id, ready.document_id, ready.revision, ready.profile_id, ready.profile_version,
      ready.grant_actor, ready.policy_version ?? "policy_v1", state, JSON.stringify(frozen_input), knowledgeHash(frozen_input)]);
  return result.rows[0] ?? (await q.query(`SELECT id FROM flow_video_knowledge_runs WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4 AND profile_id=$5 AND profile_version=$6`, [scope.tenant_id, scope.workspace_id, ready.document_id, ready.revision, ready.profile_id, ready.profile_version])).rows[0];
}

export class VideoKnowledgeExtractor {
  k: VideoKnowledgeService;
  constructor(engine: Engine) { this.k = new VideoKnowledgeService(engine); }
  get db() { return this.k.db; }
  context(row: any): ExecutionContext {
    if (!/^user:[^:]+$/.test(row.grant_actor)) fail("curation_user_grant_required", 403);
    return { ...row, actor: { type: "user", id: row.grant_actor.slice(5) }, scopes: ["intel.knowledge.write", "intel.knowledge.research"], policy_version: row.policy_version };
  }
  async get(ctx: ExecutionContext, id: string) {
    await this.k.authorize(ctx, "intel.knowledge.research");
    const row = (await this.db.query(`SELECT id,video_job_id,document_id,revision,profile_id,profile_version,state,input_hash,external_task_id,external_task_status,model_generation,model_attempt_history,candidate_ids,error,created_at,updated_at FROM flow_video_knowledge_runs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id])).rows[0];
    if (!row) fail("extraction_not_found", 404); return row;
  }
  async list(ctx: ExecutionContext, input: any) {
    await this.k.authorize(ctx, "intel.knowledge.research");
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 25));
    const rows = (await this.db.query(`SELECT id,video_job_id,document_id,revision,profile_id,profile_version,state,input_hash,external_task_id,external_task_status,model_generation,candidate_ids,batch_cursor,error,created_at,updated_at
      FROM flow_video_knowledge_runs WHERE tenant_id=$1 AND workspace_id=$2 AND ($3='' OR video_job_id=$3) AND id>$4 ORDER BY id LIMIT $5`,
      [ctx.tenant_id, ctx.workspace_id, input.video_job_id ?? "", input.cursor ?? "", limit + 1])).rows;
    return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  async request(ctx: ExecutionContext, key: string, input: any) {
    await this.k.authorize(ctx, "intel.knowledge.write");
    return this.k.command(ctx, "extraction.request", key, input, async q => {
      const job = (await q.query(`SELECT * FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, input.video_job_id])).rows[0];
      if (!job || !["completed", "completed_with_gaps"].includes(job.state) || !job.document_id) fail("ready_video_job_required", 409);
      const run = await enqueueVideoKnowledgeReady(q, ctx, { ...job, video_job_id: job.id, grant_actor: `user:${ctx.actor.id}` });
      return { id: run.id, accepted: true };
    });
  }
  async retry(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.k.authorize(ctx, "intel.knowledge.write");
    return this.k.command(ctx, `extraction.retry:${id}`, key, input, async q => {
      const row = (await q.query(`SELECT * FROM flow_video_knowledge_runs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [ctx.tenant_id, ctx.workspace_id, id])).rows[0];
      if (!row) fail("extraction_not_found", 404);
      if (input.expected_hash !== row.input_hash) fail("extraction_version_conflict", 409);
      if (!["blocked_auth", "blocked_budget", "failed", "reconciliation_required"].includes(row.state)) fail("extraction_not_retryable", 409);
      await this.k.authorize(this.context(row), "intel.knowledge.write");
      await this.k.resolveEvidence(ctx, evidenceRefs(row.frozen_input.evidence.slice(row.batch_cursor, row.batch_cursor + 100)), q);
      // Only a confirmed terminal receipt permits another paid execution. An
      // unknown outcome keeps both its task and idempotency key for reconciliation.
      const replacement = row.state === "failed" && row.external_task_id && ["failed", "cancelled", "succeeded"].includes(row.external_task_status);
      if (replacement && row.budget_closed_at) fail("extraction_budget_already_closed", 409);
      const history = replacement ? [{ generation: row.model_generation, batch_cursor: row.batch_cursor, task_id: row.external_task_id,
        status: row.external_task_status, request_key: row.model_request?.key ?? null, error: row.error, retry_actor: ctx.actor.id }] : [];
      await q.query(`UPDATE flow_video_knowledge_runs SET state=CASE WHEN $2 OR external_task_id IS NULL THEN 'queued' ELSE 'submitted' END,
        model_generation=model_generation+CASE WHEN $2 THEN 1 ELSE 0 END,model_attempt_history=model_attempt_history || $3::jsonb,
        external_task_id=CASE WHEN $2 THEN NULL ELSE external_task_id END,external_task_status=CASE WHEN $2 THEN NULL ELSE external_task_status END,
        model_request=CASE WHEN $2 THEN NULL ELSE model_request END,error=NULL,next_poll_at=now(),fencing_token=fencing_token+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`, [id, Boolean(replacement), JSON.stringify(history)]);
      return { id, accepted: true, resume_batch_cursor: row.batch_cursor, external_task_id: replacement ? null : row.external_task_id,
        model_generation: row.model_generation + (replacement ? 1 : 0), reconciliation_only: !replacement && Boolean(row.model_request), input_hash: row.input_hash };
    });
  }
  async modelAuthorization(ctx: ExecutionContext, id: string, purpose: string) {
    assertKnowledgeEnabled(this.k.e, ctx);
    await this.k.authorize(ctx, "intel.video.model");
    if (ctx.actor.id !== "video-model-gateway" || ctx.job_id !== id) fail("model_task_scope_mismatch", 403);
    if (purpose === "video_knowledge_extract") {
      const row = (await this.db.query(`SELECT * FROM flow_video_knowledge_runs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id])).rows[0];
      if (!row || !["queued", "running", "submitted"].includes(row.state)) fail("extraction_not_active", 409);
      await this.k.authorize(this.context(row), "intel.knowledge.write");
      await this.k.resolveEvidence(ctx, evidenceRefs(row.frozen_input.evidence.slice(row.batch_cursor, row.batch_cursor + 100)));
      return { allowed: true, grant_actor: row.grant_actor, input_hash: row.input_hash,
        budget_micro: row.frozen_input.profile.config.knowledge_budget_micro ?? 0,
        budget_key: `video-curation:${row.id}:${row.input_hash}`, eval_config_hash: knowledgeHash(row.frozen_input.profile.config) };
    }
    if (purpose === "video_skill_evaluate") {
      const skills = new VideoKnowledgeSkills(this.k), row = await skills.row(ctx, id);
      if (row.state !== "evaluation_running" || !row.eval_result?.grant_actor) fail("evaluation_not_active", 409);
      if (this.k.e.authorize && !await this.k.e.authorize({ ...ctx, grant_actor: row.eval_result.grant_actor }, "intel.skills.release")) fail("evaluation_grant_revoked", 403);
      await skills.dependencies(ctx, row.proposal.knowledge_releases, row.proposal.evidence);
      return { allowed: true, grant_actor: row.eval_result.grant_actor, input_hash: row.candidate_hash,
        budget_micro: row.proposal.eval_spec.model_config.budget_micro ?? 0, budget_key: `skill-evaluation:${row.id}:${row.candidate_hash}`, eval_config_hash: knowledgeHash(row.proposal.eval_spec) };
    }
    fail("model_purpose_forbidden", 403);
  }

  async workOnce(owner: string): Promise<boolean> {
    const hooks = knowledgeRuntime(this.k.e);
    if (!hooks.modelTask || !hooks.resolveBase || !this.k.e.video.enabled) return false;
    await closeKnowledgeBudget(this.k.e, "video_knowledge_extract");
    const row = await this.db.tx(async q => {
      const current = (await q.query(`SELECT * FROM flow_video_knowledge_runs WHERE state IN ('queued','running','submitted') AND next_poll_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (!current) return null;
      return (await q.query(`UPDATE flow_video_knowledge_runs SET state=CASE WHEN external_task_id IS NULL THEN 'running' ELSE 'submitted' END,lease_owner=$2,lease_expires_at=now()+interval '60 seconds',fencing_token=fencing_token+1,attempts=attempts+1 WHERE id=$1 RETURNING *`, [current.id, owner])).rows[0];
    });
    if (!row) return false;
    const fence = async (q: Q) => {
      const live = (await q.query(`SELECT * FROM flow_video_knowledge_runs WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>now() AND state IN ('running','submitted') FOR UPDATE`, [row.id, owner, row.fencing_token])).rows[0];
      if (!live) fail("stale_extraction_lease", 409); return live;
    };
    try {
      assertKnowledgeEnabled(this.k.e, row);
      const ctx = this.context(row); await this.k.authorize(ctx, "intel.knowledge.write");
      const evidence = await this.k.resolveEvidence(ctx, evidenceRefs(row.frozen_input.evidence.slice(row.batch_cursor, row.batch_cursor + 100)));
      if (Buffer.byteLength(JSON.stringify(evidence)) > 500000) fail("extraction_input_limit", 413);
      let frozen = row.frozen_input;
      if (!frozen.method) {
        const native = await hooks.resolveBase(ctx, { id: "video-knowledge-core", version: frozen.method_version });
        frozen = { ...frozen, method: { id: native.id, version: native.version, hash: native.hash } };
        await this.db.tx(async q => { await fence(q); await q.query(`UPDATE flow_video_knowledge_runs SET frozen_input=$2,input_hash=$3 WHERE id=$1`, [row.id, JSON.stringify(frozen), knowledgeHash(frozen)]); });
      }
      const config = frozen.profile.config, model = config.knowledge_model_id ?? config.model_id;
      if (!model || !Number.isSafeInteger(config.knowledge_budget_micro) || config.knowledge_budget_micro <= 0) fail("knowledge_model_and_budget_required", 402);
      const batches = Math.ceil(frozen.evidence.length / 100);
      const request = row.model_request ?? { key: `knowledge-extract:${row.id}:${row.batch_cursor}:generation:${row.model_generation}`, model_id: model,
        budget_micro: Math.min(20000000, Math.floor(config.knowledge_budget_micro / batches)), max_tokens: Math.min(16384, config.knowledge_max_tokens ?? 8000),
        input: { ...frozen, batch: { offset: row.batch_cursor, total: frozen.evidence.length }, evidence: evidence.map(({ body: _body, ...ev }) => ev) } };
      if (!row.model_request) await this.db.tx(async q => { await fence(q); await q.query(`UPDATE flow_video_knowledge_runs SET model_request=$2 WHERE id=$1`, [row.id, JSON.stringify(request)]); });
      const task = await hooks.modelTask(ctx, row.id, "video_knowledge_extract", request, row.external_task_id ?? undefined);
      if (!task.task_id || (row.external_task_id && row.external_task_id !== task.task_id)) fail("model_task_contract", 502);
      if (!["queued", "running", "retry_wait", "succeeded", "failed", "cancelled", "reconciliation_required"].includes(task.status)) fail("model_task_contract", 502);
      // Persist the receipt before output validation too. A successful provider
      // response with invalid content must not be mistaken for an unsubmitted call.
      await this.db.tx(async q => { await fence(q); await q.query(`UPDATE flow_video_knowledge_runs SET external_task_id=$2,external_task_status=$3 WHERE id=$1`, [row.id, task.task_id, task.status]); });
      if (task.status !== "succeeded") {
        const terminal = ["failed", "cancelled", "reconciliation_required"].includes(task.status);
        await this.db.tx(async q => { await fence(q); await q.query(`UPDATE flow_video_knowledge_runs SET external_task_id=$2,state=$3,error=$4,lease_owner=NULL,lease_expires_at=NULL,next_poll_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1`, [row.id, task.task_id, task.status === "cancelled" ? "failed" : terminal ? task.status : "submitted", terminal ? `model_${task.status}` : null]); });
        return true;
      }
      assertKnowledgeModelReceipt(task, request.budget_micro);
      let output = task.output;
      if (typeof output === "string") { try { output = JSON.parse(output); } catch { fail("extraction_invalid_json"); } }
      if (!output || output.profile_id !== row.profile_id || output.profile_version !== row.profile_version || !["relevant", "irrelevant", "uncertain"].includes(output.relevance)
        || !Array.isArray(output.knowledge_units) || output.knowledge_units.length > 50) fail("extraction_schema_mismatch");
      if (output.relevance !== "relevant" && output.knowledge_units.length) fail("irrelevant_material_cannot_create_facts");
      const allowedEvidence = new Set(evidence.map(e => `${e.evidence_id}:${e.revision}:${e.snippet_hash}`));
      await this.db.tx(async q => {
        const current = await fence(q); await this.k.authorize(ctx, "intel.knowledge.write");
        if (current.model_config_hash && current.model_config_hash !== task.model_config_hash) fail("extraction_model_configuration_changed", 409);
        await q.query(`UPDATE flow_video_knowledge_runs SET model_config_hash=$2 WHERE id=$1`, [row.id, task.model_config_hash]);
        const ids = [];
        for (const unit of output.knowledge_units) {
          if (evidenceRefs(unit.evidence).some(e => !allowedEvidence.has(`${e.evidence_id}:${e.revision}:${e.snippet_hash}`))) fail("extraction_evidence_outside_frozen_input");
          const candidate = await this.k.createCandidate(q, ctx, { profile_id: row.profile_id, profile_version: row.profile_version, method: frozen.method, unit });
          ids.push(candidate.id);
        }
        const cursor = row.batch_cursor + evidence.length, done = cursor >= frozen.evidence.length;
        await q.query(`UPDATE flow_video_knowledge_runs SET state=$2,external_task_id=$3,external_task_status=CASE WHEN $2='completed' THEN 'succeeded' ELSE NULL END,candidate_ids=candidate_ids || $4::text[],batch_cursor=$5,model_request=NULL,lease_owner=NULL,lease_expires_at=NULL,error=NULL,next_poll_at=now(),updated_at=now() WHERE id=$1`, [row.id, done ? "completed" : "queued", done ? task.task_id : null, ids, cursor]);
        await this.k.e.emit(q, ctx, row.id, row.id, done ? "video.knowledge_curated" : "video.knowledge_curation_batch", { extraction_run_id: row.id, batch_offset: row.batch_cursor, candidate_ids: ids, model_task_id: task.task_id, usage_ref: task.usage_ref, method: frozen.method });
      });
    } catch (e: any) {
      const state = e.status === 403 ? "blocked_auth" : e.status === 402 ? "blocked_budget" : e.status === 422 || e.status === 413 || e.status === 409 ? "failed" : "queued";
      await this.db.query(`UPDATE flow_video_knowledge_runs SET state=$4,error=$5,lease_owner=NULL,lease_expires_at=NULL,next_poll_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3`, [row.id, owner, row.fencing_token, state, String(e.reason ?? "extraction_provider_error").slice(0, 200)]);
    }
    return true;
  }
}

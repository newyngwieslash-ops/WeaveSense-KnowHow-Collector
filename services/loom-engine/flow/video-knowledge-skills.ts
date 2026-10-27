import type { ExecutionContext } from "./auth.ts";
import type { Q } from "./db.ts";
import { VideoKnowledgeService, page } from "./video-knowledge.ts";
import { newVideoId, canonical } from "./video-contract.ts";
import { knowledgeHash, nativeSkillHash, validatePack, validateEvalSpec, validateMethod, evidenceRefs, textField, hashField, fail } from "./video-knowledge-contract.ts";
import { knowledgeRuntime } from "./video-knowledge-runtime.ts";
import { assertVideoRetentionJournal } from "./video-journal.ts";

const actor = (s: ExecutionContext) => `${s.actor.type}:${s.actor.id}`;

/** Source-controlled native packs only: no runtime registry or browser-asserted deployments. */
export class VideoKnowledgeSkills {
  k: VideoKnowledgeService;
  constructor(knowledge: VideoKnowledgeService) { this.k = knowledge; }
  get db() { return this.k.db; }

  async row(ctx: ExecutionContext, id: string, q: Q = this.db, lock = false) {
    const row = (await q.query(`SELECT * FROM flow_video_skill_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 ${lock ? "FOR UPDATE" : ""}`, [ctx.tenant_id, ctx.workspace_id, id])).rows[0];
    if (!row) fail("skill_candidate_not_found", 404);
    return row;
  }
  expected(row: any, input: any) { if (row.candidate_hash !== input.expected_hash) fail("candidate_hash_conflict", 409); }

  async dependencies(ctx: ExecutionContext, releases: any[], evidence: any[], q: Q = this.db) {
    if (!Array.isArray(releases) || !releases.length || releases.length > 100) fail("published_knowledge_dependencies_required");
    const seen = new Set<string>();
    for (const dep of releases) {
      if (seen.has(dep.release_id)) fail("duplicate_knowledge_release");
      seen.add(dep.release_id);
      const found = (await q.query(`SELECT r.* FROM flow_knowledge_releases r JOIN flow_knowledge_units k ON k.tenant_id=r.tenant_id AND k.workspace_id=r.workspace_id AND k.id=r.knowledge_id
        WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.id=$3 AND r.knowledge_id=$4 AND r.version=$5 AND r.content_hash=$6 AND r.revoked_at IS NULL
        AND k.state='published' AND k.release_id=r.id`, [ctx.tenant_id, ctx.workspace_id, dep.release_id, dep.knowledge_id, dep.version, dep.content_hash])).rows[0];
      if (!found || !this.k.validNow(found.snapshot.unit)) fail("knowledge_dependency_unavailable", 409);
      await this.k.resolveEvidence(ctx, evidenceRefs(found.snapshot.unit.evidence), q);
      const live = (await q.query(`SELECT id FROM flow_knowledge_releases WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND revoked_at IS NULL FOR SHARE`, [ctx.tenant_id, ctx.workspace_id, dep.release_id])).rows[0];
      if (!live) fail("knowledge_dependency_unavailable", 409);
    }
    return this.k.resolveEvidence(ctx, evidenceRefs(evidence), q);
  }

  async create(ctx: ExecutionContext, key: string, input: any) {
    await this.k.authorize(ctx, "intel.skills.release", true);
    const requestedBase = validateMethod(input.base), resolver = knowledgeRuntime(this.k.e).resolveBase;
    if (!resolver) fail("native_skill_registry_unavailable", 503);
    const base = await resolver(ctx, requestedBase);
    if (base.id !== requestedBase.id || base.version !== requestedBase.version || base.hash !== requestedBase.hash) fail("native_base_version_mismatch", 409);
    const pack = validatePack(input.pack, base), eval_spec = validateEvalSpec(input.eval_spec), refs = evidenceRefs(input.evidence);
    if (!refs.length) fail("frozen_evidence_required");
    const rules = ["method", ...pack.skills[0].steps.map((_: string, i: number) => `step:${i}`)];
    if (!Array.isArray(input.rule_evidence) || input.rule_evidence.length !== rules.length) fail("each_method_rule_requires_evidence");
    const rule_evidence = input.rule_evidence.map((r: any) => {
      if (!rules.includes(r.rule) || !Array.isArray(r.evidence_ids) || !r.evidence_ids.length || r.evidence_ids.length > 100 || r.evidence_ids.some((id: any) => !refs.some(e => e.evidence_id === id))) fail("rule_evidence_outside_frozen_input");
      return { rule: r.rule, evidence_ids: [...new Set(r.evidence_ids as string[])].sort() };
    });
    if (new Set(rule_evidence.map((r: any) => r.rule)).size !== rules.length) fail("duplicate_method_rule_evidence");
    const knowledge_releases = input.knowledge_releases?.map((d: any) => ({ knowledge_id: textField(d.knowledge_id, "knowledge_id", 200), version: d.version,
      release_id: textField(d.release_id, "release_id", 200), content_hash: hashField(d.content_hash) }));
    return this.k.command(ctx, "skill_candidate.create", key, input, async q => {
      const resolved = await this.dependencies(ctx, knowledge_releases, refs, q);
      const frozen_evidence = resolved.map(({ body: _body, ...e }) => e);
      const proposal = { pack, base, eval_spec, knowledge_releases, evidence: refs, frozen_evidence, rule_evidence };
      const candidate_hash = knowledgeHash(proposal), native_skill_hash = nativeSkillHash(pack.skills[0]);
      const old = (await q.query(`SELECT * FROM flow_video_skill_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND skill_id=$3 AND skill_version=$4`, [ctx.tenant_id, ctx.workspace_id, pack.skills[0].id, pack.skills[0].version])).rows[0];
      if (old) { if (old.candidate_hash !== candidate_hash) fail("immutable_skill_version_conflict", 409); return old; }
      const id = newVideoId("vsk_"), skill = pack.skills[0];
      await q.query(`INSERT INTO flow_video_skill_candidates(id,tenant_id,workspace_id,skill_id,skill_version,candidate_hash,native_skill_hash,proposal,state,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9)`,
        [id, ctx.tenant_id, ctx.workspace_id, skill.id, skill.version, candidate_hash, native_skill_hash, JSON.stringify(proposal), actor(ctx)]);
      for (const d of knowledge_releases) await q.query(`INSERT INTO flow_video_skill_dependencies(tenant_id,workspace_id,candidate_id,release_id,knowledge_id,version,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)`, [ctx.tenant_id, ctx.workspace_id, id, d.release_id, d.knowledge_id, d.version, d.content_hash]);
      return this.row(ctx, id, q);
    });
  }

  async list(ctx: ExecutionContext, input: any = {}) {
    await this.k.authorize(ctx, "intel.knowledge.research");
    await assertVideoRetentionJournal(this.k.e, ctx);
    const { limit, cursor } = page(input);
    const rows = (await this.db.query(`SELECT * FROM flow_video_skill_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND id>$3 ORDER BY id LIMIT $4`, [ctx.tenant_id, ctx.workspace_id, cursor, limit + 1])).rows;
    const items = [];
    for (const row of rows.slice(0, limit)) items.push(await this.visible(ctx, row));
    return { items, next_cursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  async get(ctx: ExecutionContext, id: string) {
    await this.k.authorize(ctx, "intel.knowledge.research");
    await assertVideoRetentionJournal(this.k.e, ctx);
    return this.visible(ctx, await this.row(ctx, id));
  }
  async visible(ctx: ExecutionContext, row: any) {
    const unavailable = () => ({ id: row.id, skill_id: row.skill_id, skill_version: row.skill_version, candidate_hash: row.candidate_hash, native_skill_hash: row.native_skill_hash,
      state: row.state, unavailable: true, dependency_status: "unavailable", proposal: null, eval_result: null, approval: null, release_package: null, receipts: row.receipts });
    if (row.state === "retired") return unavailable();
    try { await this.dependencies(ctx, row.proposal.knowledge_releases, row.proposal.evidence); }
    catch (e: any) { if ([404, 409, 422].includes(e.status)) return unavailable(); throw e; }
    return row;
  }

  async requestEvaluation(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.k.authorize(ctx, "intel.skills.release", true);
    return this.k.command(ctx, `skill_candidate.evaluate_request:${id}`, key, input, async q => {
      const row = await this.row(ctx, id, q, true); this.expected(row, input);
      if (!["draft", "evaluation_running"].includes(row.state)) fail("evaluation_not_requestable", 409);
      await this.dependencies(ctx, row.proposal.knowledge_releases, row.proposal.evidence, q);
      await q.query(`UPDATE flow_video_skill_candidates SET state='evaluation_running',eval_result=$4,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id, JSON.stringify({ grant_actor: actor(ctx), requested_at: this.k.e.now().toISOString() })]);
      await q.query(`UPDATE flow_video_skill_eval_tasks SET state=CASE WHEN task_id IS NULL THEN 'queued' ELSE 'submitted' END,result=NULL,next_poll_at=now(),lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1 WHERE tenant_id=$1 AND workspace_id=$2 AND candidate_id=$3 AND state='blocked'`, [ctx.tenant_id, ctx.workspace_id, id]);
      for (const c of row.proposal.eval_spec.cases) for (const variant of ["base", "without_skill", "candidate"]) {
        await q.query(`INSERT INTO flow_video_skill_eval_tasks(tenant_id,workspace_id,candidate_id,case_id,variant,request_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [ctx.tenant_id, ctx.workspace_id, id, c.id, variant, knowledgeHash({ candidate_hash: row.candidate_hash, case: c, variant, model_config: row.proposal.eval_spec.model_config })]);
      }
      await this.k.e.emit(q, ctx, id, id, "video.skill_evaluation_requested", { candidate_id: id, candidate_hash: row.candidate_hash, eval_spec_hash: knowledgeHash(row.proposal.eval_spec), grant_actor: actor(ctx) });
      return this.row(ctx, id, q);
    });
  }

  async evaluate(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.k.authorize(ctx, "intel.skills.evaluate");
    if (ctx.actor.type !== "service_principal") fail("trusted_evaluator_required", 403);
    return this.k.command(ctx, `skill_candidate.evaluate:${id}`, key, input, async q => {
      const row = await this.row(ctx, id, q, true); this.expected(row, input);
      if (row.state !== "evaluation_running") fail("evaluation_not_running", 409);
      if (!row.eval_result?.grant_actor || (this.k.e.authorize && !await this.k.e.authorize({ ...ctx, grant_actor: row.eval_result.grant_actor }, "intel.skills.release"))) fail("evaluation_grant_revoked", 403);
      await this.dependencies(ctx, row.proposal.knowledge_releases, row.proposal.evidence, q);
      const report = input.report, spec = row.proposal.eval_spec;
      if (!report || report.eval_spec_hash !== knowledgeHash(spec) || report.candidate_hash !== row.candidate_hash || report.model_config_hash !== knowledgeHash(spec.model_config)
        || report.dataset_version !== spec.dataset_version || report.base_hash !== row.proposal.base.hash) fail("evaluation_frozen_input_mismatch");
      hashField(report.actual_model_config_hash, "actual_model_config_hash");
      if (!Array.isArray(report.cases) || report.cases.length !== spec.cases.length || new Set(report.cases.map((c: any) => c.id)).size !== spec.cases.length) fail("evaluation_incomplete");
      let passed = true;
      for (const expected of spec.cases) {
        const result = report.cases.find((r: any) => r.id === expected.id);
        if (!result || result.input_hash !== knowledgeHash({ input: expected.input, expected: expected.expected }) || typeof result.critical_failure !== "boolean") fail("evaluation_case_input_mismatch");
        for (const variant of ["base", "without_skill", "candidate"]) {
          const score = result[variant];
          if (!score || typeof score.score !== "number" || !Number.isFinite(score.score) || score.score < 0 || score.score > 1 || typeof score.passed !== "boolean") fail("evaluation_comparison_missing");
          if (score.actual_model_config_hash !== report.actual_model_config_hash) fail("evaluation_model_configuration_changed");
          textField(score.run_id, "evaluation_run_id", 200); textField(score.usage_ref, "evaluation_usage_ref", 200);
        }
        if (result.critical_failure || !result.candidate.passed || result.candidate.score < result.base.score || result.candidate.score < result.without_skill.score) passed = false;
      }
      const evaluation = { ...report, passed, recorded_by: actor(ctx), recorded_at: this.k.e.now().toISOString() };
      await q.query(`INSERT INTO flow_video_skill_evaluations(id,tenant_id,workspace_id,candidate_id,candidate_hash,report,actor) VALUES($1,$2,$3,$4,$5,$6,$7)`, [newVideoId("veval_"), ctx.tenant_id, ctx.workspace_id, id, row.candidate_hash, JSON.stringify(evaluation), actor(ctx)]);
      await q.query(`UPDATE flow_video_skill_candidates SET state=$4,eval_result=$5,approval=NULL,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id, passed ? "passed" : "rejected", JSON.stringify(evaluation)]);
      return this.row(ctx, id, q);
    });
  }

  async review(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.k.authorize(ctx, "intel.skills.release", true);
    const reason = textField(input.reason, "release_review_reason", 2000);
    if (!["approve", "reject"].includes(input.decision)) fail("invalid_release_decision");
    return this.k.command(ctx, `skill_candidate.review:${id}`, key, input, async q => {
      const row = await this.row(ctx, id, q, true); this.expected(row, input);
      if (row.state !== "passed" || !row.eval_result?.passed) fail("passed_evaluation_required", 409);
      await this.dependencies(ctx, row.proposal.knowledge_releases, row.proposal.evidence, q);
      const approval = { actor: actor(ctx), reason, candidate_hash: row.candidate_hash, eval_hash: knowledgeHash(row.eval_result), approved_at: this.k.e.now().toISOString() };
      await q.query(`UPDATE flow_video_skill_candidates SET state=$4,approval=$5,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id, input.decision === "approve" ? "approved_for_release" : "rejected", JSON.stringify(approval)]);
      return this.row(ctx, id, q);
    });
  }

  async export(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.k.authorize(ctx, "intel.skills.release", true);
    return this.k.command(ctx, `skill_candidate.export:${id}`, key, input, async q => {
      const row = await this.row(ctx, id, q, true); this.expected(row, input);
      if (row.state !== "approved_for_release" || row.approval?.candidate_hash !== row.candidate_hash) fail("approved_release_required", 409);
      await this.dependencies(ctx, row.proposal.knowledge_releases, row.proposal.evidence, q);
      // Return only a native source-controlled pack, plus a separate provenance manifest.
      const pack = { ...row.proposal.pack, skills: row.proposal.pack.skills.map((s: any) => ({ ...s, output_schema: canonical(s.output_schema) })) };
      const release_package = { pack, pack_json: JSON.stringify(pack), manifest: { schema_version: 1, tenant_id: ctx.tenant_id, workspace_id: ctx.workspace_id, candidate_id: id, candidate_hash: row.candidate_hash,
        native_skill_hash: row.native_skill_hash, base: row.proposal.base, knowledge_releases: row.proposal.knowledge_releases,
        evidence: row.proposal.evidence, rule_evidence: row.proposal.rule_evidence,
        eval_report_hash: knowledgeHash(row.eval_result), approval: row.approval }, deployment_status: "not_deployed" };
      await q.query(`UPDATE flow_video_skill_candidates SET state='release_package_exported',release_package=$4,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id, JSON.stringify(release_package)]);
      return { ...await this.row(ctx, id, q), release_package };
    });
  }

  async deploymentCheck(ctx: ExecutionContext, id: string, input: any) {
    await this.k.authorize(ctx, "intel.skills.deploy");
    if (ctx.actor.type !== "service_principal" || ctx.actor.id !== "video-skill-deployer") fail("trusted_build_receipt_required", 403);
    await assertVideoRetentionJournal(this.k.e, ctx);
    const row = await this.row(ctx, id); this.expected(row, input);
    if (!["release_package_exported", "deployed", "workspace_installed"].includes(row.state) || row.approval?.candidate_hash !== row.candidate_hash
      || !row.release_package || row.approval.eval_hash !== knowledgeHash(row.eval_result)) fail("approved_export_required", 409);
    if ((input.candidate_id && input.candidate_id !== id) || input.skill_id !== row.skill_id || input.version !== row.skill_version || input.hash !== row.native_skill_hash) fail("release_receipt_hash_mismatch", 409);
    const manifest = row.release_package.manifest, release_package_hash = knowledgeHash(row.release_package);
    if (manifest.tenant_id !== ctx.tenant_id || manifest.workspace_id !== ctx.workspace_id || (input.release_package_hash && input.release_package_hash !== release_package_hash)) fail("release_package_scope_or_hash_mismatch", 409);
    await this.dependencies(ctx, row.proposal.knowledge_releases, row.proposal.evidence);
    return { tenant_id: ctx.tenant_id, workspace_id: ctx.workspace_id, candidate_id: id, candidate_hash: row.candidate_hash, native_skill_hash: row.native_skill_hash, release_package_hash };
  }

  async receipt(ctx: ExecutionContext, id: string, key: string, input: any) {
    const kind = input.kind;
    if (!["deployed", "workspace_installed"].includes(kind)) fail("invalid_release_receipt");
    await this.k.authorize(ctx, kind === "deployed" ? "intel.skills.deploy" : "intel.skills.install");
    if (ctx.actor.type !== "service_principal") fail("trusted_build_or_install_receipt_required", 403);
    return this.k.command(ctx, `skill_candidate.receipt:${id}:${kind}`, key, input, async q => {
      const row = await this.row(ctx, id, q, true); this.expected(row, input);
      const allowedStates = kind === "deployed" ? ["release_package_exported", "deployed", "workspace_installed"] : ["deployed", "workspace_installed"];
      if (!allowedStates.includes(row.state)) fail("release_receipt_out_of_order", 409);
      if (input.skill_id !== row.skill_id || input.version !== row.skill_version || input.hash !== row.native_skill_hash) fail("release_receipt_hash_mismatch", 409);
      if (kind === "deployed" && (hashField(input.release_package_hash, "release_package_hash") !== knowledgeHash(row.release_package) || !hashField(input.executable_sha256, "executable_sha256"))) fail("release_build_attestation_mismatch", 409);
      await this.dependencies(ctx, row.proposal.knowledge_releases, row.proposal.evidence, q);
      const receipt = { kind, skill_id: input.skill_id, version: input.version, hash: input.hash, receipt_id: textField(input.receipt_id, "receipt_id", 200),
        build_revision: textField(input.build_revision, "build_revision", 200), ...(kind === "deployed" ? { release_package_hash: input.release_package_hash, executable_sha256: input.executable_sha256 } : {}), actor: actor(ctx), recorded_at: this.k.e.now().toISOString() };
      await q.query(`UPDATE flow_video_skill_candidates SET state=$4,receipts=receipts || $5::jsonb,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id, row.state === "workspace_installed" ? row.state : kind, JSON.stringify([receipt])]);
      return this.row(ctx, id, q);
    });
  }

  /** Go calls this before install and each pinned run, not just when the candidate was approved. */
  async checkPin(ctx: ExecutionContext, input: any) {
    if (ctx.actor?.type === "service_principal" && ctx.actor.id === "video-skill-reader" && ctx.scopes?.includes("intel.knowledge.read")) {
      if (!ctx.tenant_id || !ctx.workspace_id) fail("verified_scope_required", 403);
    } else await this.k.authorize(ctx, "intel.knowledge.read");
    await assertVideoRetentionJournal(this.k.e, ctx);
    const row = (await this.db.query(`SELECT * FROM flow_video_skill_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND skill_id=$3 AND skill_version=$4 AND native_skill_hash=$5`, [ctx.tenant_id, ctx.workspace_id, input.skill_id, input.version, input.hash])).rows[0];
    if (!row || !["deployed", "workspace_installed"].includes(row.state)) fail("deployed_candidate_unavailable", 409);
    await this.dependencies(ctx, row.proposal.knowledge_releases, row.proposal.evidence);
    return { available: true, candidate_id: row.id, candidate_hash: row.candidate_hash, native_skill_hash: row.native_skill_hash, knowledge_releases: row.proposal.knowledge_releases };
  }
}

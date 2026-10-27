import type { ExecutionContext } from "./auth.ts";
import type { Q } from "./db.ts";
import type { VideoKnowledgeService } from "./video-knowledge.ts";
import { fail, hashField, knowledgeHash, textField } from "./video-knowledge-contract.ts";

const ACTIONS = ["subscription_paused", "media_expired", "remote_unavailable", "revoked", "erased"];
const LIMIT = 500;
type Scope = Pick<ExecutionContext, "tenant_id" | "workspace_id">;
export function retentionTarget(input: any) {
  if (!input || !ACTIONS.includes(input.action) || Boolean(input.source_id) === Boolean(input.asset_id)) fail("invalid_retention_action");
  const field = input.source_id ? "source_id" : "asset_id";
  const id = textField(input[field], field, 200);
  if (input.action === "subscription_paused" && field !== "source_id") fail("source_id_required");
  return { action: input.action as string, target: { [field]: id } };
}

/** ID/state-only inventory. Never returns object keys, URLs, source config or content. */
export async function retentionImpact(q: Q, ctx: Scope, input: any, now: Date) {
  const { action, target } = retentionTarget(input), params = [ctx.tenant_id, ctx.workspace_id];
  const bounded = async (sql: string, extra: unknown[] = []) => {
    const rows = (await q.query(sql + ` LIMIT ${LIMIT + 1}`, [...params, ...extra])).rows;
    if (rows.length > LIMIT) fail("retention_impact_too_large_choose_asset", 413);
    return rows;
  };
  const selectedSources = target.source_id ? await bounded(`SELECT id,status,revision FROM flow_sources WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [target.source_id]) : [];
  if (target.source_id && !selectedSources.length) fail("source_not_found", 404);
  const assets = await bounded(`SELECT a.id,a.availability,a.revoked_at FROM flow_video_assets a WHERE a.tenant_id=$1 AND a.workspace_id=$2
    AND ($3::text IS NULL OR a.id=$3) AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM flow_video_asset_sources s WHERE s.tenant_id=a.tenant_id AND s.workspace_id=a.workspace_id AND s.asset_id=a.id AND s.source_id=$4)) ORDER BY a.id`, [target.asset_id ?? null, target.source_id ?? null]);
  if (target.asset_id && !assets.length) fail("asset_not_found", 404);
  const assetIds = assets.map(x => x.id);
  const sources = await bounded(`SELECT DISTINCT s.id,s.status,s.revision FROM flow_sources s LEFT JOIN flow_video_asset_sources a ON a.tenant_id=s.tenant_id AND a.workspace_id=s.workspace_id AND a.source_id=s.id
    WHERE s.tenant_id=$1 AND s.workspace_id=$2 AND (a.asset_id=ANY($3::text[]) OR s.id=$4) ORDER BY s.id`, [assetIds, target.source_id ?? null]);
  const jobs = await bounded(`SELECT id,asset_id,state,document_id,revision FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND asset_id=ANY($3::text[]) ORDER BY id`, [assetIds]);
  const objects = await bounded(`SELECT object_id AS id,video_job_id,state,retention_class,access_expires_at,max_expires_at FROM flow_video_objects WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[]) ORDER BY object_id`, [jobs.map(x => x.id)]);
  const documents = await bounded(`SELECT id,source_id,current_revision,video_ready,video_revoked_at,video_text_access_expires_at FROM flow_documents WHERE tenant_id=$1 AND workspace_id=$2 AND video_asset_id=ANY($3::text[]) ORDER BY id`, [assetIds]);
  const docs = documents.map(x => x.id);
  const evidence = await bounded(`SELECT id,document_id,revision FROM flow_evidence WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[]) ORDER BY id`, [docs]);
  const knowledge = await bounded(`SELECT id,version,state,content_hash,release_id FROM flow_knowledge_units WHERE tenant_id=$1 AND workspace_id=$2 AND id IN
    (SELECT knowledge_id FROM flow_knowledge_evidence_refs WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])) ORDER BY id`, [docs]);
  const skills = await bounded(`SELECT id,skill_id,skill_version,state,candidate_hash,native_skill_hash FROM flow_video_skill_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND id IN
    (SELECT candidate_id FROM flow_video_skill_dependencies WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=ANY($3::text[])) ORDER BY id`, [knowledge.map(x => x.id)]);
  const reports = await bounded(`SELECT r.id,r.video_revoked_at FROM flow_reports r WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND EXISTS
    (SELECT 1 FROM flow_claims c,jsonb_array_elements(c.citations) x WHERE c.tenant_id=r.tenant_id AND c.report_id=r.id AND x->>'document_id'=ANY($3::text[])) ORDER BY r.id`, [docs]);
  const research = await bounded(`SELECT r.id,r.status,r.video_revoked_at FROM flow_research_runs r WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND
    (EXISTS(SELECT 1 FROM jsonb_path_query(coalesce(r.output,'{}'), '$.**.document_id') x WHERE x #>> '{}' = ANY($3::text[])) OR EXISTS
    (SELECT 1 FROM flow_documents d WHERE d.tenant_id=r.tenant_id AND d.workspace_id=r.workspace_id AND d.id=ANY($3::text[]) AND (r.evidence_scope->'document_ids' ? d.id OR r.evidence_scope->'source_ids' ? d.source_id))) ORDER BY r.id`, [docs]);
  const dependencies = { sources, assets, jobs, objects, documents, evidence, knowledge, skills, reports, research };
  const inaccessible = new Set(documents.filter(d => d.video_revoked_at || d.video_text_access_expires_at && new Date(d.video_text_access_expires_at) <= now).map(d => d.id));
  const destructive = ["revoked", "erased"].includes(action);
  const snapshot = {
    action, target, dependencies, counts: Object.fromEntries(Object.entries(dependencies).map(([key, rows]) => [key, rows.length])),
    current_visibility: { access_revoked_documents: inaccessible.size, remaining_documents_require_live_authorization: documents.length - inaccessible.size,
      published_knowledge: knowledge.filter(k => k.state === "published").length, active_skill_candidates: skills.filter(s => s.state !== "retired").length },
    after_action: { source_status_changes: Boolean(target.source_id) && ["subscription_paused", "revoked", "erased"].includes(action), knowledge_revoked: destructive,
      historical_content_access: destructive ? "denied" : "unchanged_subject_to_live_authorization", content_erased: action === "erased", historical_run_pins: "retained_not_rewritten", unrelated_canvas_messages_finances: "unchanged" },
    audit_retained: { identifiers: true, hashes: true, review_decisions: true, financial_events: true, deletion_journal: destructive ? "required_before_mutation" : "not_required" },
    physical_cleanup: { pending: objects.filter(o => o.state === "delete_pending").length, deleted: objects.filter(o => o.state === "deleted").length,
      will_request: destructive ? objects.filter(o => o.state !== "deleted").length : 0, completion: "requires_object_worker_receipt_not_implied_by_access_revocation" },
  };
  // Database drivers return Date objects; canonical hashing must include their
  // actual timestamps, not an empty object produced by generic key sorting.
  return { ...snapshot, preview_hash: knowledgeHash(JSON.parse(JSON.stringify({ version: 1, ...ctx, ...snapshot }))), limit_per_category: LIMIT, truncated: false as const };
}

/** Prevent new dependency phantoms between confirmation recheck and journal append.
 * Only the bounded, explicitly confirmed write takes this short lock; reads do not.
 * Lock before row selection, and fail quickly rather than holding an indefinite UI request.
 */
export async function assertRetentionImpact(q: Q, ctx: Scope, input: any, now: Date) {
  hashField(input.expected_impact_hash, "expected_impact_hash");
  await q.query(`SET LOCAL lock_timeout='3s'`);
  await q.query(`LOCK TABLE flow_sources,flow_video_assets,flow_video_asset_sources,flow_video_jobs,flow_video_objects,flow_documents,flow_document_revisions,flow_evidence,flow_knowledge_units,flow_knowledge_versions,flow_knowledge_evidence_refs,flow_knowledge_releases,flow_video_skill_candidates,flow_video_skill_dependencies,flow_reports,flow_claims,flow_research_runs IN SHARE ROW EXCLUSIVE MODE`);
  const current = await retentionImpact(q, ctx, input, now);
  if (current.preview_hash !== input.expected_impact_hash) fail("retention_preview_changed", 409);
}

export class VideoRetentionImpact {
  readonly knowledge: VideoKnowledgeService;
  constructor(knowledge: VideoKnowledgeService) { this.knowledge = knowledge; }
  async preview(ctx: ExecutionContext, input: any) {
    await this.knowledge.authorize(ctx, "intel.sources.write", true);
    return this.knowledge.db.tx(async q => {
      await q.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      return retentionImpact(q, { tenant_id: ctx.tenant_id, workspace_id: ctx.workspace_id }, input, this.knowledge.e.now());
    });
  }
  async batch(ctx: ExecutionContext, input: any) {
    await this.knowledge.authorize(ctx, "intel.sources.write", true);
    if (!Array.isArray(input?.items) || !input.items.length || input.items.length > 20) fail("invalid_retention_batch");
    const targets = new Set<string>();
    for (const item of input.items) {
      const target = retentionTarget(item); hashField(item.expected_impact_hash, "expected_impact_hash"); textField(item.idempotency_key, "idempotency_key", 200); textField(item.reason, "retention_reason", 2000);
      if (["revoked", "erased"].includes(item.action) && item.confirmation !== item.action) fail("irreversible_confirmation_required");
      const id = JSON.stringify(target.target); if (targets.has(id)) fail("duplicate_retention_target"); targets.add(id);
    }
    const results = [];
    for (const item of input.items) {
      const { action, target } = retentionTarget(item);
      try {
        const data = await this.knowledge.retention(ctx, item.idempotency_key, { action, ...target, reason: item.reason, expected_impact_hash: item.expected_impact_hash });
        results.push({ target, action, idempotency_key: item.idempotency_key, ok: true, data });
      } catch (error: any) { results.push({ target, action, idempotency_key: item.idempotency_key, ok: false, reason: error.reason ?? "retention_failed", status: error.status ?? 500 }); }
    }
    return { results, partial: results.some(x => x.ok) && results.some(x => !x.ok), audit_retained: true };
  }
}

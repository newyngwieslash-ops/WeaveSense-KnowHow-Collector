import type { Engine } from "./engine.ts";
import type { Q } from "./db.ts";
import type { ExecutionContext } from "./auth.ts";
import { requireScope } from "./auth.ts";
import { newVideoId, sha } from "./video-contract.ts";
import { knowledgeHash, fail, textField, hashField, validateUnit, validateMethod, evidenceRefs, MATERIAL_TYPES, KNOWLEDGE_STATES } from "./video-knowledge-contract.ts";
import { knowledgeRuntime } from "./video-knowledge-runtime.ts";
import { appendVideoRetentionIntent, markVideoRetentionApplied, assertVideoRetentionJournal, lockVideoRetentionTransaction, videoRetentionCheckpoint } from "./video-journal.ts";
import type { VideoRetentionRecord } from "./video-journal.ts";
import { assertRetentionImpact } from "./video-retention-impact.ts";

type Scope = Pick<ExecutionContext, "tenant_id" | "workspace_id">;
const actor = (s: ExecutionContext) => `${s.actor.type}:${s.actor.id}`;
const json = (v: any) => typeof v === "string" ? JSON.parse(v) : v;
export const page = (o: any = {}) => ({ limit: Math.min(100, Math.max(1, Number(o.limit) || 25)), cursor: typeof o.cursor === "string" ? o.cursor : "" });
const resultPage = (rows: any[], limit: number) => ({ items: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null });
const splitSurrogate = (s: string, n: number) => n > 0 && n < s.length && /[\uD800-\uDBFF]/.test(s[n - 1]) && /[\uDC00-\uDFFF]/.test(s[n]);

/** Startup-only replay of an already authenticated external deletion intent. */
export async function applyVideoRetention(engine: Engine, q: Q, scope: Scope, input: { action: string; source_id?: string; asset_id?: string }) {
  if (!["revoked", "erased"].includes(input.action) || Boolean(input.source_id) === Boolean(input.asset_id)) fail("invalid_retention_replay", 422);
  return new VideoKnowledgeService(engine).applyRetention(q, scope, { ...input, reason: "verified deletion journal replay" }, async () => {}, true);
}

/** Called in the SAME transaction as access revocation; safe to replay after backup restore. */
export async function revokeVideoDependencies(q: Q, scope: Scope, documentIds: string[], reason = "revoked", erase = false) {
  if (!documentIds.length) return { knowledge_ids: [], skill_candidate_ids: [] };
  const docs = (await q.query(`SELECT id FROM flow_documents WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[]) FOR UPDATE`, [scope.tenant_id, scope.workspace_id, documentIds])).rows.map(x => x.id);
  if (docs.length !== new Set(documentIds).size) fail("document_not_found", 404);
  const videoJobs = (await q.query(`SELECT id FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs])).rows.map(x => x.id);
  await q.query(`UPDATE flow_video_origin_checks SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1 WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs]);
  await q.query(`UPDATE flow_video_origin_candidates SET state='unavailable' WHERE tenant_id=$1 AND workspace_id=$2 AND (left_asset_id IN (SELECT video_asset_id FROM flow_documents WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])) OR right_asset_id IN (SELECT video_asset_id FROM flow_documents WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])))`, [scope.tenant_id, scope.workspace_id, docs]);
  await q.query(`UPDATE flow_video_embedding_staging SET state='cancelled' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, videoJobs]);
  const extractionRuns = (await q.query(`UPDATE flow_video_knowledge_runs SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1 WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[]) RETURNING id`, [scope.tenant_id, scope.workspace_id, docs])).rows.map(x => x.id);
  const evidenceIds = (await q.query(`SELECT id FROM flow_evidence WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs])).rows.map(x => x.id);
  await q.query(`UPDATE flow_documents SET video_revoked_at=coalesce(video_revoked_at,now()) WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs]);
  for (const id of docs) await q.query(`INSERT INTO flow_video_deletion_tombstones(id,tenant_id,workspace_id,document_id,action) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [newVideoId("vdel_"), scope.tenant_id, scope.workspace_id, id, erase ? "erased" : "revoked"]);
  const ids = (await q.query(`SELECT DISTINCT knowledge_id FROM flow_knowledge_evidence_refs WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs])).rows.map(x => x.knowledge_id);
  await q.query(`UPDATE flow_knowledge_units SET state='withdrawn',approval=NULL,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, ids]);
  await q.query(`UPDATE flow_knowledge_releases SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, ids]);
  const skills = (await q.query(`UPDATE flow_video_skill_candidates SET state='retired',approval=NULL,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id IN
    (SELECT candidate_id FROM flow_video_skill_dependencies WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=ANY($3::text[])) RETURNING id`, [scope.tenant_id, scope.workspace_id, ids])).rows.map(x => x.id);
  const reports = (await q.query(`UPDATE flow_reports r SET video_revoked_at=coalesce(video_revoked_at,now()) WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND EXISTS
    (SELECT 1 FROM flow_claims c,jsonb_array_elements(c.citations) x WHERE c.tenant_id=r.tenant_id AND c.report_id=r.id AND x->>'document_id'=ANY($3::text[])) RETURNING r.id`, [scope.tenant_id, scope.workspace_id, docs])).rows.map(x => x.id);
  const research = (await q.query(`UPDATE flow_research_runs r SET video_revoked_at=coalesce(video_revoked_at,now()),status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END
    WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND (EXISTS(SELECT 1 FROM jsonb_path_query(coalesce(r.output,'{}'), '$.**.document_id') x WHERE x #>> '{}' = ANY($3::text[]))
      OR EXISTS(SELECT 1 FROM flow_documents d WHERE d.tenant_id=r.tenant_id AND d.workspace_id=r.workspace_id AND d.id=ANY($3::text[]) AND
        (r.evidence_scope->'document_ids' ? d.id OR r.evidence_scope->'source_ids' ? d.source_id))) RETURNING id`, [scope.tenant_id, scope.workspace_id, docs])).rows.map(x => x.id);
  // Current and historical access is denied first; physical media reclamation remains the core object-store worker's responsibility.
  await q.query(`DELETE FROM flow_document_chunks WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs]);
  await q.query(`DELETE FROM flow_document_embeddings WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs]);
  if (erase) {
    await q.query(`DELETE FROM flow_video_origin_fingerprints WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs]);
    await q.query(`UPDATE flow_video_origin_candidates SET proposal='{}',review=CASE WHEN review IS NULL THEN NULL ELSE review || '{"reason":"content erased"}'::jsonb END WHERE tenant_id=$1 AND workspace_id=$2 AND state='unavailable' AND (left_asset_id IN (SELECT video_asset_id FROM flow_documents WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])) OR right_asset_id IN (SELECT video_asset_id FROM flow_documents WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])))`, [scope.tenant_id, scope.workspace_id, docs]);
    await q.query(`UPDATE flow_video_embedding_staging SET payload='{}' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, videoJobs]);
    await q.query(`UPDATE flow_video_embedding_batches SET request='{}',vectors=NULL,state='cancelled' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, videoJobs]);
    await q.query(`UPDATE flow_document_revisions SET title='',body='' WHERE tenant_id=$1 AND document_id=ANY($2::text[])`, [scope.tenant_id, docs]);
    await q.query(`UPDATE flow_video_corrections SET artifact='{}',reason='content erased' WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs]);
    await q.query(`UPDATE flow_video_knowledge_runs SET frozen_input='{}',model_request=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, extractionRuns]);
    await q.query(`UPDATE flow_documents SET title='' WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs]);
    await q.query(`UPDATE flow_evidence SET quote='' WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, docs]);
    await q.query(`UPDATE flow_knowledge_versions SET unit='{}',evidence_snapshot='[]' WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, ids]);
    await q.query(`UPDATE flow_knowledge_releases SET snapshot='{}' WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, ids]);
    await q.query(`UPDATE flow_knowledge_reviews SET reason='content erased' WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, ids]);
    await q.query(`UPDATE flow_knowledge_conflicts SET reason='content erased' WHERE tenant_id=$1 AND workspace_id=$2 AND (left_id=ANY($3::text[]) OR right_id=ANY($3::text[]))`, [scope.tenant_id, scope.workspace_id, ids]);
    await q.query(`UPDATE flow_video_skill_candidates SET proposal='{}',eval_result=NULL,release_package=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, skills]);
    await q.query(`UPDATE flow_video_skill_evaluations SET report='{}' WHERE tenant_id=$1 AND workspace_id=$2 AND candidate_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, skills]);
    await q.query(`UPDATE flow_video_skill_eval_tasks SET result='{}',model_request=NULL,state='cancelled',lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1 WHERE tenant_id=$1 AND workspace_id=$2 AND candidate_id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, skills]);
    await q.query(`UPDATE flow_knowledge_commands SET result=jsonb_build_object('id',result->>'id','unavailable',true) WHERE tenant_id=$1 AND workspace_id=$2 AND result->>'id'=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, [...ids, ...skills]]);
    await q.query(`UPDATE flow_reports SET title='',body='',structured_output='{}' WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, reports]);
    await q.query(`UPDATE flow_claims SET text='',citations='[]' WHERE tenant_id=$1 AND report_id=ANY($2::text[])`, [scope.tenant_id, reports]);
    await q.query(`UPDATE flow_research_runs SET question='',output=NULL,error=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [scope.tenant_id, scope.workspace_id, research]);
    const obsolete = (await q.query(`SELECT event_id,job_id,payload FROM flow_outbox WHERE tenant_id=$1 AND workspace_id=$2 AND job_id=ANY($3::text[])
      AND type IN ('report.completed','research.completed','research.failed') FOR UPDATE`, [scope.tenant_id, scope.workspace_id, [...reports, ...research]])).rows;
    for (const event of obsolete) {
      const audit = { content_erased: true, original_payload_hash: event.payload.original_payload_hash ?? knowledgeHash(event.payload),
        ...(reports.includes(event.job_id) ? { report_id: event.job_id } : { research_run_id: event.job_id }) };
      // Suppress an obsolete pending completion; the new dependency tombstone is
      // always delivered. Financial events and sequence/audit identity are retained.
      await q.query(`UPDATE flow_outbox SET payload=$2,delivered_at=coalesce(delivered_at,now()) WHERE event_id=$1`, [event.event_id, JSON.stringify(audit)]);
    }
  }
  // No original text or user-supplied reason in the durable tombstone/event.
  const batches = Math.max(1, ...[docs, videoJobs, extractionRuns, evidenceIds, ids, skills, reports, research].map(x => Math.ceil(x.length / 200))), operation = newVideoId("revoke_");
  for (let batch = 0; batch < batches; batch++) {
    const part = (values: string[]) => values.slice(batch * 200, (batch + 1) * 200);
    await q.query(`INSERT INTO flow_outbox(event_id,tenant_id,workspace_id,operation_id,job_id,type,payload) VALUES($1,$2,$3,$4,$4,'knowledge.dependencies_revoked',$5)`,
      [newVideoId("evt_"), scope.tenant_id, scope.workspace_id, operation, JSON.stringify({ document_ids: part(docs), video_job_ids: part(videoJobs), extraction_run_ids: part(extractionRuns), evidence_ids: part(evidenceIds),
        knowledge_ids: part(ids), skill_candidate_ids: part(skills), report_ids: part(reports), research_run_ids: part(research), action: erase ? "erased" : "revoked", cache_invalidation_required: true, batch_index: batch, batch_count: batches })]);
  }
  return { knowledge_ids: ids, skill_candidate_ids: skills };
}

export class VideoKnowledgeService {
  e: Engine;
  constructor(engine: Engine) { this.e = engine; }
  get db() { return this.e.db; }

  async authorize(ctx: ExecutionContext, scope: string, human = false) {
    requireScope(ctx, scope);
    if (!ctx.actor?.id || !ctx.tenant_id || !ctx.workspace_id) fail("verified_actor_required", 403);
    if (human && ctx.actor.type !== "user") fail("human_review_required", 403);
    const trusted: Record<string, string> = { "intel.skills.install": "video-skill-installer", "intel.skills.deploy": "video-skill-deployer", "intel.skills.evaluate": "video-model-evaluator", "intel.knowledge.extract": "video-knowledge-extractor", "intel.video.model": "video-model-gateway" };
    if (ctx.actor.type === "service_principal" && trusted[scope]) {
      if (ctx.actor.id !== trusted[scope]) fail("trusted_service_identity_required", 403);
      return;
    }
    if (this.e.authorize && !await this.e.authorize({ ...ctx, grant_actor: actor(ctx) }, scope)) fail("grant_revoked", 403);
  }

  async command<T>(ctx: Scope, namespace: string, key: string, input: unknown, fn: (q: Q) => Promise<T>): Promise<T> {
    textField(key, "idempotency_key", 200);
    const hash = knowledgeHash(input);
    return this.db.tx(async q => {
      // Serializes concurrent same-key commands without limiting unrelated workspaces/commands.
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [JSON.stringify([ctx.tenant_id, ctx.workspace_id, namespace, key])]);
      const old = (await q.query(`SELECT request_hash,result FROM flow_knowledge_commands WHERE tenant_id=$1 AND workspace_id=$2 AND namespace=$3 AND idempotency_key=$4`, [ctx.tenant_id, ctx.workspace_id, namespace, key])).rows[0];
      if (old) {
        if (old.request_hash !== hash) fail("idempotency_conflict", 409);
        const result = json(old.result);
        // A replay cannot revive a formerly published snapshot after access was revoked.
        if (result.id && namespace.startsWith("knowledge.")) {
          const current = await this.current(ctx, result.id, q);
          if (["withdrawn", "superseded"].includes(current.state)) return { id: current.id, version: current.version, state: current.state, unavailable: true } as T;
          await this.resolveEvidence(ctx, evidenceRefs(current.unit.evidence), q);
          return current;
        }
        if (result.id && namespace.startsWith("skill_candidate.")) {
          const current = (await q.query(`SELECT * FROM flow_video_skill_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, result.id])).rows[0];
          if (!current || current.state === "retired") fail("skill_dependency_revoked", 409);
          return current;
        }
        return result;
      }
      const result = await fn(q);
      await q.query(`INSERT INTO flow_knowledge_commands(tenant_id,workspace_id,namespace,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)`, [ctx.tenant_id, ctx.workspace_id, namespace, key, hash, JSON.stringify(result)]);
      return result;
    });
  }

  async resolveEvidence(scope: Scope, refs: ReturnType<typeof evidenceRefs>, q: Q = this.db) {
    const rows = (await q.query(`SELECT e.id AS evidence_id,e.document_id,e.revision,e.char_start,e.char_end,e.quote,e.snippet_hash,
      r.title,r.body,r.content_hash AS revision_hash,coalesce(t.material_type,r.material_type) AS material_type,d.source_id,d.url,d.video_asset_id AS asset_id,
      a.origin_cluster,t.media_sha256,a.availability,t.video_job_id,t.start_ms,t.end_ms,t.frame_ref,t.alignment_method
      FROM flow_evidence e JOIN flow_documents d ON d.tenant_id=e.tenant_id AND d.workspace_id=e.workspace_id AND d.id=e.document_id
      JOIN flow_sources s ON s.tenant_id=d.tenant_id AND s.workspace_id=d.workspace_id AND s.id=d.source_id
      JOIN flow_document_revisions r ON r.tenant_id=e.tenant_id AND r.document_id=e.document_id AND r.revision=e.revision
      JOIN flow_video_assets a ON a.tenant_id=d.tenant_id AND a.workspace_id=d.workspace_id AND a.id=d.video_asset_id
      LEFT JOIN flow_video_temporal_evidence t ON t.tenant_id=e.tenant_id AND t.workspace_id=e.workspace_id AND t.evidence_id=e.id
      WHERE e.tenant_id=$1 AND e.workspace_id=$2 AND e.id=ANY($3::text[]) AND d.video_ready AND d.video_revoked_at IS NULL
      AND (d.video_text_access_expires_at>now() OR d.video_text_access_expires_at IS NULL AND NOT EXISTS(SELECT 1 FROM flow_video_jobs pj WHERE pj.tenant_id=d.tenant_id AND pj.workspace_id=d.workspace_id AND pj.document_id=d.id)) AND (r.video_text_access_expires_at IS NULL OR r.video_text_access_expires_at>now()) AND (e.video_expires_at IS NULL OR e.video_expires_at>now())
      AND a.revoked_at IS NULL AND s.status<>'revoked' AND s.config->'allowed_uses' ? 'knowledge' AND (s.config->>'authorization_expires_at' IS NULL OR (s.config->>'authorization_expires_at')::timestamptz>now())
      AND NOT EXISTS(SELECT 1 FROM flow_video_deletion_tombstones x WHERE x.tenant_id=d.tenant_id AND x.workspace_id=d.workspace_id AND x.document_id=d.id)
      FOR SHARE OF d,s,a,r,e`,
      [scope.tenant_id, scope.workspace_id, refs.map(x => x.evidence_id)])).rows;
    const map = new Map(rows.map(x => [x.evidence_id, x]));
    return refs.map(ref => {
      const ev = map.get(ref.evidence_id);
      if (!ev || ev.revision !== ref.revision || ev.snippet_hash !== ref.snippet_hash || sha(ev.quote) !== ev.snippet_hash) fail("evidence_unavailable_or_changed");
      if (!(MATERIAL_TYPES as readonly string[]).includes(ev.material_type)) fail("derived_conclusion_not_source_evidence");
      const text = `${ev.title}\n\n${ev.body}`;
      if (!Number.isSafeInteger(ev.char_start) || !Number.isSafeInteger(ev.char_end) || ev.char_start < 0 || ev.char_end <= ev.char_start || ev.char_end > text.length
        || splitSurrogate(text, ev.char_start) || splitSurrogate(text, ev.char_end) || text.slice(ev.char_start, ev.char_end) !== ev.quote) fail("evidence_quote_mismatch");
      // Hash computed by the host at evidence creation, not accepted from a worker as authority.
      return { ...ev, alignment_method: ev.alignment_method ?? "unknown", start_ms: ev.start_ms ?? null, end_ms: ev.end_ms ?? null };
    });
  }

  async checkUnit(scope: Scope, unit: ReturnType<typeof validateUnit>, q: Q) {
    const evidence = await this.resolveEvidence(scope, unit.evidence, q);
    const quotes = evidence.map(x => x.quote).join("\n");
    const origins = new Set(evidence.map(x => x.origin_cluster || x.media_sha256 || x.asset_id));
    if (unit.claim_kind === "cross_source_verified" && origins.size < 2) fail("independent_origins_required");
    if (unit.claim_kind === "cross_source_verified") {
      const assetIds = evidence.map(x => x.asset_id), unreviewedDocs = evidence.filter(x => !x.origin_cluster).map(x => x.document_id);
      const pending = await q.query(`SELECT 1 FROM flow_video_origin_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND state='pending' AND left_asset_id=ANY($3::text[]) AND right_asset_id=ANY($3::text[])
        UNION ALL SELECT 1 FROM flow_video_origin_checks WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=ANY($4::text[]) AND state NOT IN ('completed','cancelled') LIMIT 1`, [scope.tenant_id, scope.workspace_id, assetIds, unreviewedDocs]);
      if (pending.rows.length) fail("origin_independence_review_pending");
    }
    // Known unsupported critical values cannot be approved by confidence or a permissive LLM.
    const numbers = (text: string) => new Set(text.match(/[-+]?\d+(?:\.\d+)?/g) ?? []);
    const quotedNumbers = numbers(quotes);
    const containsUnit = (text: string, unit: string) => new RegExp(`(?<![A-Za-zµμ])${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-zµμ])`).test(text);
    for (const p of unit.parameters) if ((p.value != null || p.unit != null) && !evidence.some(ev =>
      (p.value == null || (/^[-+]?\d+(?:\.\d+)?$/.test(p.value) ? numbers(ev.quote).has(p.value) : ev.quote.includes(p.value)))
      && (p.unit == null || containsUnit(ev.quote, p.unit)))) fail("unsupported_parameter_value_or_unit");
    const assertions = [unit.statement, ...unit.applicability, ...unit.conditions, ...unit.steps, ...unit.boundaries, ...unit.counterexamples, ...unit.parameters.flatMap((p: { conditions: string[] }) => p.conditions)].join("\n");
    for (const n of assertions.match(/[-+]?\d+(?:\.\d+)?/g) ?? []) if (!quotedNumbers.has(n)) fail("unsupported_numeric_claim");
    return evidence.map(({ body: _body, ...ev }) => ev);
  }

  async current(scope: Scope, id: string, q: Q = this.db, lock = false) {
    const row = (await q.query(`SELECT k.*,v.unit,v.method,v.evidence_snapshot FROM flow_knowledge_units k
      JOIN flow_knowledge_versions v ON v.tenant_id=k.tenant_id AND v.workspace_id=k.workspace_id AND v.knowledge_id=k.id AND v.version=k.version
      WHERE k.tenant_id=$1 AND k.workspace_id=$2 AND k.id=$3 ${lock ? "FOR UPDATE OF k" : ""}`, [scope.tenant_id, scope.workspace_id, id])).rows[0];
    if (!row) fail("knowledge_not_found", 404);
    return row;
  }

  expected(row: any, o: any) {
    if (o.expected_version !== row.version || o.expected_hash !== row.content_hash) fail("knowledge_version_conflict", 409);
  }

  async appendVersion(q: Q, scope: Scope, id: string, version: number, hash: string, unit: any, method: any, evidence: any[], by: string) {
    await q.query(`INSERT INTO flow_knowledge_versions(tenant_id,workspace_id,knowledge_id,version,content_hash,unit,method,evidence_snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [scope.tenant_id, scope.workspace_id, id, version, hash, JSON.stringify(unit), JSON.stringify(method), JSON.stringify(evidence), by]);
    for (const ev of evidence) await q.query(`INSERT INTO flow_knowledge_evidence_refs(tenant_id,workspace_id,knowledge_id,version,evidence_id,document_id,revision,snippet_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [scope.tenant_id, scope.workspace_id, id, version, ev.evidence_id, ev.document_id, ev.revision, ev.snippet_hash]);
    // This is only a review queue, never an automatic verdict or majority vote.
    if (unit.conflict_key) {
      const others = (await q.query(`SELECT k.id,k.version,v.unit FROM flow_knowledge_units k JOIN flow_knowledge_versions v ON v.tenant_id=k.tenant_id AND v.workspace_id=k.workspace_id AND v.knowledge_id=k.id AND v.version=k.version
        WHERE k.tenant_id=$1 AND k.workspace_id=$2 AND k.id<>$3 AND v.unit->>'conflict_key'=$4 AND k.state NOT IN ('withdrawn','rejected','superseded') LIMIT 100`, [scope.tenant_id, scope.workspace_id, id, unit.conflict_key])).rows;
      for (const other of others) if (other.unit.statement !== unit.statement) await q.query(`INSERT INTO flow_knowledge_conflicts(id,tenant_id,workspace_id,left_id,left_version,right_id,right_version,relation,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'potential_conflict','same review key, differing statements',$8) ON CONFLICT DO NOTHING`, [newVideoId("kcf_"), scope.tenant_id, scope.workspace_id, other.id, other.version, id, version, by]);
    }
  }

  async create(ctx: ExecutionContext, key: string, input: any) {
    await this.authorize(ctx, "intel.knowledge.write");
    return this.command(ctx, "knowledge.create", key, input, q => this.createCandidate(q, ctx, input));
  }

  async createCandidate(q: Q, ctx: ExecutionContext, input: any) {
    const unit = validateUnit(input.unit), method = validateMethod(input.method);
      const profile = (await q.query(`SELECT config FROM flow_video_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND version=$4`, [ctx.tenant_id, ctx.workspace_id, input.profile_id, input.profile_version])).rows[0];
      if (!profile) fail("profile_not_found", 404);
      if (Array.isArray(profile.config.knowledge_types) && !profile.config.knowledge_types.includes(unit.type)) fail("knowledge_type_outside_profile");
      const evidence = await this.checkUnit(ctx, unit, q);
      const id = newVideoId("kn_"), hash = knowledgeHash({ unit, method, profile_id: input.profile_id, profile_version: input.profile_version });
      await q.query(`INSERT INTO flow_knowledge_units(id,tenant_id,workspace_id,profile_id,profile_version,content_hash,state,created_by) VALUES($1,$2,$3,$4,$5,$6,'candidate',$7)`, [id, ctx.tenant_id, ctx.workspace_id, input.profile_id, input.profile_version, hash, actor(ctx)]);
      await this.appendVersion(q, ctx, id, 1, hash, unit, method, evidence, actor(ctx));
      return this.current(ctx, id, q);
  }

  async edit(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.authorize(ctx, "intel.knowledge.write");
    const unit = validateUnit(input.unit);
    return this.command(ctx, `knowledge.edit:${id}`, key, input, async q => {
      const old = await this.current(ctx, id, q, true); this.expected(old, input);
      if (["withdrawn", "superseded"].includes(old.state)) fail("knowledge_not_editable", 409);
      const config = (await q.query(`SELECT config FROM flow_video_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND version=$4`, [ctx.tenant_id, ctx.workspace_id, old.profile_id, old.profile_version])).rows[0]?.config;
      if (Array.isArray(config?.knowledge_types) && !config.knowledge_types.includes(unit.type)) fail("knowledge_type_outside_profile");
      const evidence = await this.checkUnit(ctx, unit, q), version = old.version + 1;
      const hash = knowledgeHash({ unit, method: old.method, profile_id: old.profile_id, profile_version: old.profile_version });
      await this.appendVersion(q, ctx, id, version, hash, unit, old.method, evidence, actor(ctx));
      await q.query(`UPDATE flow_knowledge_units SET version=$4,content_hash=$5,state='candidate',approval=NULL,release_id=NULL,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id, version, hash]);
      await this.invalidateReleases(q, ctx, [id]);
      return this.current(ctx, id, q);
    });
  }

  async invalidateReleases(q: Q, ctx: Scope, ids: string[]) {
    await q.query(`UPDATE flow_knowledge_releases SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, ids]);
    await q.query(`UPDATE flow_video_skill_candidates SET state='retired',approval=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id IN(SELECT candidate_id FROM flow_video_skill_dependencies WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=ANY($3::text[]))`, [ctx.tenant_id, ctx.workspace_id, ids]);
  }

  async review(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.authorize(ctx, input.decision === "submit" ? "intel.knowledge.write" : "intel.knowledge.review", input.decision !== "submit");
    const reason = textField(input.reason, "review_reason", 2000);
    return this.command(ctx, `knowledge.review:${id}`, key, input, async q => {
      const old = await this.current(ctx, id, q, true); this.expected(old, input);
      const allowed: Record<string, string[]> = { submit: ["candidate"], approve: ["in_review"], reject: ["candidate", "in_review"], request_changes: ["in_review", "approved"] };
      if (!allowed[input.decision]?.includes(old.state)) fail("invalid_review_transition", 409);
      if (input.decision !== "submit") await this.profileReviewer(q, ctx, old, "reviewer_ids");
      let approval = null;
      if (input.decision === "approve") {
        if (input.checks?.evidence_support !== true || input.checks?.critical_fields !== true) fail("explicit_evidence_and_critical_field_review_required");
        await this.checkUnit(ctx, validateUnit(old.unit), q);
        approval = { actor: actor(ctx), version: old.version, content_hash: old.content_hash, reason, checks: input.checks, reviewed_at: this.e.now().toISOString() };
      }
      const state = { submit: "in_review", approve: "approved", reject: "rejected", request_changes: "candidate" }[input.decision as string];
      await q.query(`UPDATE flow_knowledge_units SET state=$4,approval=$5,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id, state, approval ? JSON.stringify(approval) : null]);
      await q.query(`INSERT INTO flow_knowledge_reviews(id,tenant_id,workspace_id,knowledge_id,version,content_hash,decision,reason,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [newVideoId("kr_"), ctx.tenant_id, ctx.workspace_id, id, old.version, old.content_hash, input.decision, reason, actor(ctx)]);
      return this.current(ctx, id, q);
    });
  }

  async publish(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.authorize(ctx, "intel.knowledge.publish", true);
    textField(input.reason, "publish_reason", 2000);
    return this.command(ctx, `knowledge.publish:${id}`, key, input, async q => {
      const old = await this.current(ctx, id, q, true); this.expected(old, input);
      if (old.state !== "approved" || old.approval?.version !== old.version || old.approval?.content_hash !== old.content_hash) fail("current_approval_required", 409);
      await this.profileReviewer(q, ctx, old, "publisher_ids");
      const unit = validateUnit(old.unit), evidence = await this.checkUnit(ctx, unit, q);
      if (!evidence.length) fail("publish_requires_source_evidence");
      if (unit.valid_until && Date.parse(unit.valid_until) <= this.e.now().getTime()) fail("knowledge_expired", 409);
      const release = newVideoId("krel_");
      await q.query(`INSERT INTO flow_knowledge_releases(id,tenant_id,workspace_id,knowledge_id,version,content_hash,snapshot,published_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [release, ctx.tenant_id, ctx.workspace_id, id, old.version, old.content_hash, JSON.stringify({ unit, evidence, method: old.method, approval: old.approval }), actor(ctx)]);
      await q.query(`UPDATE flow_knowledge_units SET state='published',release_id=$4,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id, release]);
      if (input.supersedes) {
        const prior = await this.current(ctx, input.supersedes.knowledge_id, q, true); this.expected(prior, input.supersedes);
        if (prior.id === id || prior.state !== "published" || prior.profile_id !== old.profile_id) fail("invalid_superseded_knowledge", 409);
        await q.query(`UPDATE flow_knowledge_units SET state='superseded',approval=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, prior.id]);
        await this.invalidateReleases(q, ctx, [prior.id]);
      }
      await this.e.emit(q, ctx, release, id, "knowledge.published", { knowledge_id: id, version: old.version, content_hash: old.content_hash, release_id: release });
      return this.current(ctx, id, q);
    });
  }

  async withdraw(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.authorize(ctx, "intel.knowledge.publish", true); textField(input.reason, "withdraw_reason", 2000);
    return this.command(ctx, `knowledge.withdraw:${id}`, key, input, async q => {
      const old = await this.current(ctx, id, q, true); this.expected(old, input);
      await q.query(`UPDATE flow_knowledge_units SET state='withdrawn',approval=NULL,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id]);
      await this.invalidateReleases(q, ctx, [id]);
      await this.e.emit(q, ctx, id, id, "knowledge.withdrawn", { knowledge_id: id, version: old.version, cache_invalidation_required: true });
      return this.current(ctx, id, q);
    });
  }

  async profileReviewer(q: Q, ctx: ExecutionContext, row: any, field: "reviewer_ids" | "publisher_ids") {
    const profile = (await q.query(`SELECT config FROM flow_video_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND version=$4`, [ctx.tenant_id, ctx.workspace_id, row.profile_id, row.profile_version])).rows[0];
    const designated = profile?.config?.review_policy?.[field];
    if (designated != null && (!Array.isArray(designated) || !designated.includes(ctx.actor.id))) fail("designated_reviewer_required", 403);
  }

  async get(ctx: ExecutionContext, id: string, publishedOnly = true, snapshotId?: string) {
    await this.authorize(ctx, publishedOnly ? "intel.knowledge.read" : "intel.knowledge.research");
    await assertVideoRetentionJournal(this.e, ctx);
    const row = await this.current(ctx, id);
    if (snapshotId && !(await this.snapshot(ctx, snapshotId)).release_ids.includes(row.release_id)) fail("knowledge_outside_run_snapshot", 404);
    if (publishedOnly && (row.state !== "published" || !this.validNow(row.unit))) fail("knowledge_not_published", 404);
    if (["withdrawn", "superseded"].includes(row.state)) return { id: row.id, version: row.version, state: row.state, content_hash: row.content_hash, unavailable: true };
    row.evidence = await this.resolveEvidence(ctx, evidenceRefs(row.unit.evidence));
    row.reviews = (await this.db.query(`SELECT version,content_hash,decision,reason,actor,created_at FROM flow_knowledge_reviews WHERE tenant_id=$1 AND workspace_id=$2 AND knowledge_id=$3 ORDER BY created_at,id`, [ctx.tenant_id, ctx.workspace_id, id])).rows;
    row.conflicts = (await this.db.query(`SELECT * FROM flow_knowledge_conflicts WHERE tenant_id=$1 AND workspace_id=$2 AND (left_id=$3 OR right_id=$3) ORDER BY id LIMIT 100`, [ctx.tenant_id, ctx.workspace_id, id])).rows;
    return row;
  }

  validNow(unit: any) { const now = this.e.now().getTime(); return (!unit.valid_from || Date.parse(unit.valid_from) <= now) && (!unit.valid_until || Date.parse(unit.valid_until) > now); }

  async list(ctx: ExecutionContext, input: any = {}, publishedOnly = false) {
    await this.authorize(ctx, publishedOnly ? "intel.knowledge.read" : "intel.knowledge.research");
    await assertVideoRetentionJournal(this.e, ctx);
    if (input.state && !(KNOWLEDGE_STATES as readonly string[]).includes(input.state)) fail("invalid_knowledge_state");
    const { limit, cursor } = page(input), query = typeof (input.q ?? input.query) === "string" ? (input.q ?? input.query).slice(0, 500) : "";
    const releaseIds = input.snapshot_id ? (await this.snapshot(ctx, input.snapshot_id)).release_ids : null;
    const rows = (await this.db.query(`SELECT k.*,v.unit,v.method FROM flow_knowledge_units k JOIN flow_knowledge_versions v ON v.tenant_id=k.tenant_id AND v.workspace_id=k.workspace_id AND v.knowledge_id=k.id AND v.version=k.version
      WHERE k.tenant_id=$1 AND k.workspace_id=$2 AND k.id>$3 AND ($4='' OR k.state=$4) AND ($5='' OR k.profile_id=$5)
      AND ($10::text[] IS NULL OR k.release_id=ANY($10::text[]))
      AND ($6='' OR to_tsvector('simple',v.unit->>'title'||' '||(v.unit->>'statement')) @@ plainto_tsquery('simple',$6) OR v.unit->>'statement' ILIKE '%'||$6||'%')
      AND ($7=false OR (k.state='published' AND (v.unit->>'valid_from' IS NULL OR (v.unit->>'valid_from')::timestamptz<=$8) AND (v.unit->>'valid_until' IS NULL OR (v.unit->>'valid_until')::timestamptz>$8)
        AND EXISTS(SELECT 1 FROM flow_knowledge_releases r WHERE r.tenant_id=k.tenant_id AND r.workspace_id=k.workspace_id AND r.id=k.release_id AND r.revoked_at IS NULL)))
      AND NOT EXISTS(SELECT 1 FROM flow_knowledge_evidence_refs er JOIN flow_documents d ON d.tenant_id=er.tenant_id AND d.workspace_id=er.workspace_id AND d.id=er.document_id JOIN flow_sources s ON s.tenant_id=d.tenant_id AND s.workspace_id=d.workspace_id AND s.id=d.source_id
        WHERE er.tenant_id=k.tenant_id AND er.workspace_id=k.workspace_id AND er.knowledge_id=k.id AND er.version=k.version AND (d.video_revoked_at IS NOT NULL OR d.video_text_access_expires_at<=now() OR s.status='revoked' OR (s.config->>'authorization_expires_at')::timestamptz<=now()))
      ORDER BY k.id LIMIT $9`, [ctx.tenant_id, ctx.workspace_id, cursor, publishedOnly ? "published" : input.state ?? "", input.profile_id ?? "", query, publishedOnly, this.e.now(), limit + 1, releaseIds])).rows;
    const visible = [];
    for (const row of rows.slice(0, limit)) {
      try { await this.checkUnit(ctx, validateUnit(row.unit), this.db); visible.push(row); }
      catch (error: any) { if (![404, 409, 422].includes(error.status)) throw error; }
    }
    return { items: visible, next_cursor: rows.length > limit ? rows[limit - 1].id : null, material_scope: publishedOnly ? "published_knowledge_only" : "review_candidates", fallback_used: false };
  }

  async snapshot(ctx: ExecutionContext, id: string) {
    const row = (await this.db.query(`SELECT * FROM flow_knowledge_run_snapshots WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id])).rows[0];
    if (!row) fail("knowledge_snapshot_not_found", 404);
    return row;
  }

  async pinSnapshot(ctx: ExecutionContext, input: any) {
    if (ctx.actor?.type !== "service_principal" || ctx.actor.id !== "video-skill-reader" || !ctx.scopes?.includes("intel.knowledge.read") || ctx.job_id !== input.run_id) fail("trusted_run_pin_required", 403);
    await assertVideoRetentionJournal(this.e, ctx);
    const method = validateMethod(input.method), resolver = knowledgeRuntime(this.e).resolveBase;
    if (!resolver) fail("native_skill_registry_unavailable", 503);
    const native = await resolver(ctx, method);
    if (native.id !== method.id || native.version !== method.version || native.hash !== method.hash) fail("native_method_pin_mismatch", 409);
    return this.db.tx(async q => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [JSON.stringify([ctx.tenant_id, ctx.workspace_id, input.run_id])]);
      const prior = (await q.query(`SELECT * FROM flow_knowledge_run_snapshots WHERE tenant_id=$1 AND workspace_id=$2 AND run_id=$3 AND method_id=$4`, [ctx.tenant_id, ctx.workspace_id, input.run_id, method.id])).rows[0];
      const describe = async (row: any) => ({ ...row, hash: row.content_hash, knowledge_releases: (await q.query(`SELECT id AS release_id,knowledge_id,version,content_hash FROM flow_knowledge_releases WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[]) ORDER BY id`, [ctx.tenant_id, ctx.workspace_id, row.release_ids])).rows });
      if (prior) { if (knowledgeHash(prior.method) !== knowledgeHash(method)) fail("run_method_pin_conflict", 409); return describe(prior); }
      const refs = (await q.query(`SELECT k.release_id FROM flow_knowledge_units k JOIN flow_knowledge_releases r ON r.tenant_id=k.tenant_id AND r.workspace_id=k.workspace_id AND r.id=k.release_id
        WHERE k.tenant_id=$1 AND k.workspace_id=$2 AND k.state='published' AND r.revoked_at IS NULL
        AND (r.snapshot->'unit'->>'valid_from' IS NULL OR (r.snapshot->'unit'->>'valid_from')::timestamptz<=now())
        AND (r.snapshot->'unit'->>'valid_until' IS NULL OR (r.snapshot->'unit'->>'valid_until')::timestamptz>now())
        AND NOT EXISTS(SELECT 1 FROM flow_knowledge_evidence_refs er JOIN flow_documents d ON d.tenant_id=er.tenant_id AND d.workspace_id=er.workspace_id AND d.id=er.document_id
          JOIN flow_sources s ON s.tenant_id=d.tenant_id AND s.workspace_id=d.workspace_id AND s.id=d.source_id
          WHERE er.tenant_id=k.tenant_id AND er.workspace_id=k.workspace_id AND er.knowledge_id=k.id AND er.version=k.version AND (d.video_revoked_at IS NOT NULL OR d.video_text_access_expires_at<=now() OR s.status='revoked' OR (s.config->>'authorization_expires_at')::timestamptz<=now()))
        ORDER BY k.release_id LIMIT 10001`, [ctx.tenant_id, ctx.workspace_id])).rows.map(x => x.release_id);
      if (refs.length > 10000) fail("knowledge_snapshot_limit", 413);
      const id = newVideoId("ksnap_"), hash = knowledgeHash({ method, release_ids: refs });
      return describe((await q.query(`INSERT INTO flow_knowledge_run_snapshots(id,tenant_id,workspace_id,run_id,method,release_ids,content_hash,method_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, ctx.tenant_id, ctx.workspace_id, input.run_id, JSON.stringify(method), refs, hash, method.id])).rows[0]);
    });
  }

  async research(ctx: ExecutionContext, input: any = {}) {
    await this.authorize(ctx, "intel.knowledge.research");
    await assertVideoRetentionJournal(this.e, ctx);
    const { limit, cursor } = page(input), ids = input.document_ids ?? [];
    if (!Array.isArray(ids) || ids.length > 100) fail("invalid_document_ids");
    const rows = (await this.db.query(`SELECT d.id,d.source_id,d.current_revision AS revision,d.url,r.title,r.body,r.content_hash,r.material_type,a.availability
      FROM flow_documents d JOIN flow_document_revisions r ON r.tenant_id=d.tenant_id AND r.document_id=d.id AND r.revision=d.current_revision
      JOIN flow_video_assets a ON a.tenant_id=d.tenant_id AND a.workspace_id=d.workspace_id AND a.id=d.video_asset_id
      JOIN flow_sources s ON s.tenant_id=d.tenant_id AND s.workspace_id=d.workspace_id AND s.id=d.source_id
      WHERE d.tenant_id=$1 AND d.workspace_id=$2 AND d.id>$3 AND d.video_ready AND d.video_revoked_at IS NULL AND a.revoked_at IS NULL AND s.status<>'revoked'
      AND (d.video_text_access_expires_at>now() OR d.video_text_access_expires_at IS NULL AND NOT EXISTS(SELECT 1 FROM flow_video_jobs pj WHERE pj.tenant_id=d.tenant_id AND pj.workspace_id=d.workspace_id AND pj.document_id=d.id)) AND (r.video_text_access_expires_at IS NULL OR r.video_text_access_expires_at>now())
      AND s.config->'allowed_uses' ? 'knowledge'
      AND (s.config->>'authorization_expires_at' IS NULL OR (s.config->>'authorization_expires_at')::timestamptz>now())
      AND (cardinality($4::text[])=0 OR d.id=ANY($4::text[])) AND ($5='' OR r.title ILIKE '%'||$5||'%' OR r.body ILIKE '%'||$5||'%')
      AND NOT EXISTS(SELECT 1 FROM flow_video_deletion_tombstones t WHERE t.tenant_id=d.tenant_id AND t.workspace_id=d.workspace_id AND t.document_id=d.id)
      ORDER BY d.id LIMIT $6`, [ctx.tenant_id, ctx.workspace_id, cursor, ids, String(input.q ?? input.query ?? "").slice(0, 500), limit + 1])).rows;
    const paged = resultPage(rows, limit);
    // List previews are explicitly bounded. Full fixed-revision content remains on host read/evidence APIs.
    paged.items = paged.items.map(x => ({ ...x, body: x.body.slice(0, 4000), body_utf16_length: x.body.length, truncated: x.body.length > 4000, review_status: "unreviewed_material", claim_kind: "source_statement" }));
    return { ...paged, material_scope: "ready_research_material", reviewed: false };
  }

  async batchReview(ctx: ExecutionContext, input: any) {
    if (!Array.isArray(input.items) || input.items.length > 50) fail("invalid_review_batch");
    const results = [];
    for (const item of input.items) {
      try { results.push({ id: item.id, ok: true, data: await this.review(ctx, item.id, item.idempotency_key, item) }); }
      catch (e: any) { results.push({ id: item.id, ok: false, reason: e.reason ?? "review_failed", status: e.status ?? 500 }); }
    }
    return { results };
  }

  async retention(ctx: ExecutionContext, key: string, input: any) {
    await this.authorize(ctx, "intel.sources.write", true);
    const actions = ["subscription_paused", "media_expired", "remote_unavailable", "revoked", "erased"];
    if (!actions.includes(input.action) || Boolean(input.source_id) === Boolean(input.asset_id)) fail("invalid_retention_action");
    textField(input.reason, "retention_reason", 2000);
    if (["revoked", "erased"].includes(input.action)) await assertVideoRetentionJournal(this.e, ctx);
    return this.command(ctx, "video.retention", key, input, async q => {
      if (["revoked", "erased"].includes(input.action)) await lockVideoRetentionTransaction(q);
      if (input.expected_impact_hash !== undefined) await assertRetentionImpact(q, { tenant_id: ctx.tenant_id, workspace_id: ctx.workspace_id }, input, this.e.now());
      let record: VideoRetentionRecord | undefined;
      const result = await this.applyRetention(q, ctx, input, async () => {
        if (!["revoked", "erased"].includes(input.action)) return;
        record = await appendVideoRetentionIntent(this.e, { version: 1, event_id: `vjr_${knowledgeHash({ tenant_id: ctx.tenant_id, workspace_id: ctx.workspace_id, namespace: "video.retention", key })}`,
          tenant_id: ctx.tenant_id, workspace_id: ctx.workspace_id, action: input.action, ...(input.source_id ? { source_id: input.source_id } : { asset_id: input.asset_id }),
          request_hash: knowledgeHash(input), actor_hash: sha(actor(ctx)), requested_at: this.e.now().toISOString() });
      });
      if (record) await markVideoRetentionApplied(q, record);
      return result;
    });
  }

  /** Host-only restoration of derived caches; never exposes evidence text or caller-supplied target sets. */
  async projectionFeed(ctx: ExecutionContext, input: any = {}) {
    requireScope(ctx, "intel.video.read");
    if (ctx.actor?.type !== "service_principal" || ctx.actor.id !== "video-projection-reader" || !ctx.tenant_id || !ctx.workspace_id) fail("trusted_projection_reader_required", 403);
    const { expireVideoObjects } = await import("./video-retention-policy.ts");
    if ((await expireVideoObjects(this.e, 100, ctx)).backlog) fail("retention_expiry_backlog", 503);
    const number = (value: any, fallback: number) => {
      if (value === undefined || value === "") return fallback;
      const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) fail("invalid_projection_cursor"); return n;
    };
    const cursor = number(input.cursor, 0), limit = Math.min(100, Math.max(1, number(input.limit, 100)));
    const head = await videoRetentionCheckpoint(this.e, ctx);
    const ceiling = async () => Number((await this.db.query(`SELECT coalesce(max(sequence),0) AS sequence FROM flow_outbox WHERE tenant_id=$1 AND workspace_id=$2 AND type='knowledge.dependencies_revoked'`, [ctx.tenant_id, ctx.workspace_id])).rows[0].sequence);
    const projection = await ceiling();
    if (!Number.isSafeInteger(projection) || cursor > projection) fail("projection_history_rollback", 409);
    const expected = input.journal_id !== undefined || input.genesis_hash !== undefined || input.head_sequence !== undefined || input.head_hash !== undefined || input.projection_sequence !== undefined;
    if (expected && (input.journal_id !== head.journal_id || input.genesis_hash !== head.genesis_hash || number(input.head_sequence, -1) !== head.head_sequence || input.head_hash !== head.head_hash || number(input.projection_sequence, -1) !== projection)) fail("projection_checkpoint_changed", 409);
    const rows = (await this.db.query(`SELECT event_id,sequence,tenant_id,workspace_id,operation_id,job_id,type,payload,occurred_at FROM flow_outbox
      WHERE tenant_id=$1 AND workspace_id=$2 AND type='knowledge.dependencies_revoked' AND sequence>$3 AND sequence<=$4 ORDER BY sequence LIMIT $5`, [ctx.tenant_id, ctx.workspace_id, cursor, projection, limit + 1])).rows;
    const fields = ["document_ids", "video_job_ids", "extraction_run_ids", "evidence_ids", "knowledge_ids", "skill_candidate_ids", "report_ids", "research_run_ids"];
    const candidates = rows.slice(0, limit).map(row => {
      if (!["revoked", "erased"].includes(row.payload.action)) fail("projection_tombstone_invalid", 503);
      const payload: any = { action: row.payload.action, cache_invalidation_required: true };
      for (const field of fields) {
        const ids = row.payload[field] ?? [];
        if (!Array.isArray(ids) || ids.length > 200 || ids.some(x => typeof x !== "string" || x.length > 200)) fail("projection_tombstone_invalid", 503);
        payload[field] = ids;
      }
      return { ...row, sequence: Number(row.sequence), occurred_at: new Date(row.occurred_at).toISOString(), payload_version: 1, trace_id: row.event_id, payload };
    });
    const items: typeof candidates = []; let bytes = 0;
    for (const item of candidates) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (size > 524288) fail("projection_tombstone_too_large", 503);
      if (items.length && bytes + size > 524288) break;
      items.push(item); bytes += size;
    }
    const after = await videoRetentionCheckpoint(this.e, ctx);
    if (knowledgeHash(head) !== knowledgeHash(after) || await ceiling() !== projection) fail("projection_checkpoint_changed", 409);
    return { ...head, projection_sequence: projection, items, next_cursor: rows.length > items.length ? items[items.length - 1].sequence : null };
  }

  /** Internal transaction primitive: callers must authorize, or verify an external journal. */
  async applyRetention(q: Q, ctx: Scope, input: any, beforeMutation: () => Promise<void>, allowMissing = false) {
      const sources = input.source_id ? (await q.query(`SELECT id FROM flow_sources WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [ctx.tenant_id, ctx.workspace_id, input.source_id])).rows : [];
      if (input.source_id && !sources.length && !allowMissing) fail("source_not_found", 404);
      if (input.action === "subscription_paused") {
        if (!input.source_id) fail("source_id_required");
        await q.query(`UPDATE flow_sources SET status='paused' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status<>'revoked'`, [ctx.tenant_id, ctx.workspace_id, input.source_id]);
        return { action: input.action, knowledge_revoked: false };
      }
      const assets = (await q.query(`SELECT id FROM flow_video_assets a WHERE tenant_id=$1 AND workspace_id=$2 AND ($3::text IS NULL OR id=$3)
        AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM flow_video_asset_sources s WHERE s.tenant_id=a.tenant_id AND s.workspace_id=a.workspace_id AND s.asset_id=a.id AND s.source_id=$4)) FOR UPDATE`, [ctx.tenant_id, ctx.workspace_id, input.asset_id ?? null, input.source_id ?? null])).rows.map(x => x.id);
      if (!assets.length) {
        if ((input.source_id || allowMissing) && ["revoked", "erased"].includes(input.action)) {
          await beforeMutation();
          if (input.source_id) await q.query(`UPDATE flow_sources SET status='revoked' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, input.source_id]);
          return { action: input.action, asset_ids: [], knowledge_ids: [], skill_candidate_ids: [], knowledge_revoked: true, physical_cleanup: "not_required" };
        }
        fail("asset_not_found", 404);
      }
      await beforeMutation();
      if (input.source_id && ["revoked", "erased"].includes(input.action)) await q.query(`UPDATE flow_sources SET status='revoked' WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, input.source_id]);
      if (["media_expired", "remote_unavailable"].includes(input.action)) {
        await q.query(`UPDATE flow_video_assets SET availability=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, assets, input.action]);
        if (input.action === "media_expired") await q.query(`UPDATE flow_video_objects SET access_expires_at=LEAST(access_expires_at,now()) WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id IN
          (SELECT id FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND asset_id=ANY($3::text[])) AND content_type ~ '^(video|audio|image)/' AND state<>'deleted'`, [ctx.tenant_id, ctx.workspace_id, assets]);
        return { action: input.action, asset_ids: assets, knowledge_revoked: false };
      }
      await q.query(`UPDATE flow_video_assets SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, assets]);
      const jobs = (await q.query(`UPDATE flow_video_jobs SET state='cancelled',error='{"reason":"source_access_revoked"}',updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND asset_id=ANY($3::text[]) RETURNING id`, [ctx.tenant_id, ctx.workspace_id, assets])).rows.map(x => x.id);
      await q.query(`UPDATE flow_video_stages SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, jobs]);
      await q.query(`UPDATE flow_video_objects SET state='delete_pending' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[]) AND state<>'deleted'`, [ctx.tenant_id, ctx.workspace_id, jobs]);
      await q.query(`UPDATE flow_video_knowledge_runs SET state='cancelled',fencing_token=fencing_token+1,lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, jobs]);
      await q.query(`UPDATE flow_video_embedding_staging SET state='cancelled' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, jobs]);
      const docs = (await q.query(`SELECT id FROM flow_documents WHERE tenant_id=$1 AND workspace_id=$2 AND video_asset_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, assets])).rows.map(x => x.id);
      const affected = await revokeVideoDependencies(q, ctx, docs, input.action, input.action === "erased");
      // Pre-ready jobs have no document ID yet, but their host model payloads must
      // also be revoked/erased. The document dependency event alone cannot find them.
      for (let offset = 0; offset < jobs.length; offset += 200) await this.e.emit(q, ctx, jobs[offset], jobs[offset], "knowledge.dependencies_revoked", {
        video_job_ids: jobs.slice(offset, offset + 200), document_ids: [], extraction_run_ids: [], evidence_ids: [], knowledge_ids: [], skill_candidate_ids: [], report_ids: [], research_run_ids: [], action: input.action, cache_invalidation_required: true,
      });
      if (input.action === "erased") {
        await q.query(`UPDATE flow_video_assets SET title='',metadata='{}' WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, assets]);
        await q.query(`UPDATE flow_video_jobs SET input='{}',text_retention_erased_at=coalesce(text_retention_erased_at,now()) WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, jobs]);
        await q.query(`UPDATE flow_video_manifests SET manifest='{}' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, jobs]);
        await q.query(`UPDATE flow_video_embedding_staging SET payload='{}' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, jobs]);
        await q.query(`UPDATE flow_video_embedding_batches SET request='{}',vectors=NULL,state='cancelled' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, jobs]);
        await q.query(`UPDATE flow_video_knowledge_runs SET frozen_input='{}',model_request=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, jobs]);
        const native = (await q.query(`SELECT native_id FROM flow_video_assets WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, assets])).rows.map(x => x.native_id);
        const pages = (await q.query(`SELECT source_id,page_key,payload FROM flow_video_discovery_pages WHERE tenant_id=$1 AND workspace_id=$2`, [ctx.tenant_id, ctx.workspace_id])).rows;
        const scrub = (v: any): any => Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? native.includes(v.native_id) ? { native_id: v.native_id, erased: true } : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;
        for (const p of pages) await q.query(`UPDATE flow_video_discovery_pages SET payload=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3 AND page_key=$4`, [ctx.tenant_id, ctx.workspace_id, p.source_id, p.page_key, JSON.stringify(scrub(p.payload))]);
      }
      return { action: input.action, asset_ids: assets, ...affected, knowledge_revoked: true, physical_cleanup: "pending" };
  }

  async origins(ctx: ExecutionContext, key: string, input: any) {
    await this.authorize(ctx, "intel.knowledge.review", true);
    return this.command(ctx, "knowledge.origins", key, input, q => this.applyOrigins(q, ctx, input));
  }

  async applyOrigins(q: Q, ctx: ExecutionContext, input: any) {
    if (!Array.isArray(input.assets) || !input.assets.length || input.assets.length > 100) fail("invalid_origin_assets");
    const cluster = textField(input.origin_cluster, "origin_cluster", 200); textField(input.reason, "origin_reason", 2000);
      for (const item of input.assets) {
        const asset = (await q.query(`SELECT id,origin_cluster FROM flow_video_assets WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND revoked_at IS NULL FOR UPDATE`, [ctx.tenant_id, ctx.workspace_id, item.asset_id])).rows[0];
        if (!asset) fail("asset_not_found", 404);
        if ((asset.origin_cluster ?? null) !== item.expected_origin_cluster) fail("origin_version_conflict", 409);
        await q.query(`UPDATE flow_video_assets SET origin_cluster=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, asset.id, cluster]);
      }
      const changed = (await q.query(`SELECT DISTINCT k.id FROM flow_knowledge_units k JOIN flow_knowledge_evidence_refs er ON er.tenant_id=k.tenant_id AND er.workspace_id=k.workspace_id AND er.knowledge_id=k.id AND er.version=k.version
        JOIN flow_documents d ON d.tenant_id=er.tenant_id AND d.workspace_id=er.workspace_id AND d.id=er.document_id
        WHERE k.tenant_id=$1 AND k.workspace_id=$2 AND d.video_asset_id=ANY($3::text[])`, [ctx.tenant_id, ctx.workspace_id, input.assets.map((a: any) => a.asset_id)])).rows;
      const invalidated = [];
      for (const { id } of changed) {
        const current = await this.current(ctx, id, q, true);
        if (current.unit.claim_kind !== "cross_source_verified" || ["withdrawn", "rejected", "superseded"].includes(current.state)) continue;
        const ev = await this.resolveEvidence(ctx, evidenceRefs(current.unit.evidence), q);
        if (new Set(ev.map(x => x.origin_cluster || x.media_sha256 || x.asset_id)).size < 2) {
          await q.query(`UPDATE flow_knowledge_units SET state='in_review',approval=NULL,release_id=NULL WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [ctx.tenant_id, ctx.workspace_id, id]);
          await this.invalidateReleases(q, ctx, [id]); invalidated.push(id);
        }
      }
      await this.e.emit(q, ctx, cluster, cluster, "knowledge.origin_relationship_changed", { origin_cluster: cluster, asset_ids: input.assets.map((a: any) => a.asset_id), invalidated_knowledge_ids: invalidated, actor: actor(ctx) });
      return { origin_cluster: cluster, invalidated_knowledge_ids: invalidated };
  }
}

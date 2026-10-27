import type { Engine } from "./engine.ts";
import type { Q } from "./db.ts";
import type { ExecutionContext } from "./auth.ts";
import { canonicalHash, sha } from "./video-contract.ts";
import { VideoKnowledgeService, page } from "./video-knowledge.ts";
import { fail, textField } from "./video-knowledge-contract.ts";
import { assertVideoRetentionJournal } from "./video-journal.ts";

type Scope = { tenant_id: string; workspace_id: string };
export const VIDEO_ORIGIN_BASELINE = Object.freeze({ algorithm: "unicode_5gram_bottom128_v1", threshold: 0.82, calibration: "suggested_uncalibrated_baseline", max_characters: 300000, max_matches: 500 });

/** Candidate retrieval sketch, not proof of common authorship or independent corroboration. */
export function videoOriginFingerprint(body: string) {
  const text = body.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const chars = Array.from(text);
  if (chars.length > VIDEO_ORIGIN_BASELINE.max_characters) fail("origin_fingerprint_input_limit", 413);
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 4; i++) {
    let hash = 2166136261;
    const gram = chars.slice(i, i + 5).join("");
    for (let j = 0; j < gram.length; j++) hash = Math.imul(hash ^ gram.charCodeAt(j), 16777619) >>> 0;
    grams.add(hash.toString(16).padStart(8, "0"));
  }
  return { algorithm: VIDEO_ORIGIN_BASELINE.algorithm, normalized_hash: sha(text), signature: [...grams].sort().slice(0, 128), characters: chars.length };
}
export function videoOriginSimilarity(a: { normalized_hash: string; signature: string[] }, b: { normalized_hash: string; signature: string[] }) {
  if (a.normalized_hash === b.normalized_hash) return 1;
  const union = [...new Set([...a.signature, ...b.signature])].sort().slice(0, 128), left = new Set(a.signature), right = new Set(b.signature);
  return union.length ? union.filter(x => left.has(x) && right.has(x)).length / union.length : 0;
}

export async function enqueueVideoOriginCheck(q: Q, scope: Scope, ready: { document_id: string; revision: number; grant_actor: string }) {
  await q.query(`INSERT INTO flow_video_origin_checks(tenant_id,workspace_id,document_id,revision,grant_actor) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [scope.tenant_id, scope.workspace_id, ready.document_id, ready.revision, ready.grant_actor]);
}

export class VideoOriginCandidates {
  k: VideoKnowledgeService;
  constructor(engine: Engine) { this.k = new VideoKnowledgeService(engine); }
  private async material(q: Q, scope: Scope, document: string, revision: number) {
    const row = (await q.query(`SELECT d.id AS document_id,d.video_asset_id AS asset_id,r.revision,r.content_hash AS revision_hash,r.body,a.origin_cluster
      FROM flow_documents d JOIN flow_document_revisions r ON r.tenant_id=d.tenant_id AND r.document_id=d.id AND r.revision=$4
      JOIN flow_sources s ON s.tenant_id=d.tenant_id AND s.workspace_id=d.workspace_id AND s.id=d.source_id
      JOIN flow_video_assets a ON a.tenant_id=d.tenant_id AND a.workspace_id=d.workspace_id AND a.id=d.video_asset_id
      WHERE d.tenant_id=$1 AND d.workspace_id=$2 AND d.id=$3 AND d.video_ready AND d.video_revoked_at IS NULL AND a.revoked_at IS NULL
      AND (d.video_text_access_expires_at>now() OR d.video_text_access_expires_at IS NULL AND NOT EXISTS(SELECT 1 FROM flow_video_jobs pj WHERE pj.tenant_id=d.tenant_id AND pj.workspace_id=d.workspace_id AND pj.document_id=d.id)) AND (r.video_text_access_expires_at IS NULL OR r.video_text_access_expires_at>now())
      AND s.status<>'revoked' AND s.config->'allowed_uses' ? 'knowledge' AND (s.config->>'authorization_expires_at' IS NULL OR (s.config->>'authorization_expires_at')::timestamptz>now()) FOR SHARE OF d,r,s,a`, [scope.tenant_id, scope.workspace_id, document, revision])).rows[0];
    if (!row) fail("origin_material_unavailable", 409); return row;
  }
  async workOnce(owner: string) {
    if (!this.k.e.video.enabled) return false;
    const job = await this.k.db.tx(async q => {
      const row = (await q.query(`SELECT * FROM flow_video_origin_checks WHERE state IN ('queued','running') AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY created_at,document_id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!row) return null;
      return (await q.query(`UPDATE flow_video_origin_checks SET state='running',lease_owner=$5,lease_expires_at=now()+interval '60 seconds',fencing_token=fencing_token+1 WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4 RETURNING *`, [row.tenant_id, row.workspace_id, row.document_id, row.revision, owner])).rows[0];
    });
    if (!job) return false;
    const p = [job.tenant_id, job.workspace_id, job.document_id, job.revision];
    try {
      await assertVideoRetentionJournal(this.k.e, job);
      if (this.k.e.authorize && !await this.k.e.authorize(job, "intel.knowledge.research")) fail("origin_grant_revoked", 403);
      const material = await this.material(this.k.db, job, job.document_id, job.revision), fingerprint = videoOriginFingerprint(material.body);
      await this.k.db.tx(async q => {
        const live = (await q.query(`SELECT 1 FROM flow_video_origin_checks WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4 AND lease_owner=$5 AND fencing_token=$6 AND lease_expires_at>now() AND state='running' FOR UPDATE`, [...p, owner, job.fencing_token])).rows[0];
        if (!live) fail("stale_origin_lease", 409);
        const current = await this.material(q, job, job.document_id, job.revision);
        if (current.revision_hash !== material.revision_hash) fail("origin_revision_changed", 409);
        await q.query(`INSERT INTO flow_video_origin_fingerprints(tenant_id,workspace_id,document_id,revision,asset_id,algorithm,revision_hash,normalized_hash,signature,characters)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, [...p, current.asset_id, fingerprint.algorithm, current.revision_hash, fingerprint.normalized_hash, fingerprint.signature, fingerprint.characters]);
        const matches = (await q.query(`SELECT f.*,a.origin_cluster FROM flow_video_origin_fingerprints f JOIN flow_video_assets a ON a.tenant_id=f.tenant_id AND a.workspace_id=f.workspace_id AND a.id=f.asset_id
          WHERE f.tenant_id=$1 AND f.workspace_id=$2 AND f.asset_id<>$3 AND f.algorithm=$4 AND a.revoked_at IS NULL AND f.characters>=40
          AND (f.signature && $5::text[] OR f.normalized_hash=$6) ORDER BY f.created_at DESC,f.document_id LIMIT 501`, [job.tenant_id, job.workspace_id, current.asset_id, fingerprint.algorithm, fingerprint.signature, fingerprint.normalized_hash])).rows;
        if (fingerprint.characters >= 40) for (const other of matches.slice(0, VIDEO_ORIGIN_BASELINE.max_matches)) {
          const score = videoOriginSimilarity(fingerprint, other);
          if (score < VIDEO_ORIGIN_BASELINE.threshold) continue;
          try { await this.material(q, job, other.document_id, other.revision); } catch (error: any) { if (error.reason === "origin_material_unavailable") continue; throw error; }
          const ref = (x: any) => ({ document_id: x.document_id, revision: x.revision, asset_id: x.asset_id, revision_hash: x.revision_hash, origin_cluster: x.origin_cluster ?? null });
          const pair = [ref(current), ref(other)].sort((a, b) => `${a.document_id}:${a.revision}`.localeCompare(`${b.document_id}:${b.revision}`));
          const proposal = { left: pair[0], right: pair[1], score, baseline: VIDEO_ORIGIN_BASELINE, evidence_kind: fingerprint.normalized_hash === other.normalized_hash ? "normalized_text_match" : "near_duplicate_text", requires_human_review: true };
          const id = `voc_${canonicalHash({ tenant_id: job.tenant_id, workspace_id: job.workspace_id, pair: pair.map(x => [x.document_id, x.revision]), algorithm: fingerprint.algorithm }).slice(0, 40)}`;
          await q.query(`INSERT INTO flow_video_origin_candidates(id,tenant_id,workspace_id,left_asset_id,right_asset_id,content_hash,proposal) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [id, job.tenant_id, job.workspace_id, pair[0].asset_id, pair[1].asset_id, canonicalHash(proposal), JSON.stringify(proposal)]);
        }
        await q.query(`UPDATE flow_video_origin_checks SET state=$5,error=$6,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4`, [...p, matches.length > VIDEO_ORIGIN_BASELINE.max_matches ? "completed_with_gaps" : "completed", matches.length > VIDEO_ORIGIN_BASELINE.max_matches ? "candidate_scan_limit" : fingerprint.characters < 40 ? "insufficient_text_for_similarity" : null]);
      });
    } catch (error: any) {
      await this.k.db.query(`UPDATE flow_video_origin_checks SET state='failed',error=$7,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4 AND lease_owner=$5 AND fencing_token=$6`, [...p, owner, job.fencing_token, String(error.reason ?? "origin_scan_failed").slice(0, 150)]);
    }
    return true;
  }
  async list(ctx: ExecutionContext, input: any = {}) {
    await this.k.authorize(ctx, "intel.knowledge.research"); await assertVideoRetentionJournal(this.k.e, ctx);
    const { limit, cursor } = page(input), items = [];
    const rows = (await this.k.db.query(`SELECT * FROM flow_video_origin_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND id>$3 AND ($4='' OR state=$4) ORDER BY id LIMIT $5`, [ctx.tenant_id, ctx.workspace_id, cursor, input.state ?? "", limit + 1])).rows;
    for (const row of rows.slice(0, limit)) {
      if (row.state === "unavailable") { items.push({ id: row.id, state: row.state, content_hash: row.content_hash, unavailable: true }); continue; }
      try { await this.material(this.k.db, ctx, row.proposal.left.document_id, row.proposal.left.revision); await this.material(this.k.db, ctx, row.proposal.right.document_id, row.proposal.right.revision); items.push(row); }
      catch (error: any) { if (error.reason !== "origin_material_unavailable") throw error; }
    }
    return { items, next_cursor: rows.length > limit ? rows[limit - 1].id : null, baseline: VIDEO_ORIGIN_BASELINE };
  }
  async review(ctx: ExecutionContext, id: string, key: string, input: any) {
    await this.k.authorize(ctx, "intel.knowledge.review", true); await assertVideoRetentionJournal(this.k.e, ctx);
    if (!["same_origin", "independent"].includes(input.decision)) fail("invalid_origin_decision");
    const reason = textField(input.reason, "origin_review_reason", 2000);
    return this.k.command(ctx, `origin_candidate.review:${id}`, key, input, async q => {
      const row = (await q.query(`SELECT * FROM flow_video_origin_candidates WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`, [ctx.tenant_id, ctx.workspace_id, id])).rows[0];
      if (!row || row.state !== "pending" || row.content_hash !== input.expected_hash) fail("origin_candidate_conflict", 409);
      const pair = [row.proposal.left, row.proposal.right];
      for (const ref of pair) {
        const current = await this.material(q, ctx, ref.document_id, ref.revision);
        if (current.revision_hash !== ref.revision_hash || (current.origin_cluster ?? null) !== ref.origin_cluster) fail("origin_candidate_stale", 409);
      }
      if (input.decision === "same_origin") await this.k.applyOrigins(q, ctx, { assets: pair.map(x => ({ asset_id: x.asset_id, expected_origin_cluster: x.origin_cluster })), origin_cluster: textField(input.origin_cluster, "origin_cluster", 200), reason });
      else if (pair[0].origin_cluster && pair[0].origin_cluster === pair[1].origin_cluster) fail("explicit_origin_split_required", 409);
      const review = { actor: `${ctx.actor.type}:${ctx.actor.id}`, reason, decision: input.decision, reviewed_at: this.k.e.now().toISOString() };
      return (await q.query(`UPDATE flow_video_origin_candidates SET state=$4,review=$5,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 RETURNING *`, [ctx.tenant_id, ctx.workspace_id, id, input.decision, JSON.stringify(review)])).rows[0];
    });
  }
}

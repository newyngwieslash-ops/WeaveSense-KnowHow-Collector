import type { Engine } from "./engine.ts";
import type { Q } from "./db.ts";
import { canonicalHash, sha, videoError } from "./video-contract.ts";
import { applyVideoRetention } from "./video-knowledge.ts";
import { assertVideoRetentionJournal, appendVideoRetentionIntent, markVideoRetentionApplied, lockVideoRetentionTransaction } from "./video-journal.ts";

const DAY = 86400;
const classes = ["media", "audio", "frame", "transcript", "evidence"] as const;
type Category = typeof classes[number];
type Duration = { access_seconds: number; maximum_seconds: number };
export type VideoRetentionPolicyConfig = Record<Category, Duration> & { version: 1; effective_text_access_seconds: number; effective_text_maximum_seconds: number };
/** Bounded engineering defaults, not a legal/compliance recommendation. Profiles expose these exact values. */
export function normalizeVideoRetentionConfig(config: any): VideoRetentionPolicyConfig {
  const supplied = config.retention_policy;
  const raw = supplied ?? { version: 1, media: { access_seconds: DAY, maximum_seconds: 30 * DAY }, audio: { access_seconds: DAY, maximum_seconds: 30 * DAY },
    frame: { access_seconds: 7 * DAY, maximum_seconds: 30 * DAY }, transcript: { access_seconds: 30 * DAY, maximum_seconds: 30 * DAY }, evidence: { access_seconds: 30 * DAY, maximum_seconds: 30 * DAY } };
  if (!raw || raw.version !== 1 || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["version", ...classes, "effective_text_access_seconds", "effective_text_maximum_seconds"].includes(k))) throw videoError(400, "INVALID_RETENTION_POLICY");
  const normalized: any = { version: 1 };
  for (const kind of classes) {
    const value = raw[kind];
    if (!value || Object.keys(value).sort().join(",") !== "access_seconds,maximum_seconds" || !Number.isSafeInteger(value.access_seconds) || !Number.isSafeInteger(value.maximum_seconds)
      || value.access_seconds < 60 || value.maximum_seconds < value.access_seconds || value.maximum_seconds > 315360000) throw videoError(400, "INVALID_RETENTION_DURATION");
    normalized[kind] = { access_seconds: value.access_seconds, maximum_seconds: value.maximum_seconds };
  }
  normalized.effective_text_access_seconds = Math.min(normalized.transcript.access_seconds, normalized.evidence.access_seconds);
  normalized.effective_text_maximum_seconds = Math.min(normalized.transcript.maximum_seconds, normalized.evidence.maximum_seconds);
  // A fixed source proof cannot be promised longer than the original asset's hard
  // limit. Reject an impossible policy instead of silently deleting a pinned asset.
  for (const kind of ["media", "audio", "frame"] as const) if (normalized[kind].maximum_seconds < normalized.effective_text_maximum_seconds) throw videoError(400, "RETENTION_DEPENDENCY_CONFLICT");
  config.retention_policy = normalized;
  return normalized;
}
export const validateVideoRetentionPolicy = normalizeVideoRetentionConfig;

function category(object: any): Category {
  const type = String(object.content_type ?? "").toLowerCase();
  const declared = ({ original_media: "media", grid: "frame", derived: "evidence", visual_metadata: "evidence", derived_summary: "evidence", metadata: "evidence" } as Record<string, string>)[object.retention_class ?? object.artifact_type] ?? object.retention_class ?? object.artifact_type;
  const implied = type.startsWith("video/") ? "media" : type.startsWith("audio/") ? "audio" : type.startsWith("image/") ? "frame" : type.startsWith("text/") || type.includes("json") ? "transcript" : null;
  const chosen = declared ?? implied;
  if (!(classes as readonly string[]).includes(chosen) || (implied && implied !== chosen && !(implied === "transcript" && chosen === "evidence"))) throw videoError(422, "INVALID_RETENTION_ARTIFACT_TYPE");
  return chosen as Category;
}
const scope = (job: any) => [job.tenant_id, job.workspace_id, job.id];
const deadline = (anchor: Date, seconds: number) => new Date(anchor.getTime() + seconds * 1000).toISOString();

/** Call after authoritative object inventory insertion; retry/late arrival never renews retention. */
export async function registerVideoObjectRetention(q: Q, job: any, objects: any[], now: Date) {
  const current = (await q.query(`SELECT j.*,p.config FROM flow_video_jobs j JOIN flow_video_profiles p ON p.tenant_id=j.tenant_id AND p.workspace_id=j.workspace_id AND p.id=j.profile_id AND p.version=j.profile_version
    WHERE j.tenant_id=$1 AND j.workspace_id=$2 AND j.id=$3 FOR UPDATE OF j`, scope(job))).rows[0];
  if (!current) throw videoError(404, "VIDEO_JOB_NOT_FOUND");
  const policy = normalizeVideoRetentionConfig(structuredClone(current.config)), hash = canonicalHash(policy);
  if (current.retention_policy_hash && current.retention_policy_hash !== hash) throw videoError(409, "FROZEN_RETENTION_POLICY_CHANGED");
  const anchor = new Date(current.retention_anchor_at ?? current.created_at ?? now);
  if (!Number.isFinite(anchor.getTime())) throw videoError(422, "INVALID_RETENTION_ANCHOR");
  await q.query(`UPDATE flow_video_jobs SET retention_policy=$4,retention_policy_hash=$5,retention_anchor_at=$6,text_access_expires_at=$7,text_max_expires_at=$8 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [...scope(job), JSON.stringify(policy), hash, anchor.toISOString(), deadline(anchor, policy.effective_text_access_seconds), deadline(anchor, policy.effective_text_maximum_seconds)]);
  // Backfill an older ready row through the same frozen policy. Do not await a
  // future import to put a deadline on already-readable historical text.
  if (current.document_id) {
    const params = [job.tenant_id, job.workspace_id, current.document_id, deadline(anchor, policy.effective_text_access_seconds), deadline(anchor, policy.effective_text_maximum_seconds)];
    await q.query(`UPDATE flow_documents SET video_text_access_expires_at=LEAST(video_text_access_expires_at,$4::timestamptz),video_text_max_expires_at=LEAST(video_text_max_expires_at,$5::timestamptz) WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, params);
    await q.query(`UPDATE flow_document_revisions r SET video_text_access_expires_at=LEAST(r.video_text_access_expires_at,$4::timestamptz),video_text_max_expires_at=LEAST(r.video_text_max_expires_at,$5::timestamptz) FROM flow_documents d WHERE d.tenant_id=$1 AND d.workspace_id=$2 AND d.id=$3 AND r.tenant_id=d.tenant_id AND r.document_id=d.id`, params);
    await q.query(`UPDATE flow_evidence SET video_expires_at=LEAST(video_expires_at,$4::timestamptz) WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3`, params.slice(0, 4));
  }
  for (const object of objects) {
    const kind = category(object), value = policy[kind];
    const rows = await q.query(`UPDATE flow_video_objects SET retention_class=$5,access_expires_at=LEAST(access_expires_at,$6::timestamptz),max_expires_at=LEAST(max_expires_at,$7::timestamptz),retention_policy_hash=$8
      WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND object_key=$4 AND sha256=$9 RETURNING object_key`, [...scope(job), object.object_key, kind, deadline(anchor, value.access_seconds), deadline(anchor, value.maximum_seconds), hash, object.sha256]);
    if (!rows.rows.length) throw videoError(409, "RETENTION_OBJECT_NOT_REGISTERED");
  }
  return { policy, hash, anchor, access_expires_at: deadline(anchor, policy.effective_text_access_seconds), max_expires_at: deadline(anchor, policy.effective_text_maximum_seconds) };
}
export const registerVideoRetention = registerVideoObjectRetention;

export async function stampVideoTextRetention(q: Q, job: any, documentId: string, revision: number, now: Date) {
  const frozen = await registerVideoObjectRetention(q, job, [], now);
  if (new Date(frozen.access_expires_at) <= now) throw videoError(409, "MATERIAL_RETENTION_EXPIRED");
  await q.query(`UPDATE flow_documents SET video_text_access_expires_at=LEAST(video_text_access_expires_at,$4::timestamptz),video_text_max_expires_at=LEAST(video_text_max_expires_at,$5::timestamptz) WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [job.tenant_id, job.workspace_id, documentId, frozen.access_expires_at, frozen.max_expires_at]);
  await q.query(`UPDATE flow_document_revisions SET video_text_access_expires_at=$4,video_text_max_expires_at=$5 WHERE tenant_id=$1 AND document_id=$2 AND revision=$3`, [job.tenant_id, documentId, revision, frozen.access_expires_at, frozen.max_expires_at]);
  await q.query(`UPDATE flow_evidence SET video_expires_at=LEAST(video_expires_at,$5::timestamptz) WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4`, [job.tenant_id, job.workspace_id, documentId, revision, frozen.access_expires_at]);
}

/** Policy authority marks work; the existing provider cleanup path owns physical receipts. */
export async function expireVideoObjects(engine: Engine, limit = 20, onlyScope?: { tenant_id: string; workspace_id: string }) {
  await assertVideoRetentionJournal(engine, onlyScope);
  const now = engine.now(), n = Math.max(1, Math.min(100, limit));
  const filter = onlyScope ? [onlyScope.tenant_id, onlyScope.workspace_id] : [null, null];
  // Expired authorization must reach host caches too, not only direct material
  // reads. Recheck the current grant under lock before persisting a revocation.
  const sources = (await engine.db.query(`SELECT tenant_id,workspace_id,id FROM flow_sources WHERE kind IN ('bilibili','douyin') AND status<>'revoked' AND (config->>'authorization_expires_at')::timestamptz<=$1 AND ($3::text IS NULL OR tenant_id=$3 AND workspace_id=$4) ORDER BY id LIMIT $2`, [now.toISOString(), n, ...filter])).rows;
  for (const source of sources) await engine.db.tx(async q => {
    await lockVideoRetentionTransaction(q);
    const current = (await q.query(`SELECT config->>'authorization_expires_at' AS expiry FROM flow_sources WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status<>'revoked' AND (config->>'authorization_expires_at')::timestamptz<=$4 FOR UPDATE`, [source.tenant_id, source.workspace_id, source.id, now.toISOString()])).rows[0];
    if (!current) return;
    const expiry = new Date(current.expiry).toISOString(), semantics = { tenant_id: source.tenant_id, workspace_id: source.workspace_id, source_id: source.id, expiry };
    const event = { version: 1 as const, event_id: `vaut_${canonicalHash(semantics).slice(0, 48)}`, tenant_id: source.tenant_id, workspace_id: source.workspace_id, source_id: source.id,
      action: "revoked" as const, request_hash: canonicalHash(semantics), actor_hash: sha("video-source-authorization-expiry-v1"), requested_at: now.toISOString() };
    const record = await appendVideoRetentionIntent(engine, event);
    await applyVideoRetention(engine, q, source, event); await markVideoRetentionApplied(q, record);
  });
  // Existing pending jobs from this same feature migration also receive explicit
  // frozen defaults; otherwise a job without any artifacts could live forever.
  const unstamped = (await engine.db.query(`SELECT * FROM flow_video_jobs WHERE retention_policy_hash IS NULL AND ($2::text IS NULL OR tenant_id=$2 AND workspace_id=$3) ORDER BY created_at,id LIMIT $1`, [n, ...filter])).rows;
  for (const job of unstamped) await engine.db.tx(q => registerVideoObjectRetention(q, job, [], now));
  const oldObjects = (await engine.db.query(`SELECT o.*,j.id,j.tenant_id,j.workspace_id FROM flow_video_objects o JOIN flow_video_jobs j ON j.tenant_id=o.tenant_id AND j.workspace_id=o.workspace_id AND j.id=o.video_job_id WHERE o.retention_policy_hash IS NULL AND ($2::text IS NULL OR j.tenant_id=$2 AND j.workspace_id=$3) ORDER BY o.object_key LIMIT $1`, [n, ...filter])).rows;
  for (const object of oldObjects) await engine.db.tx(q => registerVideoObjectRetention(q, object, [object], now));
  const due = (await engine.db.query(`SELECT DISTINCT ON (tenant_id,workspace_id,asset_id) * FROM flow_video_jobs WHERE ((text_retention_erased_at IS NULL AND text_max_expires_at<=$1) OR (text_retention_revoked_at IS NULL AND text_access_expires_at<=$1)) AND ($3::text IS NULL OR tenant_id=$3 AND workspace_id=$4) ORDER BY tenant_id,workspace_id,asset_id,created_at LIMIT $2`, [now.toISOString(), n, ...filter])).rows;
  for (const job of due) await engine.db.tx(async q => {
    await lockVideoRetentionTransaction(q);
    const current = (await q.query(`SELECT * FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND ((text_retention_erased_at IS NULL AND text_max_expires_at<=$4) OR (text_retention_revoked_at IS NULL AND text_access_expires_at<=$4)) FOR UPDATE`, [...scope(job), now.toISOString()])).rows[0];
    if (!current) return;
    const action = new Date(current.text_max_expires_at) <= now ? "erased" as const : "revoked" as const;
    const maximum = new Date(current.text_max_expires_at).toISOString();
    const event = { version: 1 as const, event_id: `vttl_${canonicalHash({ scope: scope(job), asset: job.asset_id, policy: job.retention_policy_hash, action, deadline: maximum }).slice(0, 48)}`,
      tenant_id: job.tenant_id, workspace_id: job.workspace_id, asset_id: job.asset_id, action,
      request_hash: canonicalHash({ asset_id: job.asset_id, policy_hash: job.retention_policy_hash, action, maximum }), actor_hash: sha("video-retention-policy-v1"), requested_at: now.toISOString() };
    const record = await appendVideoRetentionIntent(engine, event);
    await applyVideoRetention(engine, q, job, event);
    await q.query(`UPDATE flow_video_jobs SET text_retention_revoked_at=coalesce(text_retention_revoked_at,$4),text_retention_erased_at=CASE WHEN $5 THEN coalesce(text_retention_erased_at,$4) ELSE text_retention_erased_at END,error=$6 WHERE tenant_id=$1 AND workspace_id=$2 AND asset_id=$3`, [job.tenant_id, job.workspace_id, job.asset_id, now.toISOString(), action === "erased", JSON.stringify({ reason: "text_retention_expired", action, policy_hash: job.retention_policy_hash })]);
    await markVideoRetentionApplied(q, record);
  });
  const objects = (await engine.db.query(`SELECT o.*,j.state AS job_state FROM flow_video_objects o JOIN flow_video_jobs j ON j.tenant_id=o.tenant_id AND j.workspace_id=o.workspace_id AND j.id=o.video_job_id
    WHERE o.state='accepted' AND o.access_expires_at<=$1 AND ($3::text IS NULL OR o.tenant_id=$3 AND o.workspace_id=$4) ORDER BY o.access_expires_at,o.object_key LIMIT $2`, [now.toISOString(), n, ...filter])).rows;
  for (const object of objects) await engine.db.tx(async q => {
    const live = (await q.query(`SELECT o.*,j.state AS job_state,j.document_id FROM flow_video_objects o JOIN flow_video_jobs j ON j.tenant_id=o.tenant_id AND j.workspace_id=o.workspace_id AND j.id=o.video_job_id
      WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.object_key=$3 AND o.state='accepted' FOR UPDATE OF o,j`, [object.tenant_id, object.workspace_id, object.object_key])).rows[0];
    if (!live) return;
    const active = !["completed", "completed_with_gaps", "failed", "cancelled"].includes(live.job_state) || (await q.query(`SELECT 1 FROM flow_video_stages WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND state='running' AND lease_expires_at>$4 LIMIT 1`, [object.tenant_id, object.workspace_id, object.video_job_id, now.toISOString()])).rows.length > 0;
    const referenced = Number((await q.query(`SELECT count(*) AS n FROM flow_video_temporal_evidence t JOIN flow_evidence e ON e.tenant_id=t.tenant_id AND e.workspace_id=t.workspace_id AND e.id=t.evidence_id
      JOIN flow_documents d ON d.tenant_id=e.tenant_id AND d.workspace_id=e.workspace_id AND d.id=e.document_id
      WHERE t.tenant_id=$1 AND t.workspace_id=$2 AND (t.frame_ref=$3 OR t.media_sha256=$4) AND d.video_revoked_at IS NULL AND (d.video_text_max_expires_at IS NULL OR d.video_text_max_expires_at>$5)`, [object.tenant_id, object.workspace_id, object.object_key, object.sha256, now.toISOString()])).rows[0].n);
    const material = ["transcript", "evidence"].includes(live.retention_class) && live.document_id && (await q.query(`SELECT 1 FROM flow_documents WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND video_revoked_at IS NULL AND (video_text_max_expires_at IS NULL OR video_text_max_expires_at>$4)`, [object.tenant_id, object.workspace_id, live.document_id, now.toISOString()])).rows.length > 0;
    const refs = referenced + (material ? 1 : 0), reason = active ? "active_job_hold" : refs ? "evidence_reference_hold" : "access_expired";
    await q.query(`UPDATE flow_video_objects SET reference_count=$4,retained_for_evidence=$5,expiry_reason=$6,state=CASE WHEN $7 THEN 'delete_pending' ELSE state END WHERE tenant_id=$1 AND workspace_id=$2 AND object_key=$3`, [object.tenant_id, object.workspace_id, object.object_key, refs, refs > 0, reason, !active && refs === 0]);
    if (object.retention_class === "media") await q.query(`UPDATE flow_video_assets SET availability='media_expired' WHERE tenant_id=$1 AND workspace_id=$2 AND id=(SELECT asset_id FROM flow_video_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3) AND revoked_at IS NULL`, [object.tenant_id, object.workspace_id, object.video_job_id]);
  });
  const backlog = (await engine.db.query(`SELECT 1 FROM flow_video_jobs WHERE ($2::text IS NULL OR tenant_id=$2 AND workspace_id=$3) AND (retention_policy_hash IS NULL OR text_retention_erased_at IS NULL AND text_max_expires_at<=$1 OR text_retention_revoked_at IS NULL AND text_access_expires_at<=$1)
    UNION ALL SELECT 1 FROM flow_sources WHERE kind IN ('bilibili','douyin') AND status<>'revoked' AND (config->>'authorization_expires_at')::timestamptz<=$1 AND ($2::text IS NULL OR tenant_id=$2 AND workspace_id=$3) LIMIT 1`, [now.toISOString(), ...filter])).rows.length > 0;
  return { policies_frozen: unstamped.length, source_expirations: sources.length, textual_expirations: due.length, object_checks: objects.length, backlog };
}
export class VideoRetentionPolicy {
  engine: Engine;
  constructor(engine: Engine) { this.engine = engine; }
  maintain(limit = 20) { return expireVideoObjects(this.engine, limit); }
}

import type { Engine } from "./engine.ts";
import type { Q } from "./db.ts";
import { videoError, type VideoManifest } from "./video-contract.ts";

export function normalizeVideoResources(config: any) {
  config.max_daily_download_bytes ??= 10_000_000_000;
  config.max_daily_media_ms ??= 86_400_000;
  for (const [key, maximum] of [["max_daily_download_bytes", 1_000_000_000_000], ["max_daily_media_ms", 2_592_000_000]] as const)
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > maximum) throw videoError(400, "INVALID_PROFILE_LIMIT");
}

/** Conservative pre-side-effect reservations: unknown outcomes retain their maximum, never become zero usage. */
export async function admitVideoResources(engine: Engine, job: any, profile: any) {
  const day = engine.now().toISOString().slice(0, 10);
  return engine.db.tx(async q => {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`video-resources:${job.tenant_id}:${job.workspace_id}:${day}`]);
    const previous = (await q.query(`SELECT * FROM flow_video_resource_admissions WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 FOR UPDATE`, [job.tenant_id, job.workspace_id, job.id])).rows[0];
    if (previous && previous.state !== "released") return previous;
    const bytes = Number(job.input.lawful_input?.bytes ?? profile.config.max_video_bytes), media = job.input.lawful_input?.input_kind === "platform_subtitles" ? 0 : Number(profile.config.max_duration_ms);
    const used = (await q.query(`SELECT coalesce(sum(CASE WHEN state='settled' THEN actual_bytes ELSE reserved_bytes END),0) AS bytes,
      coalesce(sum(CASE WHEN state='settled' THEN actual_media_ms ELSE reserved_media_ms END),0) AS media FROM flow_video_resource_admissions
      WHERE tenant_id=$1 AND workspace_id=$2 AND resource_day=$3 AND state<>'released'`, [job.tenant_id, job.workspace_id, day])).rows[0];
    if (Number(used.bytes) + bytes > Number(profile.config.max_daily_download_bytes ?? 10_000_000_000) || Number(used.media) + media > Number(profile.config.max_daily_media_ms ?? 86_400_000)) throw videoError(429, "DAILY_RESOURCE_LIMIT");
    return (await q.query(`INSERT INTO flow_video_resource_admissions(tenant_id,workspace_id,video_job_id,resource_day,reserved_bytes,reserved_media_ms,state,created_at)
      VALUES($1,$2,$3,$4,$5,$6,'held',$7) ON CONFLICT(tenant_id,workspace_id,video_job_id) DO UPDATE SET resource_day=EXCLUDED.resource_day,reserved_bytes=EXCLUDED.reserved_bytes,reserved_media_ms=EXCLUDED.reserved_media_ms,state='held',created_at=EXCLUDED.created_at,settled_at=NULL RETURNING *`,
      [job.tenant_id, job.workspace_id, job.id, day, bytes, media, engine.now().toISOString()])).rows[0];
  });
}

export async function settleVideoResources(q: Q, job: any, manifest: VideoManifest, now: Date) {
  const current = (await q.query(`SELECT * FROM flow_video_resource_admissions WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 FOR UPDATE`, [job.tenant_id, job.workspace_id, job.id])).rows[0];
  if (!current || current.state === "settled") return;
  const bytes = manifest.objects.filter(object => object.sha256 === manifest.input_hash).reduce((sum, object) => sum + object.bytes, 0);
  const media = manifest.input_kind === "platform_subtitles" ? 0 : Number(manifest.coverage.duration_ms ?? current.reserved_media_ms);
  if (bytes > Number(current.reserved_bytes) || media > Number(current.reserved_media_ms) || current.state === "released") throw videoError(413, "RESOURCE_RECEIPT_EXCEEDED");
  await q.query(`UPDATE flow_video_resource_admissions SET state='settled',actual_bytes=$4,actual_media_ms=$5,settled_at=$6 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`, [job.tenant_id, job.workspace_id, job.id, bytes, media, now.toISOString()]);
}

export async function releaseUnsubmittedVideoResources(engine: Engine, job: any) {
  // Only a provable pre-submission rejection releases a reservation. A missing response is not this proof.
  if (job.input.lawful_input) return;
  await engine.db.query(`UPDATE flow_video_resource_admissions a SET state='released',settled_at=$4
    WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.video_job_id=$3 AND a.state='held'
    AND NOT EXISTS (SELECT 1 FROM flow_video_submission_intents i WHERE i.tenant_id=a.tenant_id AND i.workspace_id=a.workspace_id AND i.video_job_id=a.video_job_id)
    AND NOT EXISTS (SELECT 1 FROM flow_video_objects o WHERE o.tenant_id=a.tenant_id AND o.workspace_id=a.workspace_id AND o.video_job_id=a.video_job_id)`, [job.tenant_id, job.workspace_id, job.id, engine.now().toISOString()]);
}

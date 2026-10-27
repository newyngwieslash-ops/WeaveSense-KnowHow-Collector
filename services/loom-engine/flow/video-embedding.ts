import type { Engine } from "./engine.ts";
import type { Q } from "./db.ts";
import type { VideoScope, VideoManifest, canonicalTranscript } from "./video-contract.ts";
import { canonicalHash, sha, videoError } from "./video-contract.ts";
import { knowledgeRuntime } from "./video-knowledge-runtime.ts";

type Transcript = ReturnType<typeof canonicalTranscript>;
type Payload = { manifest: VideoManifest; manifestHash: string; transcript: Transcript };
const params = (s: VideoScope, job: any) => [s.tenant_id, s.workspace_id, job.id];
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const json = JSON.stringify;
const configured = (c: any) => typeof c.model_id === "string" && c.model_id.length > 0 && Number.isSafeInteger(c.budget_micro) && c.budget_micro > 0
  && (c.dimensions === null || (Number.isSafeInteger(c.dimensions) && c.dimensions > 0 && c.dimensions <= 65536));

/** No outbound work in the processing transaction, and no worker-supplied vector receipt. */
export async function enqueueVideoEmbedding(q: Q, scope: VideoScope, input: Payload & { job: any }): Promise<boolean> {
  const p = (await q.query(`SELECT config,content_hash FROM flow_video_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND version=$4`,
    [scope.tenant_id, scope.workspace_id, input.job.profile_id, input.job.profile_version])).rows[0];
  if (!p) throw videoError(404, "PROFILE_NOT_FOUND");
  const required = input.job.input.required_capabilities?.includes("embedding") === true;
  if (!required && !p.config.optional_capabilities?.includes("embedding")) return false;
  const config = { model_id: p.config.embedding_model_id ?? "", budget_micro: p.config.embedding_budget_micro ?? 0, dimensions: p.config.embedding_dimensions ?? null };
  const payload: Payload = { manifest: input.manifest, manifestHash: input.manifestHash, transcript: input.transcript };
  const inputHash = canonicalHash(payload);
  const old = (await q.query(`SELECT input_hash,profile_hash,config,required FROM flow_video_embedding_staging WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 FOR UPDATE`, params(scope, input.job))).rows[0];
  if (old && (old.input_hash !== inputHash || old.profile_hash !== p.content_hash || canonicalHash(old.config) !== canonicalHash(config) || old.required !== required)) throw videoError(409, "EMBEDDING_INPUT_CHANGED");
  if (!old) {
    await q.query(`INSERT INTO flow_video_embedding_staging(tenant_id,workspace_id,video_job_id,manifest_hash,input_hash,profile_hash,config,payload,required) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...params(scope, input.job), input.manifestHash, inputHash, p.content_hash, json(config), json(payload), required]);
    if (!required && !configured(config)) {
      await q.query(`UPDATE flow_video_embedding_staging SET state='optional_missing',error='EMBEDDING_UNAVAILABLE' WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`, params(scope, input.job));
    } else {
      await q.query(`INSERT INTO flow_video_stages(tenant_id,workspace_id,video_job_id,stage) VALUES($1,$2,$3,'embedding')`, params(scope, input.job));
      await q.query(`UPDATE flow_video_jobs SET state='queued',stage='embedding',updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, params(scope, input.job));
    }
  }
  return required || configured(config);
}

async function staging(q: Q, scope: VideoScope, job: any) {
  const row = (await q.query(`SELECT * FROM flow_video_embedding_staging WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`, params(scope, job))).rows[0];
  if (!row || row.state === "cancelled" || row.input_hash !== canonicalHash(row.payload) || row.manifest_hash !== row.payload.manifestHash) throw videoError(409, "EMBEDDING_INPUT_CHANGED");
  const p = (await q.query(`SELECT content_hash FROM flow_video_profiles WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND version=$4`, [scope.tenant_id, scope.workspace_id, job.profile_id, job.profile_version])).rows[0];
  if (!p || p.content_hash !== row.profile_hash) throw videoError(409, "EMBEDDING_PROFILE_CHANGED");
  return row;
}

export async function loadVideoEmbedding(q: Q, scope: VideoScope, job: any): Promise<Payload> {
  return (await staging(q, scope, job)).payload;
}

/** Explicit core retry only. Unknown acceptance never creates a new paid task. */
export async function retryVideoEmbedding(q: Q, scope: VideoScope, job: any) {
  const rows = (await q.query(`SELECT * FROM flow_video_embedding_batches WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND state='failed' FOR UPDATE`, params(scope, job))).rows;
  for (const batch of rows) {
    if (!["failed", "cancelled"].includes(batch.receipt?.status) || batch.receipt.task_id !== batch.external_task_id || batch.generation >= 7) throw videoError(409, "EMBEDDING_RETRY_NOT_PROVEN_SAFE");
    const request = { ...batch.request, key: `${batch.request.key.replace(/:retry:\d+$/, "")}:retry:${batch.generation + 1}` };
    await q.query(`UPDATE flow_video_embedding_batches SET request=$5,request_hash=$6,state='prepared',external_task_id=NULL,prior_receipts=prior_receipts || jsonb_build_array(receipt),receipt=NULL,generation=generation+1,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND batch_index=$4`,
      [...params(scope, job), batch.batch_index, json(request), canonicalHash(request)]);
  }
  return rows.length;
}

/** The caller holds the active job/stage lock and has already inserted these exact chunks. */
export async function commitVideoEmbeddings(q: Q, scope: VideoScope, job: any, docId: string, revision: number) {
  const found = (await q.query(`SELECT 1 FROM flow_video_embedding_staging WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`, params(scope, job))).rows.length;
  if (!found) {
    if (job.input.required_capabilities?.includes("embedding")) throw videoError(409, "EMBEDDING_NOT_VERIFIED");
    return { completed: false, optional_missing: false };
  }
  const row = await staging(q, scope, job);
  if (row.state === "optional_missing" && !row.required) return { completed: false, optional_missing: true };
  if (row.state !== "completed" || !row.provider || !hash(row.model_config_hash)) throw videoError(409, "EMBEDDING_NOT_VERIFIED");
  const chunks = (await q.query(`SELECT chunk_index,text FROM flow_document_chunks WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4 ORDER BY chunk_index`, [scope.tenant_id, scope.workspace_id, docId, revision])).rows;
  const batches = (await q.query(`SELECT * FROM flow_video_embedding_batches WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 ORDER BY batch_index`, params(scope, job))).rows;
  if (chunks.length !== row.chunk_count || !chunks.length || !batches.length || chunks.map(x => x.text).join("") !== row.payload.transcript.text) throw videoError(409, "EMBEDDING_CHUNKS_CHANGED");
  let index = 0;
  for (const batch of batches) {
    if (batch.state !== "completed" || batch.request_hash !== canonicalHash(batch.request) || batch.vectors_hash !== canonicalHash(batch.vectors)
      || batch.receipt?.model_config_hash !== row.model_config_hash || !batch.external_task_id || batch.receipt.task_id !== batch.external_task_id) throw videoError(409, "EMBEDDING_NOT_VERIFIED");
    for (const vector of batch.vectors) {
      const chunk = chunks[index++];
      if (!chunk || vector.chunk_id !== String(chunk.chunk_index) || vector.sha256 !== sha(chunk.text) || vector.vector.length !== row.dimensions) throw videoError(409, "EMBEDDING_CHUNKS_CHANGED");
      await q.query(`INSERT INTO flow_document_embeddings(tenant_id,workspace_id,document_id,revision,chunk_index,provider,dims,vector) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(tenant_id,document_id,revision,chunk_index,provider) DO NOTHING`, [scope.tenant_id, scope.workspace_id, docId, revision, chunk.chunk_index, row.provider, row.dimensions, vector.vector]);
      const stored = (await q.query(`SELECT vector,dims FROM flow_document_embeddings WHERE tenant_id=$1 AND workspace_id=$2 AND document_id=$3 AND revision=$4 AND chunk_index=$5 AND provider=$6`, [scope.tenant_id, scope.workspace_id, docId, revision, chunk.chunk_index, row.provider])).rows[0];
      // REAL[] rounds to float32: compare that representation, not JS float64.
      if (!stored || stored.dims !== row.dimensions || canonicalHash(stored.vector.map(Math.fround)) !== canonicalHash(vector.vector.map(Math.fround))) throw videoError(409, "EMBEDDING_INDEX_CONFLICT");
    }
  }
  if (index !== chunks.length) throw videoError(409, "EMBEDDING_CHUNKS_CHANGED");
  return { completed: true, optional_missing: false };
}

export class VideoEmbeddingService {
  engine: Engine;
  constructor(engine: Engine) { this.engine = engine; }
  private async fenced(q: Q, job: any, st: any) {
    const row = (await q.query(`SELECT st.*,j.state AS job_state,j.execution_erased_at,s.status AS source_status,s.config AS source_config,a.revoked_at
      FROM flow_video_stages st JOIN flow_video_jobs j ON j.tenant_id=st.tenant_id AND j.workspace_id=st.workspace_id AND j.id=st.video_job_id
      JOIN flow_sources s ON s.tenant_id=j.tenant_id AND s.workspace_id=j.workspace_id AND s.id=j.source_id
      JOIN flow_video_assets a ON a.tenant_id=j.tenant_id AND a.workspace_id=j.workspace_id AND a.id=j.asset_id
      WHERE st.tenant_id=$1 AND st.workspace_id=$2 AND st.video_job_id=$3 AND st.stage='embedding' FOR UPDATE OF st,j FOR SHARE OF s,a`, params(job, job))).rows[0];
    if (!row || row.state !== "running" || row.job_state !== "running" || row.attempt !== st.attempt || Number(row.fencing_token) !== Number(st.fencing_token)
      || row.lease_owner !== st.lease_owner || new Date(row.lease_expires_at).getTime() <= this.engine.now().getTime()) throw videoError(409, "STALE_FENCE");
    if (row.execution_erased_at || row.source_status === "revoked" || row.revoked_at || (row.source_config.authorization_expires_at && new Date(row.source_config.authorization_expires_at).getTime() <= this.engine.now().getTime())) throw videoError(403, "AUTH_REQUIRED");
  }
  private async missing(q: Q, job: any, reason: string) {
    await q.query(`UPDATE flow_video_embedding_staging SET state='optional_missing',error=$4,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`, [...params(job, job), reason]);
    return "completed" as const;
  }
  async workClaim(job: any, st: any): Promise<"pending" | "completed"> {
    const prepared = await this.engine.db.tx(async q => {
      await this.fenced(q, job, st);
      const row = await staging(q, job, job);
      if (["completed", "optional_missing"].includes(row.state)) return { row, done: true };
      const cfg = row.config;
      if (!configured(cfg) || !knowledgeRuntime(this.engine).modelTask) {
        if (!row.required) { await this.missing(q, job, "EMBEDDING_UNAVAILABLE"); return { row, done: true }; }
        throw videoError(503, "EMBEDDING_UNAVAILABLE");
      }
      if (!job.budget_reservation_id) throw videoError(402, "BUDGET_EXCEEDED");
      let batch = (await q.query(`SELECT * FROM flow_video_embedding_batches WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND state<>'completed' ORDER BY batch_index LIMIT 1`, params(job, job))).rows[0];
      if (row.chunk_count === null) {
        const texts = this.engine.chunkText(row.payload.transcript.text).map(x => ({ chunk_id: String(x.chunk_index), text: x.text, sha256: sha(x.text) }));
        if (!texts.length || texts.some(x => Buffer.byteLength(x.text, "utf8") > 8192)) throw videoError(422, "EMBEDDING_INPUT_LIMIT");
        const groups: typeof texts[] = []; let group: typeof texts = [], bytes = 0;
        for (const text of texts) {
          const n = Buffer.byteLength(text.text, "utf8");
          if (group.length && (group.length >= 32 || bytes + n > 131072)) { groups.push(group); group = []; bytes = 0; }
          group.push(text); bytes += n;
        }
        if (group.length) groups.push(group);
        const budget = Math.min(20_000_000, Math.floor(cfg.budget_micro / groups.length));
        if (budget <= 0) { if (!row.required) { await this.missing(q, job, "BUDGET_EXCEEDED"); return { row, done: true }; } throw videoError(402, "BUDGET_EXCEEDED"); }
        for (let i = 0; i < groups.length; i++) {
          const request = { key: `embedding:${job.id}:${row.input_hash}:${i}`, model_id: cfg.model_id, budget_micro: budget, max_tokens: 1, input: { texts: groups[i] } };
          await q.query(`INSERT INTO flow_video_embedding_batches(tenant_id,workspace_id,video_job_id,batch_index,request_hash,request) VALUES($1,$2,$3,$4,$5,$6)`, [...params(job, job), i, canonicalHash(request), json(request)]);
        }
        await q.query(`UPDATE flow_video_embedding_staging SET chunk_count=$4,state='running',updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`, [...params(job, job), texts.length]);
        batch = (await q.query(`SELECT * FROM flow_video_embedding_batches WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND batch_index=0`, params(job, job))).rows[0];
      }
      if (!batch || batch.request_hash !== canonicalHash(batch.request)) throw videoError(409, "EMBEDDING_INPUT_CHANGED");
      return { row, batch, done: false };
    });
    if (prepared.done) return "completed";
    const { row, batch } = prepared;
    let task;
    try {
      // Host rebinds ONLY the current attempt/fence envelope; frozen input/key/budget
      // stay identical. Re-POST also recovers a lost accepted response without a second call.
      task = await knowledgeRuntime(this.engine).modelTask!(job, job.id, "video_embedding", { ...batch.request, stage_attempt: st.attempt, fencing_token: Number(st.fencing_token) });
    } catch (e: any) {
      if ([401, 403].includes(e.status)) throw videoError(403, "AUTH_REQUIRED");
      if (e.status === 402 && row.required) throw videoError(402, "BUDGET_EXCEEDED");
      if ([400, 402, 413, 422].includes(e.status) && !row.required) return this.engine.db.tx(async q => { await this.fenced(q, job, st); return this.missing(q, job, e.status === 402 ? "BUDGET_EXCEEDED" : "EMBEDDING_REJECTED"); });
      // A persisted idempotent intent can be safely reconciled on a later claim.
      throw videoError(503, "PROVIDER_UNAVAILABLE");
    }
    let terminalError: ReturnType<typeof videoError> | undefined;
    const outcome = await this.engine.db.tx(async q => {
      await this.fenced(q, job, st);
      if (!task.task_id || (batch.external_task_id && batch.external_task_id !== task.task_id)) throw videoError(502, "EMBEDDING_RECEIPT_INVALID");
      await q.query(`UPDATE flow_video_embedding_batches SET external_task_id=$5,state='submitted',updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND batch_index=$4`, [...params(job, job), batch.batch_index, task.task_id]);
      if (["queued", "running", "retry_wait"].includes(task.status)) return "pending";
      if (["reconciliation_required", "unknown"].includes(task.status)) {
        await q.query(`UPDATE flow_video_embedding_batches SET state='unknown',receipt=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND batch_index=$4`, [...params(job, job), batch.batch_index, json({ ...task, output: undefined })]);
        terminalError = videoError(409, "EXTERNAL_OUTCOME_UNKNOWN"); return "pending" as const;
      }
      if (["failed", "cancelled"].includes(task.status)) {
        await q.query(`UPDATE flow_video_embedding_batches SET state='failed',receipt=$5 WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND batch_index=$4`, [...params(job, job), batch.batch_index, json({ ...task, output: undefined })]);
        if (!row.required) return this.missing(q, job, "EMBEDDING_TASK_FAILED");
        terminalError = videoError(502, "EMBEDDING_TASK_FAILED"); return "pending" as const;
      }
      const out = task.output;
      if (task.status !== "succeeded" || !hash(task.model_config_hash) || !hash(task.input_hash) || !task.reservation_id || task.usage_ref !== `model_task:${task.task_id}`
        || !Number.isSafeInteger(task.cost_micro) || task.cost_micro! < 0 || task.cost_micro! > batch.request.budget_micro
        || out?.model !== row.config.model_id || !Number.isSafeInteger(out.dimensions) || out.dimensions < 1 || out.dimensions > 65536
        || (row.config.dimensions !== null && row.config.dimensions !== out.dimensions) || !Array.isArray(out.vectors) || out.vectors.length !== batch.request.input.texts.length) throw videoError(502, "EMBEDDING_RECEIPT_INVALID");
      const current = await staging(q, job, job);
      if ((current.model_config_hash && current.model_config_hash !== task.model_config_hash) || (current.dimensions && current.dimensions !== out.dimensions)) throw videoError(409, "EMBEDDING_MODEL_CHANGED");
      const vectors = out.vectors.map((v: any, i: number) => {
        const text = batch.request.input.texts[i];
        if (!v || v.chunk_id !== text.chunk_id || v.sha256 !== text.sha256 || !Array.isArray(v.vector) || v.vector.length !== out.dimensions
          || v.vector.some((x: any) => typeof x !== "number" || !Number.isFinite(x) || !Number.isFinite(Math.fround(x))) || !v.vector.some((x: number) => Math.fround(x) !== 0)) throw videoError(502, "EMBEDDING_VECTOR_INVALID");
        return { chunk_id: v.chunk_id, sha256: v.sha256, vector: v.vector.map(Math.fround) };
      });
      const receipt = { ...task, output: undefined };
      await q.query(`UPDATE flow_video_embedding_batches SET state='completed',vectors=$5,receipt=$6,vectors_hash=$7,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND batch_index=$4`, [...params(job, job), batch.batch_index, json(vectors), json(receipt), canonicalHash(vectors)]);
      const remaining = (await q.query(`SELECT 1 FROM flow_video_embedding_batches WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3 AND state<>'completed' LIMIT 1`, params(job, job))).rows.length;
      await q.query(`UPDATE flow_video_embedding_staging SET model_config_hash=$4,dimensions=$5,provider=$6,state=$7,updated_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND video_job_id=$3`,
        [...params(job, job), task.model_config_hash, out.dimensions, `host:${row.config.model_id}:${task.model_config_hash}`, remaining ? "running" : "completed"]);
      return remaining ? "pending" : "completed";
    });
    if (terminalError) throw terminalError;
    return outcome;
  }
}

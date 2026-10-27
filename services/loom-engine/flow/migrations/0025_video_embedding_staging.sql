-- Staging is not a material index. Only the K017 ready transaction copies verified
-- vectors into the existing flow_document_embeddings table.
CREATE TABLE flow_video_embedding_staging (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL, input_hash TEXT NOT NULL, profile_hash TEXT NOT NULL,
  config JSONB NOT NULL, payload JSONB NOT NULL, required BOOLEAN NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', error TEXT, chunk_count INTEGER,
  model_config_hash TEXT, dimensions INTEGER, provider TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,video_job_id),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_embedding_batches (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL, batch_index INTEGER NOT NULL,
  request_hash TEXT NOT NULL, request JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'prepared',
  external_task_id TEXT, vectors JSONB, receipt JSONB, vectors_hash TEXT, generation INTEGER NOT NULL DEFAULT 0, prior_receipts JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,video_job_id,batch_index),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_embedding_staging(tenant_id,workspace_id,video_job_id)
);
ALTER TABLE flow_video_embedding_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_embedding_staging FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_embedding_staging USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_embedding_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_embedding_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_embedding_batches USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));

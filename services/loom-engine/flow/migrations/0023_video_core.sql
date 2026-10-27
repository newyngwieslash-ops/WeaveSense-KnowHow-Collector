-- Video business authority remains in flow_intel; old source/revision contracts survive rollback.
ALTER TABLE flow_sources DROP CONSTRAINT IF EXISTS flow_sources_kind_check;
ALTER TABLE flow_sources ADD CONSTRAINT flow_sources_kind_check CHECK (kind IN ('rss','telegram','wechat','bilibili','douyin'));
ALTER TABLE flow_collection_runs ADD COLUMN video_discovery_options JSONB;
ALTER TABLE flow_collection_runs ADD COLUMN video_source_config JSONB;
ALTER TABLE flow_collection_runs ADD COLUMN video_grant_actor TEXT;
ALTER TABLE flow_collection_runs ADD COLUMN video_policy_version TEXT;
ALTER TABLE flow_collection_runs ADD COLUMN video_discovery_checkpoint JSONB;
CREATE TABLE flow_video_profiles (
  id TEXT NOT NULL, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  name TEXT NOT NULL, config JSONB NOT NULL, content_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,id,version)
);
CREATE TABLE flow_video_assets (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, platform TEXT NOT NULL CHECK(platform IN ('bilibili','douyin')),
  native_id TEXT NOT NULL, part_id TEXT NOT NULL DEFAULT '', canonical_url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}', media_sha256 TEXT, availability TEXT NOT NULL DEFAULT 'not_acquired', origin_cluster TEXT,
  revoked_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ, input_checked_at TIMESTAMPTZ, last_reconcile_at TIMESTAMPTZ, remote_checked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,workspace_id,platform,native_id,part_id), UNIQUE(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_asset_sources (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, asset_id TEXT NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,asset_id,source_id),
  FOREIGN KEY(tenant_id,workspace_id,asset_id) REFERENCES flow_video_assets(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,source_id) REFERENCES flow_sources(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_jobs (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, asset_id TEXT NOT NULL,
  profile_id TEXT NOT NULL, profile_version INTEGER NOT NULL, fingerprint TEXT NOT NULL, input JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retry_wait','blocked_auth','blocked_budget','reconciliation_required','cancel_requested','cancelled','failed','completed','completed_with_gaps')),
  stage TEXT NOT NULL DEFAULT 'input', completion_level TEXT NOT NULL DEFAULT 'pending', grant_actor TEXT NOT NULL, policy_version TEXT NOT NULL,
  document_id TEXT, revision INTEGER, input_manifest_sha256 TEXT, processing_manifest_sha256 TEXT,
  verified_input_hash TEXT, verified_media_sha256 TEXT, processing_identity TEXT, reused_from_job_id TEXT,
  coverage JSONB NOT NULL DEFAULT '{}', available_capabilities TEXT[] NOT NULL DEFAULT '{}', remote_cancel_status TEXT NOT NULL DEFAULT 'not_requested',
  error JSONB, cleanup_error JSONB, budget_reservation_id TEXT, actual_usage_micro BIGINT NOT NULL DEFAULT 0, budget_closed_at TIMESTAMPTZ, execution_erased_at TIMESTAMPTZ,
  budget_generation INTEGER NOT NULL DEFAULT 0, budget_consumed_prior_micro BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  UNIQUE(tenant_id,workspace_id,fingerprint), UNIQUE(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,source_id) REFERENCES flow_sources(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,asset_id) REFERENCES flow_video_assets(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,profile_id,profile_version) REFERENCES flow_video_profiles(tenant_id,workspace_id,id,version)
);
CREATE TABLE flow_video_requests (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, namespace TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, video_job_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,namespace,idempotency_key),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_operation_jobs (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, video_job_id TEXT NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,operation_id,video_job_id,source_id),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,source_id) REFERENCES flow_sources(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_stages (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL, stage TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0, fencing_token BIGINT NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(), error JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,video_job_id,stage),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
CREATE INDEX flow_video_claim ON flow_video_stages(state,next_poll_at,lease_expires_at);
CREATE TABLE flow_video_resource_admissions (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL, resource_day DATE NOT NULL,
  reserved_bytes BIGINT NOT NULL CHECK(reserved_bytes>=0), reserved_media_ms BIGINT NOT NULL CHECK(reserved_media_ms>=0),
  actual_bytes BIGINT CHECK(actual_bytes>=0), actual_media_ms BIGINT CHECK(actual_media_ms>=0), state TEXT NOT NULL CHECK(state IN ('held','settled','released')),
  created_at TIMESTAMPTZ NOT NULL, settled_at TIMESTAMPTZ,
  PRIMARY KEY(tenant_id,workspace_id,video_job_id),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
ALTER TABLE flow_video_resource_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_resource_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_resource_admissions_tenant ON flow_video_resource_admissions USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
CREATE TABLE flow_video_submission_intents (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL, stage TEXT NOT NULL, intent_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, provider_instance TEXT NOT NULL, external_task_id TEXT, state TEXT NOT NULL DEFAULT 'prepared',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,intent_key), UNIQUE(tenant_id,workspace_id,video_job_id,stage),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
CREATE UNIQUE INDEX flow_video_external_task ON flow_video_submission_intents(provider_instance,external_task_id) WHERE external_task_id IS NOT NULL;
CREATE TABLE flow_video_manifests (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL, artifact_stage TEXT NOT NULL,
  sha256 TEXT NOT NULL, manifest JSONB NOT NULL, accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,video_job_id,artifact_stage),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_objects (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL, object_key TEXT NOT NULL, sha256 TEXT NOT NULL,
  object_id TEXT GENERATED ALWAYS AS (md5(object_key)) STORED,
  replica_job_id TEXT, replica_object_key TEXT,
  bytes BIGINT NOT NULL, content_type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'accepted', cleanup_next_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,object_key), FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_usage_counters (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL, stage TEXT NOT NULL, usage_type TEXT NOT NULL, quantity BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id,workspace_id,video_job_id,stage,usage_type),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_provider_health (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, provider_key TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, blocked_until TIMESTAMPTZ, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,provider_key)
);
ALTER TABLE flow_video_provider_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_provider_health FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_provider_health USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
CREATE TABLE flow_video_cleanup_receipts (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, object_key TEXT NOT NULL, sha256 TEXT NOT NULL, deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,object_key)
);
CREATE TABLE flow_video_corrections (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  original_job_id TEXT NOT NULL, video_job_id TEXT NOT NULL, document_id TEXT NOT NULL, from_revision INTEGER NOT NULL, to_revision INTEGER NOT NULL,
  artifact JSONB NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,idempotency_key), FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_discovery_checkpoints (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, stable_watermark JSONB,
  checkpoint JSONB, pending_watermark JSONB, partial BOOLEAN NOT NULL DEFAULT false, generation INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,source_id), FOREIGN KEY(tenant_id,workspace_id,source_id) REFERENCES flow_sources(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_discovery_pages (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, operation_id TEXT NOT NULL, page_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,workspace_id,source_id,page_key),
  FOREIGN KEY(tenant_id,workspace_id,source_id) REFERENCES flow_sources(tenant_id,workspace_id,id)
);
ALTER TABLE flow_documents ADD COLUMN video_asset_id TEXT;
ALTER TABLE flow_documents ADD COLUMN video_ready BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE flow_documents ADD COLUMN video_revoked_at TIMESTAMPTZ;
ALTER TABLE flow_document_revisions ADD COLUMN video_manifest_sha256 TEXT;
ALTER TABLE flow_document_revisions ADD COLUMN material_type TEXT NOT NULL DEFAULT 'source';
ALTER TABLE flow_evidence ADD CONSTRAINT flow_evidence_scope_id_key UNIQUE(tenant_id,workspace_id,id);
CREATE TABLE flow_video_temporal_evidence (
  evidence_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL,
  start_ms BIGINT, end_ms BIGINT, frame_ref TEXT, alignment_method TEXT NOT NULL, media_sha256 TEXT, material_type TEXT NOT NULL DEFAULT 'asr_transcript',
  FOREIGN KEY(tenant_id,workspace_id,evidence_id) REFERENCES flow_evidence(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id)
);
CREATE UNIQUE INDEX flow_video_ready_once ON flow_outbox(tenant_id,workspace_id,job_id,type) WHERE type='video.knowledge_ready';
ALTER TABLE flow_video_operation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_operation_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_operation_jobs_tenant ON flow_video_operation_jobs USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_usage_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_usage_counters_tenant ON flow_video_usage_counters USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_cleanup_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_cleanup_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_cleanup_receipts_tenant ON flow_video_cleanup_receipts USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_corrections_tenant ON flow_video_corrections USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));

ALTER TABLE flow_video_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_profiles_tenant ON flow_video_profiles USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_assets_tenant ON flow_video_assets USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_asset_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_asset_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_asset_sources_tenant ON flow_video_asset_sources USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_jobs_tenant ON flow_video_jobs USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_requests_tenant ON flow_video_requests USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_stages_tenant ON flow_video_stages USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_submission_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_submission_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_submission_intents_tenant ON flow_video_submission_intents USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_manifests_tenant ON flow_video_manifests USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_objects_tenant ON flow_video_objects USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_discovery_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_discovery_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_discovery_checkpoints_tenant ON flow_video_discovery_checkpoints USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_discovery_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_discovery_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_discovery_pages_tenant ON flow_video_discovery_pages USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_temporal_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_temporal_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_temporal_evidence_tenant ON flow_video_temporal_evidence USING (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));

-- K-021..K-029. Materials remain in the host document/revision/evidence tables.
ALTER TABLE flow_reports ADD COLUMN video_revoked_at TIMESTAMPTZ;
ALTER TABLE flow_research_runs ADD COLUMN video_revoked_at TIMESTAMPTZ;
CREATE TABLE flow_knowledge_units (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL, profile_version INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('candidate','in_review','approved','published','rejected','withdrawn','superseded')),
  approval JSONB, release_id TEXT, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, profile_id, profile_version) REFERENCES flow_video_profiles(tenant_id,workspace_id,id,version)
);
CREATE TABLE flow_knowledge_versions (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, knowledge_id TEXT NOT NULL, version INTEGER NOT NULL,
  content_hash TEXT NOT NULL, unit JSONB NOT NULL, method JSONB NOT NULL, evidence_snapshot JSONB NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,workspace_id,knowledge_id,version),
  FOREIGN KEY (tenant_id,workspace_id,knowledge_id) REFERENCES flow_knowledge_units(tenant_id,workspace_id,id)
);
CREATE TABLE flow_knowledge_evidence_refs (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, knowledge_id TEXT NOT NULL, version INTEGER NOT NULL,
  evidence_id TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL, snippet_hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id,workspace_id,knowledge_id,version,evidence_id),
  FOREIGN KEY (tenant_id,workspace_id,knowledge_id,version) REFERENCES flow_knowledge_versions(tenant_id,workspace_id,knowledge_id,version),
  FOREIGN KEY (tenant_id,workspace_id,evidence_id) REFERENCES flow_evidence(tenant_id,workspace_id,id),
  FOREIGN KEY (tenant_id,workspace_id,document_id) REFERENCES flow_documents(tenant_id,workspace_id,id),
  FOREIGN KEY (document_id,revision) REFERENCES flow_document_revisions(document_id,revision)
);
CREATE INDEX flow_knowledge_evidence_lineage ON flow_knowledge_evidence_refs(tenant_id,workspace_id,document_id);
CREATE TABLE flow_knowledge_reviews (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, knowledge_id TEXT NOT NULL,
  version INTEGER NOT NULL, content_hash TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
  actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id,knowledge_id,version) REFERENCES flow_knowledge_versions(tenant_id,workspace_id,knowledge_id,version)
);
CREATE TABLE flow_knowledge_releases (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, knowledge_id TEXT NOT NULL,
  version INTEGER NOT NULL, content_hash TEXT NOT NULL, snapshot JSONB NOT NULL,
  published_by TEXT NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ,
  UNIQUE (tenant_id,workspace_id,id), UNIQUE (tenant_id,workspace_id,knowledge_id,version),
  FOREIGN KEY (tenant_id,workspace_id,knowledge_id,version) REFERENCES flow_knowledge_versions(tenant_id,workspace_id,knowledge_id,version)
);
CREATE TABLE flow_knowledge_commands (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, namespace TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,workspace_id,namespace,idempotency_key)
);
CREATE TABLE flow_knowledge_conflicts (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  left_id TEXT NOT NULL, left_version INTEGER NOT NULL, right_id TEXT NOT NULL, right_version INTEGER NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('potential_conflict','contradiction','different_conditions','supersedes')),
  reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,workspace_id,left_id,left_version,right_id,right_version),
  FOREIGN KEY(tenant_id,workspace_id,left_id,left_version) REFERENCES flow_knowledge_versions(tenant_id,workspace_id,knowledge_id,version),
  FOREIGN KEY(tenant_id,workspace_id,right_id,right_version) REFERENCES flow_knowledge_versions(tenant_id,workspace_id,knowledge_id,version)
);
CREATE TABLE flow_video_deletion_tombstones (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, document_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('revoked','erased')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,workspace_id,document_id,action)
);
CREATE TABLE flow_video_skill_candidates (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL, skill_version TEXT NOT NULL, candidate_hash TEXT NOT NULL, native_skill_hash TEXT NOT NULL,
  proposal JSONB NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','evaluation_running','passed','approved_for_release','release_package_exported','deployed','workspace_installed','rejected','retired')),
  eval_result JSONB, approval JSONB, release_package JSONB, receipts JSONB NOT NULL DEFAULT '[]',
  budget_closed_at TIMESTAMPTZ, budget_close_receipt JSONB, budget_close_next_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,workspace_id,id), UNIQUE(tenant_id,workspace_id,skill_id,skill_version)
);
CREATE TABLE flow_video_skill_dependencies (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
  release_id TEXT NOT NULL, knowledge_id TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY(tenant_id,workspace_id,candidate_id,release_id),
  FOREIGN KEY(tenant_id,workspace_id,candidate_id) REFERENCES flow_video_skill_candidates(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,release_id) REFERENCES flow_knowledge_releases(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_skill_evaluations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
  candidate_hash TEXT NOT NULL, report JSONB NOT NULL, actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,workspace_id,candidate_id) REFERENCES flow_video_skill_candidates(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_knowledge_runs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, video_job_id TEXT NOT NULL,
  document_id TEXT NOT NULL, revision INTEGER NOT NULL, profile_id TEXT NOT NULL, profile_version INTEGER NOT NULL,
  grant_actor TEXT NOT NULL, policy_version TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
  frozen_input JSONB NOT NULL, input_hash TEXT NOT NULL, external_task_id TEXT, candidate_ids TEXT[] NOT NULL DEFAULT '{}', batch_cursor INTEGER NOT NULL DEFAULT 0,
  model_request JSONB, model_config_hash TEXT, budget_closed_at TIMESTAMPTZ, budget_close_receipt JSONB, budget_close_next_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT, lease_expires_at TIMESTAMPTZ, fencing_token BIGINT NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT, next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,workspace_id,document_id,revision,profile_id,profile_version),
  FOREIGN KEY(tenant_id,workspace_id,video_job_id) REFERENCES flow_video_jobs(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,profile_id,profile_version) REFERENCES flow_video_profiles(tenant_id,workspace_id,id,version)
);
CREATE TABLE flow_video_skill_eval_tasks (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, candidate_id TEXT NOT NULL, case_id TEXT NOT NULL, variant TEXT NOT NULL,
  task_id TEXT, result JSONB, state TEXT NOT NULL DEFAULT 'queued', request_hash TEXT NOT NULL,
  model_request JSONB,
  lease_owner TEXT, lease_expires_at TIMESTAMPTZ, fencing_token BIGINT NOT NULL DEFAULT 0, next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,candidate_id,case_id,variant),
  FOREIGN KEY(tenant_id,workspace_id,candidate_id) REFERENCES flow_video_skill_candidates(tenant_id,workspace_id,id)
);
CREATE TABLE flow_knowledge_run_snapshots (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, method_id TEXT NOT NULL,
  method JSONB NOT NULL, release_ids TEXT[] NOT NULL, content_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,workspace_id,run_id,method_id)
);
CREATE INDEX flow_knowledge_query ON flow_knowledge_units(tenant_id,workspace_id,state,profile_id);
CREATE INDEX flow_knowledge_text ON flow_knowledge_versions USING GIN(to_tsvector('simple',unit->>'title' || ' ' || (unit->>'statement')));
ALTER TABLE flow_knowledge_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_knowledge_units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_knowledge_units USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_knowledge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_knowledge_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_knowledge_versions USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_knowledge_evidence_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_knowledge_evidence_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_knowledge_evidence_refs USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_knowledge_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_knowledge_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_knowledge_reviews USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_knowledge_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_knowledge_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_knowledge_releases USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_knowledge_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_knowledge_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_knowledge_commands USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_knowledge_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_knowledge_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_knowledge_conflicts USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_deletion_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_deletion_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_deletion_tombstones USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_skill_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_skill_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_skill_candidates USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_skill_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_skill_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_skill_dependencies USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_skill_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_skill_evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_skill_evaluations USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_knowledge_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_knowledge_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_knowledge_runs USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_skill_eval_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_skill_eval_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_skill_eval_tasks USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_knowledge_run_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_knowledge_run_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_knowledge_run_snapshots USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));

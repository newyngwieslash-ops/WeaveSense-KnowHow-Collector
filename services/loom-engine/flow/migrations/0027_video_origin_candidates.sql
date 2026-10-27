CREATE TABLE flow_video_origin_checks (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL,
  grant_actor TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', error TEXT,
  lease_owner TEXT, lease_expires_at TIMESTAMPTZ, fencing_token BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,document_id,revision),
  FOREIGN KEY(tenant_id,workspace_id,document_id) REFERENCES flow_documents(tenant_id,workspace_id,id)
);
CREATE TABLE flow_video_origin_fingerprints (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL, asset_id TEXT NOT NULL,
  algorithm TEXT NOT NULL, revision_hash TEXT NOT NULL, normalized_hash TEXT NOT NULL, signature TEXT[] NOT NULL, characters INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,workspace_id,document_id,revision),
  FOREIGN KEY(tenant_id,workspace_id,document_id,revision) REFERENCES flow_video_origin_checks(tenant_id,workspace_id,document_id,revision),
  FOREIGN KEY(tenant_id,workspace_id,asset_id) REFERENCES flow_video_assets(tenant_id,workspace_id,id)
);
CREATE INDEX flow_video_origin_signature ON flow_video_origin_fingerprints USING GIN(signature);
CREATE TABLE flow_video_origin_candidates (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  left_asset_id TEXT NOT NULL, right_asset_id TEXT NOT NULL, content_hash TEXT NOT NULL, proposal JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','same_origin','independent','unavailable')),
  review JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,workspace_id,left_asset_id) REFERENCES flow_video_assets(tenant_id,workspace_id,id),
  FOREIGN KEY(tenant_id,workspace_id,right_asset_id) REFERENCES flow_video_assets(tenant_id,workspace_id,id)
);
CREATE INDEX flow_video_origin_pending ON flow_video_origin_candidates(tenant_id,workspace_id,state,left_asset_id,right_asset_id);
ALTER TABLE flow_video_origin_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_origin_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_origin_checks USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_origin_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_origin_fingerprints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_origin_fingerprints USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE flow_video_origin_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_origin_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_video_origin_candidates USING(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(coalesce(current_setting('app.tenant_id',true),'')='' OR tenant_id=current_setting('app.tenant_id',true));

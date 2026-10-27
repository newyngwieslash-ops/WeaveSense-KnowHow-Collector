-- The authoritative journal is a separately retained filesystem volume, never this database.
-- Restoring these receipts is safe only after matching their external authenticated records.
CREATE TABLE flow_video_deletion_journal_mutex (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT INTO flow_video_deletion_journal_mutex(id) VALUES(1);
CREATE TABLE flow_video_deletion_journal_identity (
  id INTEGER PRIMARY KEY CHECK(id=1), journal_id TEXT NOT NULL,
  genesis_hash TEXT NOT NULL CHECK(genesis_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE flow_video_deletion_journal_receipts (
  journal_id TEXT NOT NULL, sequence BIGINT NOT NULL CHECK(sequence > 0),
  event_hash TEXT NOT NULL CHECK(event_hash ~ '^[a-f0-9]{64}$'), event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(journal_id,sequence), UNIQUE(tenant_id,workspace_id,event_id)
);
ALTER TABLE flow_video_deletion_journal_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_video_deletion_journal_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY flow_video_deletion_journal_receipts_tenant ON flow_video_deletion_journal_receipts
  USING (current_setting('app.tenant_id', true) IS NULL OR current_setting('app.tenant_id', true) = '' OR tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.tenant_id', true) IS NULL OR current_setting('app.tenant_id', true) = '' OR tenant_id = current_setting('app.tenant_id', true));

-- New measured transition history. Existing stages remain unknown until observed;
-- do not invent creation/start times or reconstruct lost past error counts.
ALTER TABLE flow_video_stages ADD COLUMN observed_since TIMESTAMPTZ;
ALTER TABLE flow_video_stages ADD COLUMN queued_at TIMESTAMPTZ;
ALTER TABLE flow_video_stages ADD COLUMN first_started_at TIMESTAMPTZ;
ALTER TABLE flow_video_stages ADD COLUMN last_finished_at TIMESTAMPTZ;
ALTER TABLE flow_video_stages ADD COLUMN rate_limit_events BIGINT NOT NULL DEFAULT 0 CHECK(rate_limit_events>=0);
ALTER TABLE flow_video_stages ADD COLUMN auth_required_events BIGINT NOT NULL DEFAULT 0 CHECK(auth_required_events>=0);
ALTER TABLE flow_video_stages ADD COLUMN failure_events BIGINT NOT NULL DEFAULT 0 CHECK(failure_events>=0);
CREATE INDEX flow_video_jobs_metrics_window ON flow_video_jobs(tenant_id,workspace_id,created_at,id);
CREATE INDEX flow_knowledge_units_metrics_window ON flow_knowledge_units(tenant_id,workspace_id,created_at);
CREATE INDEX flow_collection_runs_metrics_window ON flow_collection_runs(tenant_id,workspace_id,created_at);
-- Single-line body is intentional: the host migration parser preserves it.
CREATE FUNCTION flow_video_observe_stage() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE changed BOOLEAN; stamp TIMESTAMPTZ; BEGIN stamp := clock_timestamp(); IF TG_OP='INSERT' THEN NEW.observed_since := stamp; NEW.queued_at := stamp; changed := TRUE; ELSE changed := NEW.state IS DISTINCT FROM OLD.state OR NEW.error IS DISTINCT FROM OLD.error; IF changed THEN NEW.observed_since := coalesce(OLD.observed_since,stamp); END IF; END IF; IF changed THEN IF NEW.error IS NOT NULL AND NEW.state IN ('retry_wait','failed','blocked_auth','blocked_budget','reconciliation_required') THEN NEW.failure_events := NEW.failure_events+1; END IF; IF NEW.state='running' THEN NEW.first_started_at := coalesce(NEW.first_started_at,stamp); END IF; IF NEW.state IN ('completed','failed','cancelled') THEN NEW.last_finished_at := stamp; ELSIF NEW.state IN ('running','queued','retry_wait') THEN NEW.last_finished_at := NULL; END IF; IF NEW.state IN ('retry_wait','failed','blocked_auth','reconciliation_required') AND (coalesce(NEW.error->>'code','') IN ('RATE_LIMITED','HTTP_429') OR coalesce(NEW.error->>'status','')='429') THEN NEW.rate_limit_events := NEW.rate_limit_events+1; END IF; IF NEW.state='blocked_auth' OR (NEW.state IN ('retry_wait','failed','reconciliation_required') AND coalesce(NEW.error->>'code','') IN ('AUTH_REQUIRED','NEEDS_AUTH')) THEN NEW.auth_required_events := NEW.auth_required_events+1; END IF; END IF; RETURN NEW; END $$;
CREATE TRIGGER flow_video_stage_observation BEFORE INSERT OR UPDATE ON flow_video_stages FOR EACH ROW EXECUTE FUNCTION flow_video_observe_stage();

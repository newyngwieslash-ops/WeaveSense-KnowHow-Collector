-- Only normalized responses observed after this migration populate these fields.
-- Local cancellation/terminal status and intent.updated_at are not remote outcome evidence.
ALTER TABLE flow_video_submission_intents ADD COLUMN external_observed_state TEXT CHECK(external_observed_state IN ('pending','completed','failed','reconciliation_required'));
ALTER TABLE flow_video_submission_intents ADD COLUMN external_observed_at TIMESTAMPTZ;

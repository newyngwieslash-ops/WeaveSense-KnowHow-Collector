-- Persist the terminal-parent settlement intent before crossing the host boundary.
-- A retry must not reuse a parent while its close result is in flight/unknown.
ALTER TABLE flow_video_jobs ADD COLUMN budget_closing_at TIMESTAMPTZ;
-- Also retain a same-key recovery path if reserve was accepted but its reply or
-- local receipt write was lost, including a concurrent cancellation.
ALTER TABLE flow_video_jobs ADD COLUMN budget_reserving_at TIMESTAMPTZ;

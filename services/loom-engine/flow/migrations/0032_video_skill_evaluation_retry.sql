-- Retry only an observed terminal model failure. Unknown outcomes retain the
-- original task/idempotency identity and never authorize a duplicate dispatch.
ALTER TABLE flow_video_skill_eval_tasks ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE flow_video_skill_eval_tasks ADD COLUMN attempt_history JSONB NOT NULL DEFAULT '[]';

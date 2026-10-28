ALTER TABLE flow_video_knowledge_runs ADD COLUMN model_generation INTEGER NOT NULL DEFAULT 0 CHECK(model_generation >= 0);
ALTER TABLE flow_video_knowledge_runs ADD COLUMN external_task_status TEXT;
ALTER TABLE flow_video_knowledge_runs ADD COLUMN model_attempt_history JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(model_attempt_history) = 'array');
UPDATE flow_video_knowledge_runs SET external_task_status='failed' WHERE state='failed' AND error='model_failed' AND external_task_id IS NOT NULL;

-- Phase B (B1.3): let async jobs (notably space.consolidate_topic_candidates)
-- report progress so the UI can poll a job and show a progress bar instead of
-- blocking on a synchronous response. Stored as jsonb so we can carry
-- { done, total, stage } without a rigid column set.
ALTER TABLE jobs ADD COLUMN progress jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Rollback:
-- ALTER TABLE jobs DROP COLUMN progress;

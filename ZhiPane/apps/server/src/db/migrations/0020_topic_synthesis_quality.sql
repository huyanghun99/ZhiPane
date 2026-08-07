ALTER TYPE topic_status ADD VALUE IF NOT EXISTS 'synthesis_failed';
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS synthesis_status text NOT NULL DEFAULT 'ready';
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS quality_issues jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS synthesis_diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Phase 4: refresh / merge / split support.
-- Pure additive changes (new columns + a new audit table) so the migration is
-- reversible and lossless against existing data.

-- wiki_topics: merge redirect stub fields.
ALTER TABLE wiki_topics
  ADD COLUMN IF NOT EXISTS merged_into_topic_id uuid REFERENCES wiki_topics(id) ON DELETE SET NULL;
ALTER TABLE wiki_topics
  ADD COLUMN IF NOT EXISTS merged_at timestamptz;
ALTER TABLE wiki_topics
  ADD COLUMN IF NOT EXISTS merged_by_id uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_topics_merged_into ON wiki_topics(merged_into_topic_id);

-- topic_operations: audit ledger for reversible merge / split operations.
CREATE TABLE IF NOT EXISTS topic_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  operation_type text NOT NULL CHECK (operation_type IN ('merge', 'split')),
  topic_id uuid REFERENCES wiki_topics(id) ON DELETE CASCADE,
  target_topic_id uuid REFERENCES wiki_topics(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by_id uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_topic_ops_scope ON topic_operations(workspace_id, space_id);
CREATE INDEX IF NOT EXISTS idx_topic_ops_topic ON topic_operations(topic_id);

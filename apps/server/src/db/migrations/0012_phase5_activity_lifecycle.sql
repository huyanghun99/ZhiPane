-- Phase 5: activity events / stats + lifecycle support.
-- Pure additive (two new tables + enums). Reversible via DROP.

DO $$ BEGIN
  CREATE TYPE activity_entity_type AS ENUM ('topic', 'page');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE activity_event_type AS ENUM (
    'edit', 'view', 'search_click', 'rag_citation', 'citation_open', 'added_to_source', 'project_reference'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS knowledge_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  entity_type activity_entity_type NOT NULL,
  entity_id uuid NOT NULL,
  event_type activity_event_type NOT NULL,
  user_id uuid REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_scope ON knowledge_activity_events(workspace_id, space_id);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON knowledge_activity_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_occurred ON knowledge_activity_events(occurred_at);

CREATE TABLE IF NOT EXISTS knowledge_activity_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  entity_type activity_entity_type NOT NULL,
  entity_id uuid NOT NULL,
  last_edited_at timestamptz,
  last_viewed_at timestamptz,
  last_retrieved_at timestamptz,
  last_linked_at timestamptz,
  last_meaningful_activity_at timestamptz,
  views_30d integer NOT NULL DEFAULT 0,
  citations_30d integer NOT NULL DEFAULT 0,
  rag_citations_30d integer NOT NULL DEFAULT 0,
  active_users_30d integer NOT NULL DEFAULT 0,
  activity_score integer NOT NULL DEFAULT 0,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_activity_stats_scope ON knowledge_activity_stats(workspace_id, space_id);

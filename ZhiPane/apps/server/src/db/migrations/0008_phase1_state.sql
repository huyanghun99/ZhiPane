-- Phase 1: Space kind/lifecycle + Topic three-dimension status.
-- Compatible migration: the legacy single `status` columns on spaces/wiki_topics
-- are PRESERVED for one release cycle; new orthogonal axes are added and
-- backfilled. No columns are dropped or renamed, so existing data is lossless.

-- 1) Enum types (idempotent — CREATE TYPE has no IF NOT EXISTS pre-PG14).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'space_kind') THEN
    CREATE TYPE space_kind AS ENUM ('project', 'area', 'resource', 'inbox');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'space_lifecycle_status') THEN
    CREATE TYPE space_lifecycle_status AS ENUM ('active', 'on_hold', 'completed', 'archived');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'topic_publication_status') THEN
    CREATE TYPE topic_publication_status AS ENUM ('suggested', 'draft', 'accepted', 'user_edited');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'topic_freshness_status') THEN
    CREATE TYPE topic_freshness_status AS ENUM ('fresh', 'stale', 'refresh_failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'topic_lifecycle_status') THEN
    CREATE TYPE topic_lifecycle_status AS ENUM ('active', 'cooling', 'dormant', 'archived');
  END IF;
END$$;

-- 2) Spaces: kind / lifecycle / dates / archive policy.
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS space_kind space_kind NOT NULL DEFAULT 'area';
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS lifecycle_status space_lifecycle_status NOT NULL DEFAULT 'active';
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS target_end_at TIMESTAMPTZ;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS archive_policy JSONB NOT NULL DEFAULT '{"mode":"manual","inactiveDays":180,"completedGraceDays":30}'::jsonb;

-- 3) Wiki topics: three-dimension status + supporting columns.
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS publication_status topic_publication_status NOT NULL DEFAULT 'suggested';
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS freshness_status topic_freshness_status NOT NULL DEFAULT 'fresh';
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS lifecycle_status topic_lifecycle_status NOT NULL DEFAULT 'active';
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS last_meaningful_activity_at TIMESTAMPTZ;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS inactive_since TIMESTAMPTZ;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS archive_candidate_at TIMESTAMPTZ;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS archived_by_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS archive_reason TEXT;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS keep_active_until TIMESTAMPTZ;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS promoted_from_topic_id UUID;
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS origin_space_id UUID REFERENCES spaces(id) ON DELETE SET NULL;

-- 4) Backfill existing rows from the legacy single `status` column. The old
--    `status` is kept; these axes make stale/archived independently expressible.
UPDATE wiki_topics SET
  publication_status = CASE status
    WHEN 'suggested' THEN 'suggested'::topic_publication_status
    WHEN 'user_edited' THEN 'user_edited'::topic_publication_status
    ELSE 'accepted'::topic_publication_status END,
  freshness_status = CASE WHEN status = 'stale' THEN 'stale'::topic_freshness_status ELSE 'fresh'::topic_freshness_status END,
  lifecycle_status = CASE WHEN status = 'archived' THEN 'archived'::topic_lifecycle_status ELSE 'active'::topic_lifecycle_status END;

-- 5) Indexes for Active/Completed/Archived queries.
CREATE INDEX IF NOT EXISTS idx_spaces_lifecycle ON spaces(workspace_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_topics_lifecycle ON wiki_topics(space_id, lifecycle_status);

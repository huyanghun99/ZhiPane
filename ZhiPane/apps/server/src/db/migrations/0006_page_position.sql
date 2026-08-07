-- Phase 2: lightweight page tree ordering support.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_pages_space_position
  ON pages(space_id, position, updated_at);

-- Phase 0 (task 6): persist Wiki artifact generation failures on the page so
-- they are visible in the UI instead of being silently swallowed.
-- Backward compatible: nullable column, safe to add/rollback.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS wiki_error_message TEXT;

-- Speed up the "show me failed pages in this space" lookup.
CREATE INDEX IF NOT EXISTS idx_pages_wiki_error ON pages(space_id, updated_at DESC)
  WHERE wiki_error_message IS NOT NULL;

-- Phase 2 (D2): Candidate ↔ Topic decoupling.
-- A processed page now produces *topic_candidates* (each linked to a supporting
-- chunk) instead of directly creating formal wiki_topics. Formal Topics are
-- created later by promotion / Phase 3 clustering, so a single short page never
-- spawns multiple published Topics.
--
-- Purely additive: no existing table/column is altered, so old data is safe.

CREATE TABLE IF NOT EXISTS topic_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_id UUID REFERENCES document_chunks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'promoted', 'dismissed')),
  promoted_topic_id UUID REFERENCES wiki_topics(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidates_scope ON topic_candidates(workspace_id, space_id);
CREATE INDEX IF NOT EXISTS idx_candidates_page ON topic_candidates(page_id);
CREATE INDEX IF NOT EXISTS idx_candidates_chunk ON topic_candidates(chunk_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON topic_candidates(status);

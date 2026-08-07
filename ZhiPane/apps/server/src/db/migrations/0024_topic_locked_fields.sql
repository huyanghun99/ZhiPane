-- P0-5 (LLM wiki优化.md): user-locked fields must NOT be overwritten by AI
-- synthesis. locked_fields is a text array with values like 'definition',
-- 'overview', 'keyPoints'. When set, the AI refresh path must preserve the
-- user-pinned versions of those fields (see applySynthesisRespectingLocks
-- in wiki.service.ts). The check is enforced at the persistence boundary
-- rather than in evaluateSynthesisQuality because it depends on the
-- existing Topic row, not the synthesis alone.
ALTER TABLE wiki_topics
  ADD COLUMN IF NOT EXISTS locked_fields TEXT[] NOT NULL DEFAULT '{}';

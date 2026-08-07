-- Phase B (B1.1 + B2.3).
-- 1) topic_synonyms: alias normalisation so "机器学习" / "ML" / "机器智能"
--    cluster into one Topic instead of many near-duplicates.
-- 2) Soft-delete columns on wiki_topics (a delete == archive with reason
--    'deleted', so it stays auditable + recoverable; never hard-deleted).
-- All additive / reversible.

CREATE TABLE IF NOT EXISTS topic_synonyms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  normalized_term text NOT NULL,
  canonical_term text NOT NULL,
  added_by_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A global (workspace_id IS NULL) synonym term is unique; a per-workspace term
-- is unique within that workspace. NULLs in btree unique are distinct, so we
-- split the two cases into partial unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_synonyms_global ON topic_synonyms(normalized_term) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uidx_synonyms_ws ON topic_synonyms(workspace_id, normalized_term) WHERE workspace_id IS NOT NULL;

ALTER TABLE wiki_topics
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_id uuid REFERENCES users(id);

-- Seed common CN/EN synonym pairs as global defaults (workspace_id = NULL).
-- canonical_term is already normalized (lowercase, no spaces/punctuation).
INSERT INTO topic_synonyms (workspace_id, normalized_term, canonical_term) VALUES
  (NULL, 'ml',            'machinelearning'),
  (NULL, '机器学习',       'machinelearning'),
  (NULL, '机器智能',       'machinelearning'),
  (NULL, 'ai',            'artificialintelligence'),
  (NULL, '人工智能',       'artificialintelligence'),
  (NULL, 'db',            'database'),
  (NULL, '数据库',         'database'),
  (NULL, 'nlp',           'naturallanguageprocessing'),
  (NULL, '自然语言处理',    'naturallanguageprocessing'),
  (NULL, 'mlops',         'machinelearningops'),
  (NULL, '深度學習',        'deeplearning'),
  (NULL, '深度学习',       'deeplearning')
ON CONFLICT DO NOTHING;

ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS evidence_centroid vector(1536);
ALTER TABLE wiki_topics ADD COLUMN IF NOT EXISTS evidence_count integer NOT NULL DEFAULT 0;

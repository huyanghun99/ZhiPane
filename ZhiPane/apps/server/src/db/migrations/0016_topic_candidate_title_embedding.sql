-- Phase B (B1.2): persist each candidate's title embedding so clustering can be
-- embedding-dominated instead of relying only on normalized-title exact grouping
-- + chunk term-overlap. The embedding is computed once during page indexing
-- (generateWikiArtifacts) and reused here, avoiding a recompute per consolidate.
ALTER TABLE topic_candidates ADD COLUMN title_embedding vector(1536);

-- Rollback:
-- ALTER TABLE topic_candidates DROP COLUMN title_embedding;

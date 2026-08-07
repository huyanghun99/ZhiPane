-- Phase 3 (D3 / D5): TopicSynthesis storage + Chunk-level source provenance.
-- Pure additive changes; old rows keep aliases='{}', normalized_title=NULL,
-- synthesis_version default, and topic_sources new columns take their defaults.
-- Rollback: DROP COLUMN statements below + delete this migration row.

ALTER TABLE wiki_topics ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';
ALTER TABLE wiki_topics ADD COLUMN normalized_title text;
ALTER TABLE wiki_topics ADD COLUMN synthesis_version text NOT NULL DEFAULT 'topic-synthesis-v1';

ALTER TABLE topic_sources ADD COLUMN source_content_version integer;
ALTER TABLE topic_sources ADD COLUMN source_type text NOT NULL DEFAULT 'page';
ALTER TABLE topic_sources ADD COLUMN relevance_score integer;
ALTER TABLE topic_sources ADD COLUMN evidence_excerpt text;
ALTER TABLE topic_sources ADD COLUMN added_by text NOT NULL DEFAULT 'ai';
ALTER TABLE topic_sources ADD COLUMN contribution_type text;

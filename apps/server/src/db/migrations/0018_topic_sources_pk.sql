-- Phase H (S4): upgrade topic_sources primary key so multiple chunks per
-- (topic_id, page_id) can coexist (chunk-level provenance). Previously the
-- PK was (topic_id, page_id), so onConflictDoNothing silently dropped any
-- second chunk -> RAG traceability degraded to page-level.
--
-- Strategy:
--   1. Add a surrogate `id` uuid PK.
--   2. Drop the old (topic_id, page_id) primary key constraint.
--   3. Add two partial unique indexes to preserve dedupe semantics:
--      - chunk_id IS NULL     -> one page-level source per (topic_id, page_id)
--      - chunk_id IS NOT NULL -> one chunk-level source per (topic_id, page_id, chunk_id)
--      Postgres ON CONFLICT DO NOTHING (no target) matches the right partial
--      index automatically, so all existing .onConflictDoNothing() calls
--      in the codebase keep working unchanged.
--   4. Backfill: nothing to do. Existing rows keep their (topic_id, page_id,
--      chunk_id) values; rows that previously collided under the old PK were
--      already dropped by onConflictDoNothing, so no duplicate repair needed.
--
-- Rollback:
--   DROP INDEX IF EXISTS uidx_topic_sources_chunk;
--   DROP INDEX IF EXISTS uidx_topic_sources_page;
--   ALTER TABLE topic_sources DROP CONSTRAINT topic_sources_pkey;
--   ALTER TABLE topic_sources DROP COLUMN id;
--   ALTER TABLE topic_sources ADD PRIMARY KEY (topic_id, page_id);

-- Step 1: add surrogate id column WITHOUT PK (table already has a composite
-- PK; adding a second PK in one statement fails with "multiple primary keys").
-- gen_random_uuid() is available in PG 13+ (and we are on pgvector/pg16).
ALTER TABLE topic_sources ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();

-- Step 2: drop the old composite PK. The constraint name is the PG default
-- (<table>_pkey). IF EXISTS keeps the migration idempotent.
ALTER TABLE topic_sources DROP CONSTRAINT IF EXISTS topic_sources_pkey;

-- Step 2b: now promote id to PK (only one PK per table allowed).
ALTER TABLE topic_sources ADD CONSTRAINT topic_sources_pkey PRIMARY KEY (id);

-- Step 3: create the two partial unique indexes. IF NOT EXISTS so re-running
-- the migration is safe.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_topic_sources_page
  ON topic_sources (topic_id, page_id)
  WHERE chunk_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_topic_sources_chunk
  ON topic_sources (topic_id, page_id, chunk_id)
  WHERE chunk_id IS NOT NULL;

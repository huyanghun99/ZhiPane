CREATE TABLE IF NOT EXISTS page_knowledge_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_version integer NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  map_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text NOT NULL DEFAULT '',
  source_chunk_count integer NOT NULL DEFAULT 0,
  model text NOT NULL DEFAULT 'deterministic-v1',
  prompt_version text NOT NULL DEFAULT 'page-map-v1',
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(page_id, content_version)
);
CREATE INDEX IF NOT EXISTS idx_page_knowledge_maps_scope ON page_knowledge_maps(workspace_id, space_id, page_id);
CREATE TABLE IF NOT EXISTS knowledge_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  knowledge_map_id uuid NOT NULL REFERENCES page_knowledge_maps(id) ON DELETE CASCADE,
  section_anchor text NOT NULL DEFAULT '',
  text text NOT NULL,
  normalized_text text NOT NULL,
  kind text NOT NULL DEFAULT 'claim',
  confidence real NOT NULL DEFAULT 0.5,
  status text NOT NULL DEFAULT 'generated',
  content_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(page_id, content_version, normalized_text)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_claims_scope ON knowledge_claims(workspace_id, space_id, page_id);
CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id uuid NOT NULL REFERENCES knowledge_claims(id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  excerpt text NOT NULL DEFAULT '',
  relevance_score real NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(claim_id, chunk_id)
);

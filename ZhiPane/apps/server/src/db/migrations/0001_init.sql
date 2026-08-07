CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE space_role AS ENUM ('admin', 'writer', 'reader');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE page_status AS ENUM ('normal', 'archived', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE llm_process_status AS ENUM ('pending', 'processing', 'processed', 'failed', 'ignored');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE topic_status AS ENUM ('suggested', 'accepted', 'user_edited', 'stale', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE suggestion_status AS ENUM ('pending', 'accepted', 'ignored', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE suggestion_risk AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE space_ai_privacy_policy AS ENUM ('inherit_workspace', 'cloud_allowed', 'local_only', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE ai_config_scope AS ENUM ('workspace', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_instance_owner BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  embedding_dimension INT NOT NULL DEFAULT 1536,
  embedding_model TEXT NOT NULL DEFAULT 'mock-embedding',
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role workspace_role NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  ai_privacy_policy space_ai_privacy_policy NOT NULL DEFAULT 'inherit_workspace',
  auto_llm_processing BOOLEAN NOT NULL DEFAULT TRUE,
  update_policy TEXT NOT NULL DEFAULT 'balanced',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_spaces_workspace ON spaces(workspace_id);

CREATE TABLE IF NOT EXISTS space_members (
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  role space_role NOT NULL DEFAULT 'reader',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR group_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);
CREATE INDEX IF NOT EXISTS idx_space_members_group ON space_members(group_id);

CREATE TABLE IF NOT EXISTS pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_page_id UUID REFERENCES pages(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content_json JSONB NOT NULL DEFAULT '{"type":"doc","content":[]}',
  text_content TEXT NOT NULL DEFAULT '',
  fts_tokens TEXT NOT NULL DEFAULT '',
  content_version INT NOT NULL DEFAULT 1,
  status page_status NOT NULL DEFAULT 'normal',
  llm_process_status llm_process_status NOT NULL DEFAULT 'pending',
  llm_dirty_reason TEXT,
  llm_processed_at TIMESTAMPTZ,
  created_by_id UUID NOT NULL REFERENCES users(id),
  updated_by_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pages_scope ON pages(workspace_id, space_id, status);
CREATE INDEX IF NOT EXISTS idx_pages_llm_inbox ON pages(workspace_id, space_id, llm_process_status);
CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_page_id);
CREATE INDEX IF NOT EXISTS idx_pages_fts ON pages USING GIN (to_tsvector('simple', fts_tokens));

CREATE TABLE IF NOT EXISTS page_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_version INT NOT NULL,
  title TEXT NOT NULL,
  content_json JSONB NOT NULL,
  text_content TEXT NOT NULL,
  created_by_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_id, content_version)
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
  topic_id UUID,
  chunk_index INT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  fts_tokens TEXT NOT NULL DEFAULT '',
  embedding vector(1536),
  embedding_model TEXT NOT NULL DEFAULT 'mock-embedding',
  embedding_dimension INT NOT NULL DEFAULT 1536,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chunks_scope ON document_chunks(workspace_id, space_id);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON document_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON document_chunks USING GIN (to_tsvector('simple', fts_tokens));
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw ON document_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS page_ai_profiles (
  page_id UUID PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  space_id UUID NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]',
  keywords JSONB NOT NULL DEFAULT '[]',
  entities JSONB NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT 'mock',
  prompt_version TEXT NOT NULL DEFAULT 'v1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wiki_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content_json JSONB NOT NULL DEFAULT '{"type":"doc","content":[]}',
  text_content TEXT NOT NULL DEFAULT '',
  status topic_status NOT NULL DEFAULT 'suggested',
  source TEXT NOT NULL DEFAULT 'ai_generated',
  ai_summary TEXT NOT NULL DEFAULT '',
  ai_version TEXT NOT NULL DEFAULT 'v1',
  user_edited_at TIMESTAMPTZ,
  last_ai_refresh_at TIMESTAMPTZ,
  update_policy TEXT NOT NULL DEFAULT 'suggest_only',
  created_by_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_topics_scope_status ON wiki_topics(workspace_id, space_id, status);

CREATE TABLE IF NOT EXISTS topic_sources (
  topic_id UUID NOT NULL REFERENCES wiki_topics(id) ON DELETE CASCADE,
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_id UUID REFERENCES document_chunks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(topic_id, page_id)
);

CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  space_id UUID NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'concept',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, space_id, name)
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  space_id UUID NOT NULL,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  relation_type TEXT NOT NULL,
  confidence INT NOT NULL DEFAULT 50,
  evidence JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'suggested',
  created_by TEXT NOT NULL DEFAULT 'ai',
  user_confirmed_by_id UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_edges_scope_status ON knowledge_edges(workspace_id, space_id, status);
CREATE INDEX IF NOT EXISTS idx_edges_source ON knowledge_edges(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON knowledge_edges(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON knowledge_edges(workspace_id, space_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_edges_evidence_gin ON knowledge_edges USING GIN(evidence);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_edges_active_unique ON knowledge_edges(workspace_id, space_id, source_type, source_id, target_type, target_id, relation_type) WHERE status <> 'deleted';

CREATE TABLE IF NOT EXISTS llm_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  space_id UUID NOT NULL,
  page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES wiki_topics(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  risk suggestion_risk NOT NULL DEFAULT 'low',
  status suggestion_status NOT NULL DEFAULT 'pending',
  payload JSONB NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suggestions_scope_status ON llm_suggestions(workspace_id, space_id, status, risk);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  space_id UUID NOT NULL,
  page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES users(id),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INT NOT NULL,
  storage_driver TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope ai_config_scope NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  driver TEXT NOT NULL,
  base_url TEXT,
  completion_model TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimension INT NOT NULL DEFAULT 1536,
  encrypted_api_key TEXT,
  personal_override_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_ai_config_scope ON ai_configs(scope, workspace_id, user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID,
  space_id UUID,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status job_status NOT NULL DEFAULT 'pending',
  priority INT NOT NULL DEFAULT 100,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  error_message TEXT,
  cost_estimate_tokens INT DEFAULT 0,
  actual_prompt_tokens INT DEFAULT 0,
  actual_completion_tokens INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_runner ON jobs(status, run_after, priority);
CREATE INDEX IF NOT EXISTS idx_jobs_scope ON jobs(workspace_id, space_id);

CREATE TABLE IF NOT EXISTS api_rate_limit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID,
  space_id UUID,
  user_id UUID,
  route_key TEXT NOT NULL,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_user_window ON api_rate_limit_events(route_key, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_space_window ON api_rate_limit_events(route_key, space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_cleanup ON api_rate_limit_events(created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings(key, value)
VALUES ('embedding.dimension', '1536'::jsonb)
ON CONFLICT (key) DO NOTHING;

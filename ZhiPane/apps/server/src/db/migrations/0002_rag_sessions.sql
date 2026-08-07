CREATE TABLE IF NOT EXISTS rag_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  space_id UUID,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  citations JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rag_sessions_user ON rag_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rag_sessions_scope ON rag_sessions(workspace_id, space_id);

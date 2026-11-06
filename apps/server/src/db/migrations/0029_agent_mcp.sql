-- Agent / MCP / CalDAV scaffolding.
-- Agent tokens are scoped, revocable, long-lived Bearer credentials. Only the
-- sha256 hash is stored, mirroring the sessions table.

CREATE TABLE IF NOT EXISTS agent_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  expires_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);

CREATE TABLE IF NOT EXISTS agent_audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id      UUID REFERENCES agent_tokens(id) ON DELETE SET NULL,
  user_id       UUID NOT NULL,
  tool          TEXT NOT NULL,
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_audit_created ON agent_audit_logs(created_at DESC);

-- Idempotent writes: an Agent retry with the same key returns the first result.
CREATE TABLE IF NOT EXISTS agent_idempotency (
  key           TEXT NOT NULL,
  token_id      UUID NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
  result        JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, token_id)
);

-- External AI jobs reuse the existing `jobs` table; this table holds the
-- structured result submitted by a desktop agent for auditing/version checks.
CREATE TABLE IF NOT EXISTS agent_job_results (
  job_id        UUID NOT NULL,
  source_version INTEGER,
  prompt_version TEXT,
  result        JSONB NOT NULL,
  submitted_by  UUID REFERENCES agent_tokens(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, source_version)
);

-- CalDAV: map client-supplied UIDs (from PUT) to tasks, and track ETags.
CREATE TABLE IF NOT EXISTS calendar_sync_map (
  uid           TEXT PRIMARY KEY,
  task_id       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL,
  etag          TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_task ON calendar_sync_map(task_id);

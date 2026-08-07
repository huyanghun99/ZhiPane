-- Phase 1: persistent sessions (opaque token) + job dedupe/sourceVersion.

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_version INT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- Only one active (pending/running) job per dedupe_key may exist at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_jobs_dedupe
  ON jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');

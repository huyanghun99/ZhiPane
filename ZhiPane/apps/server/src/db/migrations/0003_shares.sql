CREATE TABLE IF NOT EXISTS shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('page','topic')),
  target_id UUID NOT NULL,
  share_token TEXT NOT NULL UNIQUE,
  share_mode TEXT NOT NULL DEFAULT 'live' CHECK (share_mode IN ('live','snapshot')),
  snapshot_title TEXT,
  snapshot_content_json JSONB,
  snapshot_text_content TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shares_target ON shares(target_type, target_id, is_enabled);

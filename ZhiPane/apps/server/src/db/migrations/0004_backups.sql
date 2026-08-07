CREATE TABLE IF NOT EXISTS backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_id UUID REFERENCES users(id),
  backup_type TEXT NOT NULL DEFAULT 'manual' CHECK (backup_type IN ('manual','auto','pre_migration')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
  storage_key TEXT,
  size_bytes INTEGER,
  include_secrets BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

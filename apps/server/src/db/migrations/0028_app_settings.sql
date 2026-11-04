-- Instance-scoped app settings, e.g. the hour (0-23, server local time) at
-- which the nightly auto-organize (batch AI re-analysis of the day's updated
-- pages) runs.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value)
VALUES ('auto_organize', '{"hour":3}')
ON CONFLICT (key) DO NOTHING;

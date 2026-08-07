-- F6: Add icon column to pages table for custom page icons
ALTER TABLE pages ADD COLUMN IF NOT EXISTS icon text;

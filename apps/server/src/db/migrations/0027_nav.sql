-- Integrate the PersonalNav start-page into ZhiPane.
--
-- PersonalNav was a single-file HTML app storing groups + links in
-- localStorage. We lift that into Postgres so the data is unified with the
-- rest of ZhiPane (workspace-scoped) and the search engine is configurable.
--
-- Model:
--   nav_groups         -> categories of bookmarks (one per "分组")
--   nav_links          -> individual bookmark cards
--   nav_search_engines -> selectable search providers for the top bar

CREATE TABLE IF NOT EXISTS nav_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title       text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nav_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid NOT NULL REFERENCES nav_groups(id) ON DELETE CASCADE,
  name          text NOT NULL,
  url           text NOT NULL,
  icon_char     text,
  position      integer NOT NULL DEFAULT 0,
  open_count    integer NOT NULL DEFAULT 0,
  last_opened_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nav_search_engines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  url_template text NOT NULL,           -- contains a single %s placeholder
  is_default   boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_nav_groups_ws ON nav_groups (workspace_id, position);
CREATE INDEX IF NOT EXISTS idx_nav_links_group ON nav_links (group_id, position);
CREATE INDEX IF NOT EXISTS idx_nav_engines_ws ON nav_search_engines (workspace_id);

-- Seed a default Bing engine per workspace on first use is done in the API
-- layer; this migration only sets up the structure.

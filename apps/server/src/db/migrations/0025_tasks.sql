-- Tasks module (ZenithFlow-style GTD): projects, tasks, pomodoro focus sessions.

CREATE TYPE task_status AS ENUM ('inbox', 'today', 'next', 'waiting', 'someday', 'done');
CREATE TYPE task_priority AS ENUM ('none', 'low', 'medium', 'high');
CREATE TYPE recurrence_unit AS ENUM ('day', 'week', 'month', 'year');

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id uuid REFERENCES spaces(id) ON DELETE SET NULL,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#22c55e',
  description text,
  position integer NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_projects_workspace ON projects (workspace_id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id uuid REFERENCES spaces(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  created_by_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  notes text,
  status task_status NOT NULL DEFAULT 'inbox',
  priority task_priority NOT NULL DEFAULT 'none',
  due_date timestamptz,
  start_date timestamptz,
  completed_at timestamptz,
  position integer NOT NULL DEFAULT 0,
  recurrence_unit recurrence_unit,
  recurrence_interval integer,
  focus_seconds integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_scope ON tasks (workspace_id, status);
CREATE INDEX idx_tasks_project ON tasks (project_id);
CREATE INDEX idx_tasks_due ON tasks (due_date);

CREATE TABLE focus_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_seconds integer NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'focus'
);
CREATE INDEX idx_focus_task ON focus_sessions (task_id);

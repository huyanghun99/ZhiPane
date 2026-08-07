-- Extend the tasks module to full ZenithFlow parity.
--
-- Adds the scheduling / planning fields the ZenithFlow calendar, gantt and
-- multi-session views rely on. `today` and `priority` are intentionally kept
-- (ZhiPane extensions on top of the ZenithFlow model).

-- ZenithFlow schedules tasks onto the calendar with a dedicated status.
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'scheduled';

ALTER TABLE tasks
  -- 0-100 completion used by the gantt progress bar and task card meter.
  ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0,
  -- Minutes; drives calendar block height and gantt weighted progress.
  ADD COLUMN IF NOT EXISTS estimated_duration integer NOT NULL DEFAULT 0,
  -- GTD context tag, e.g. "@computer".
  ADD COLUMN IF NOT EXISTS context text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS dependencies uuid[] NOT NULL DEFAULT '{}',
  -- End of the scheduled block (start_date already exists).
  ADD COLUMN IF NOT EXISTS end_date timestamptz,
  ADD COLUMN IF NOT EXISTS is_all_day boolean NOT NULL DEFAULT false,
  -- Multi-session execution: child sessions point at the originating task.
  ADD COLUMN IF NOT EXISTS parent_task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS recurrence_end_date timestamptz;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_progress_range CHECK (progress >= 0 AND progress <= 100);

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id);
-- Calendar / gantt range scans query by scheduled window.
CREATE INDEX IF NOT EXISTS idx_tasks_range ON tasks (workspace_id, start_date, end_date);

import { Fragment, useMemo } from 'react';
import type { Task, Project } from '../api';
import { addDays, differenceInDays, format, isAfter, isBefore, startOfDay } from '../dateUtils';

interface GanttViewProps {
  tasks: Task[];
  projects: Project[];
  onSelectTask: (task: Task) => void;
  rangeStart: Date;
  rangeEnd: Date;
  selectedTaskId?: string | null;
}

const WEEK_DAYS = ['日', '一', '二', '三', '四', '五', '六'];
const CELL_WIDTH = 64;
const ROW_HEIGHT = 52;
const HEADER_HEIGHT = 60;

interface ConsolidatedTask {
  id: string;
  title: string;
  projectId: string | null;
  startDate?: Date;
  endDate?: Date;
  progress: number;
  status: 'done' | 'active';
  sessions: Task[];
}

export function GanttView({
  tasks, projects, onSelectTask, rangeStart, rangeEnd, selectedTaskId
}: GanttViewProps) {
  const START = startOfDay(rangeStart);
  const DAYS = Math.max(1, differenceInDays(rangeEnd, rangeStart) + 1);

  // Collapse multi-session tasks into a single bar spanning all their sessions.
  const consolidated = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = task.parentTaskId || task.id;
      const list = groups.get(key);
      if (list) list.push(task);
      else groups.set(key, [task]);
    }

    return [...groups.entries()]
      .map(([id, sessions]) => {
        const parent = sessions.find((s) => s.id === id) ?? sessions[0];
        const starts = sessions.map((s) => s.startDate).filter(Boolean).map((d) => new Date(d!).getTime());
        const ends = sessions.map((s) => s.endDate).filter(Boolean).map((d) => new Date(d!).getTime());

        // Progress is weighted by each session's estimated duration.
        let total = 0;
        let weighted = 0;
        for (const s of sessions) {
          const d = s.estimatedDuration || 1;
          total += d;
          weighted += (s.progress || 0) * d;
        }

        return {
          id,
          title: parent.title,
          projectId: parent.projectId,
          startDate: starts.length ? new Date(Math.min(...starts)) : undefined,
          endDate: ends.length ? new Date(Math.max(...ends)) : undefined,
          progress: total > 0 ? weighted / total : 0,
          status: sessions.every((s) => s.status === 'done') ? 'done' : 'active',
          sessions
        } as ConsolidatedTask;
      })
      .sort((a, b) => {
        if (!a.startDate) return 1;
        if (!b.startDate) return -1;
        return a.startDate.getTime() - b.startDate.getTime();
      });
  }, [tasks]);

  const projectGroups = useMemo(() => {
    const grouped: Record<string, ConsolidatedTask[]> = {};
    for (const p of projects) if (!p.archived) grouped[p.id] = [];
    grouped.none = [];
    for (const t of consolidated) {
      const pid = t.projectId && grouped[t.projectId] ? t.projectId : 'none';
      grouped[pid].push(t);
    }
    return grouped;
  }, [consolidated, projects]);

  const renderRow = (task: ConsolidatedTask) => {
    const start = task.startDate ? startOfDay(task.startDate) : null;
    const end = task.endDate ? startOfDay(task.endDate) : start ? addDays(start, 1) : null;

    // Skip bars entirely outside the visible window.
    if (start && end && (isBefore(end, START) || isAfter(start, addDays(START, DAYS)))) return null;

    const project = projects.find((p) => p.id === task.projectId);
    const color = project?.color || 'var(--muted)';
    const left = start ? differenceInDays(start, START) * CELL_WIDTH : 0;
    const width = start && end ? Math.max(1, differenceInDays(end, start)) * CELL_WIDTH : CELL_WIDTH;

    return (
      <div
        key={task.id}
        className={`gantt-row${selectedTaskId === task.id ? ' is-selected' : ''}`}
        style={{ height: ROW_HEIGHT }}
      >
        <div className="gantt-row-label" onClick={() => onSelectTask(task.sessions[0])}>
          <span className="gantt-row-title">{task.title}</span>
          {task.sessions.length > 1 && (
            <span className="gantt-sessions">{task.sessions.length} 段</span>
          )}
        </div>

        <div className="gantt-row-track">
          {start ? (
            <div
              className="gantt-bar"
              style={{
                left: Math.max(0, left),
                width: Math.max(32, width),
                background: `color-mix(in srgb, ${color} 28%, transparent)`,
                borderLeftColor: color,
                opacity: task.status === 'done' ? 0.4 : 1
              }}
              onClick={() => onSelectTask(task.sessions[0])}
            >
              <div className="gantt-bar-fill" style={{ width: `${task.progress}%` }} />
              <span className="gantt-bar-text">
                {task.status === 'done' ? '✓ 已完成' : `${Math.round(task.progress)}%`}
              </span>
            </div>
          ) : (
            <span className="gantt-unscheduled">未排期</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="gantt-view">
      <div className="gantt-inner">
        <div className="gantt-head" style={{ height: HEADER_HEIGHT }}>
          <div className="gantt-head-label">路线图</div>
          <div className="gantt-head-days">
            {Array.from({ length: DAYS }, (_, i) => {
              const d = addDays(START, i);
              const isWeekend = d.getDay() === 0 || d.getDay() === 6;
              const isToday = differenceInDays(d, new Date()) === 0;
              return (
                <div
                  key={i}
                  className={`gantt-head-day${isWeekend ? ' is-weekend' : ''}`}
                  style={{ width: CELL_WIDTH }}
                >
                  <span className="gantt-head-dow">{WEEK_DAYS[d.getDay()]}</span>
                  <span className={`gantt-head-date${isToday ? ' is-today' : ''}`}>{format(d, 'd')}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="gantt-body">
          {Object.entries(projectGroups).map(([pid, rows]) => {
            if (rows.length === 0 && pid === 'none') return null;
            const project = projects.find((p) => p.id === pid);
            return (
              <Fragment key={pid}>
                <div className="gantt-group">
                  <div className="gantt-group-label">
                    <span className="gantt-group-dot" style={{ background: project?.color || 'var(--muted)' }} />
                    <span>{project?.name || '收件箱与其他'}</span>
                  </div>
                </div>
                {rows.length === 0 ? (
                  <div className="gantt-row" style={{ height: ROW_HEIGHT }}>
                    <div className="gantt-row-label is-empty">暂无任务</div>
                    <div className="gantt-row-track" />
                  </div>
                ) : (
                  rows.map(renderRow)
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

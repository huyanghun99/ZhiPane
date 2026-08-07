import { useMemo, useState, useEffect, useRef } from 'react';
import { Check, Circle } from 'lucide-react';
import type { Task, Project, CalendarMode } from '../api';
import {
  format, addDays, startOfDay, startOfWeek, startOfMonth, endOfMonth, endOfWeek,
  eachDayOfInterval, isSameDay, isSameMonth
} from '../dateUtils';

interface CalendarViewProps {
  tasks: Task[];
  projects: Project[];
  onTaskUpdate: (taskId: string, updates: Partial<Task>) => void;
  onSelectTask: (task: Task) => void;
  onAddTask: (title: string, overrides: Partial<Task>) => void;
  onDuplicateTask: (id: string, overrides: Partial<Task>) => void;
  date: Date;
  mode: CalendarMode;
  selectedTaskId?: string | null;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const SLOT_HEIGHT = 60;   // px per hour
const SNAP_INTERVAL = 15; // minutes
const WEEK_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** A task occupies the calendar grid when it has a start and is scheduled/done. */
function isPlaced(t: Task) {
  return !!t.startDate && (t.status === 'scheduled' || t.status === 'done');
}

/**
 * Lay overlapping tasks out side by side: greedily pack into columns where each
 * column holds tasks that don't overlap, then split the width between columns.
 */
function calculateOverlap(tasks: Task[], day: Date) {
  const dayTasks = tasks
    .filter((t) => isPlaced(t) && isSameDay(t.startDate!, day))
    .sort((a, b) => new Date(a.startDate!).getTime() - new Date(b.startDate!).getTime());

  const layout: Record<string, { left: string; width: string; zIndex: number }> = {};
  if (dayTasks.length === 0) return layout;

  const columns: Task[][] = [];
  for (const task of dayTasks) {
    const start = new Date(task.startDate!).getTime();
    let placed = false;
    for (const col of columns) {
      const prev = col[col.length - 1];
      const prevEnd = prev.endDate
        ? new Date(prev.endDate).getTime()
        : new Date(prev.startDate!).getTime() + (prev.estimatedDuration || 30) * 60000;
      if (start >= prevEnd) {
        col.push(task);
        placed = true;
        break;
      }
    }
    if (!placed) columns.push([task]);
  }

  columns.forEach((col, i) => {
    for (const task of col) {
      layout[task.id] = {
        left: `${(i / columns.length) * 100}%`,
        width: `${(1 / columns.length) * 100}%`,
        zIndex: i + 10
      };
    }
  });
  return layout;
}

export function CalendarView({
  tasks, projects, onTaskUpdate, onSelectTask, onAddTask, onDuplicateTask, date, mode, selectedTaskId
}: CalendarViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(new Date());

  // Keep the "now" indicator fresh.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const daysToShow = useMemo(() => {
    if (mode === 'day') return [date];
    if (mode === 'week') {
      const start = startOfWeek(date);
      return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }
    return [];
  }, [mode, date]);

  // Open the timeline around the start of the workday.
  useEffect(() => {
    if (scrollRef.current && mode !== 'month') {
      scrollRef.current.scrollTop = 7 * SLOT_HEIGHT;
    }
  }, [mode]);

  // --- drag-to-resize (bottom edge of a block) ---
  const [resizing, setResizing] = useState<{ id: string; startY: number; startH: number } | null>(null);
  const [resizeHeight, setResizeHeight] = useState(0);

  useEffect(() => {
    if (!resizing) return;

    const onMove = (e: MouseEvent) => {
      const raw = resizing.startH + (e.clientY - resizing.startY);
      setResizeHeight(Math.max(SNAP_INTERVAL, Math.round(raw / SNAP_INTERVAL) * SNAP_INTERVAL));
    };
    const onUp = () => {
      const task = tasks.find((t) => t.id === resizing.id);
      if (task?.startDate) {
        const end = new Date(new Date(task.startDate).getTime() + resizeHeight * 60000);
        onTaskUpdate(task.id, { estimatedDuration: resizeHeight, endDate: end.toISOString() });
      }
      setResizing(null);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing, resizeHeight, tasks, onTaskUpdate]);

  const handleDrop = (e: React.DragEvent, day: Date, hour?: number) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('taskId');
    if (!taskId) return;

    const task = tasks.find((t) => t.id === taskId);
    const duration = task?.estimatedDuration || 60;

    let start: Date;
    if (mode === 'month') {
      start = startOfDay(day);
      start.setHours(9, 0, 0, 0);
    } else {
      start = new Date(day);
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      // Preserve where inside the card the user grabbed it.
      const grabOffset = Number(e.dataTransfer.getData('dragOffset') || 0);
      const target = (hour ?? 0) * 60 + (e.clientY - rect.top) - grabOffset;
      const snapped = Math.max(
        0,
        Math.min(1440 - SNAP_INTERVAL, Math.round(target / SNAP_INTERVAL) * SNAP_INTERVAL)
      );
      start.setHours(Math.floor(snapped / 60), snapped % 60, 0, 0);
    }

    const end = new Date(start.getTime() + duration * 60000);
    const patch: Partial<Task> = {
      status: 'scheduled',
      startDate: start.toISOString(),
      endDate: end.toISOString()
    };
    // Ctrl/Cmd-drag copies instead of moving.
    if (e.ctrlKey || e.metaKey) onDuplicateTask(taskId, patch);
    else onTaskUpdate(taskId, { ...patch, progress: 0 });
  };

  const isTodayVisible = daysToShow.some((d) => isSameDay(d, now));
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;

  const renderTimeGrid = () => (
    <div ref={scrollRef} className="cal-scroll">
      <div className="cal-grid-wrap" style={{ height: 24 * SLOT_HEIGHT }}>
        <div className="cal-hours">
          {HOURS.map((hour) => (
            <div
              key={hour}
              className={`cal-hour-row${hour >= 8 && hour <= 18 ? ' is-work' : ''}`}
              style={{
                height: SLOT_HEIGHT,
                gridTemplateColumns: `50px repeat(${daysToShow.length}, 1fr)`
              }}
            >
              <div className={`cal-hour-label${hour >= 8 && hour <= 18 ? ' is-work' : ''}`}>
                {hour !== 0 && `${hour}:00`}
              </div>
              {daysToShow.map((day) => (
                <div
                  key={`${day.toISOString()}-${hour}`}
                  className="cal-slot"
                  onDrop={(e) => handleDrop(e, day, hour)}
                  onDragOver={(e) => e.preventDefault()}
                  onDoubleClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const min = Math.floor((e.clientY - rect.top) / SNAP_INTERVAL) * SNAP_INTERVAL;
                    const start = new Date(day);
                    start.setHours(hour, min, 0, 0);
                    onAddTask('新任务', {
                      status: 'scheduled',
                      startDate: start.toISOString(),
                      endDate: new Date(start.getTime() + 30 * 60000).toISOString(),
                      estimatedDuration: 30
                    });
                  }}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="cal-overlay" style={{ marginLeft: 50 }}>
          <div className="cal-overlay-grid" style={{ gridTemplateColumns: `repeat(${daysToShow.length}, 1fr)` }}>
            {daysToShow.map((day, i) => {
              const layout = calculateOverlap(tasks, day);
              const dayTasks = tasks.filter((t) => isPlaced(t) && isSameDay(t.startDate!, day));
              return (
                <div key={i} className="cal-day-col">
                  {dayTasks.map((task) => {
                    const project = projects.find((p) => p.id === task.projectId);
                    const color = project?.color || 'var(--primary)';
                    const start = new Date(task.startDate!);
                    const top = ((start.getHours() * 60 + start.getMinutes()) / 1440) * 100;
                    const minutes = resizing?.id === task.id ? resizeHeight : task.estimatedDuration || 60;
                    const height = (minutes / 1440) * 100;
                    const pos = layout[task.id] ?? { left: '0%', width: '100%', zIndex: 10 };
                    const isDone = task.status === 'done';

                    return (
                      <div
                        key={task.id}
                        className={[
                          'cal-event',
                          isDone ? 'is-done' : '',
                          resizing?.id === task.id ? 'is-resizing' : '',
                          selectedTaskId === task.id ? 'is-selected' : ''
                        ].filter(Boolean).join(' ')}
                        style={{
                          top: `${top}%`,
                          height: `${height}%`,
                          left: pos.left,
                          width: pos.width,
                          zIndex: pos.zIndex,
                          background: `color-mix(in srgb, ${color} 14%, transparent)`,
                          borderLeftColor: color
                        }}
                        draggable={!resizing}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('taskId', task.id);
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          e.dataTransfer.setData('dragOffset', String(e.clientY - rect.top));
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!resizing) onSelectTask(task);
                        }}
                      >
                        <div className="cal-event-head">
                          <span className="cal-event-title" style={{ color }}>{task.title}</span>
                          <button
                            className="cal-event-toggle"
                            onClick={(e) => {
                              e.stopPropagation();
                              onTaskUpdate(task.id, isDone
                                ? { status: 'scheduled', progress: 0 }
                                : { status: 'done', progress: 100 });
                            }}
                            aria-label={isDone ? '标记为未完成' : '标记为完成'}
                          >
                            {isDone ? <Check size={12} /> : <Circle size={12} style={{ color }} />}
                          </button>
                        </div>
                        {!isDone && resizing?.id !== task.id && (
                          <div
                            className="cal-event-resize"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              const h = task.estimatedDuration || 60;
                              setResizing({ id: task.id, startY: e.clientY, startH: h });
                              setResizeHeight(h);
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {isTodayVisible && (
            <div className="cal-nowline" style={{ top: `${nowTop}%` }}>
              <span className="cal-nowdot" />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderMonthGrid = () => {
    const days = eachDayOfInterval(startOfWeek(startOfMonth(date)), endOfWeek(endOfMonth(date)));
    return (
      <div className="cal-month">
        <div className="cal-month-grid">
          {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
            <div key={d} className="cal-month-dow">{d}</div>
          ))}
          {days.map((day) => {
            const dayTasks = tasks.filter((t) => isPlaced(t) && isSameDay(t.startDate!, day));
            return (
              <div
                key={day.toISOString()}
                className={`cal-month-cell${isSameMonth(day, date) ? '' : ' is-outside'}`}
                onDrop={(e) => handleDrop(e, day)}
                onDragOver={(e) => e.preventDefault()}
                onDoubleClick={() =>
                  onAddTask('新任务', {
                    status: 'scheduled',
                    startDate: startOfDay(day).toISOString(),
                    estimatedDuration: 60
                  })
                }
              >
                <div className={`cal-month-date${isSameDay(day, new Date()) ? ' is-today' : ''}`}>
                  {format(day, 'd')}
                </div>
                <div className="cal-month-events">
                  {dayTasks.map((task) => {
                    const project = projects.find((p) => p.id === task.projectId);
                    const color = project?.color || 'var(--muted)';
                    return (
                      <div
                        key={task.id}
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData('taskId', task.id)}
                        onClick={(e) => { e.stopPropagation(); onSelectTask(task); }}
                        className={`cal-month-event${task.status === 'done' ? ' is-done' : ''}`}
                        style={{
                          background: `color-mix(in srgb, ${color} 14%, transparent)`,
                          borderLeftColor: color
                        }}
                      >
                        {task.title}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="cal-view">
      {mode !== 'month' && (
        <div className="cal-daybar" style={{ paddingLeft: 50 }}>
          {daysToShow.map((day) => (
            <div key={day.toISOString()} className="cal-daybar-cell">
              <div className="cal-daybar-dow">{WEEK_DAYS[day.getDay()]}</div>
              <div className={`cal-daybar-date${isSameDay(day, new Date()) ? ' is-today' : ''}`}>
                {format(day, 'd')}
              </div>
            </div>
          ))}
        </div>
      )}
      {mode === 'month' ? renderMonthGrid() : renderTimeGrid()}
    </div>
  );
}

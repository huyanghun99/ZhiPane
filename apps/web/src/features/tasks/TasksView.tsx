import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Calendar as CalendarIcon, BarChart2 as GanttIcon, Columns as KanbanIcon,
  ChevronLeft, ChevronRight, CalendarDays, Plus
} from 'lucide-react';
import type { MainRoute, Workspace } from '../../types';
import { useToast } from '../../components/Toast';
import {
  GTD_COLUMNS,
  listProjects, createProject, updateProject, deleteProject,
  listTasks, createTask, updateTask, deleteTask, duplicateTask, logFocusSession,
  type Task, type TaskStatus, type Project,
  type ViewMode, type CalendarMode, type FocusKind, type RecurrenceUnit
} from './api';
import { TasksSidebar, type TaskFilter } from './components/TasksSidebar';
import { RightPanel } from './components/RightPanel';
import { KanbanView } from './components/KanbanView';
import { CalendarView } from './components/CalendarView';
import { GanttView } from './components/GanttView';
import { PomodoroTimer } from './components/PomodoroTimer';
import { ConfirmModal } from './components/ConfirmModal';
import { ProjectModal } from './components/ProjectModal';
import {
  addDays, addMonths, startOfDay, endOfDay, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, format
} from './dateUtils';

const RECURRENCE_TO_UNIT: Record<string, RecurrenceUnit> = {
  daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year'
};

/**
 * Ported from ZenithFlow's App.tsx `generateRecurrenceSeries`.
 * When a parent task has recurrence + a start + an end date, spawn the
 * upcoming instances (capped at 100) so the calendar/gantt show them.
 */
function generateRecurrenceSeries(
  parent: Task,
  unit: RecurrenceUnit,
  start: Date,
  recurrenceEndDate: Date
): Partial<Task>[] {
  const series: Partial<Task>[] = [];
  let current = new Date(start);

  const duration =
    parent.endDate && parent.startDate
      ? new Date(parent.endDate).getTime() - new Date(parent.startDate).getTime()
      : (parent.estimatedDuration || 30) * 60 * 1000;

  for (let i = 0; i < 100; i++) {
    if (unit === 'day') current = addDays(current, 1);
    else if (unit === 'week') current = addDays(current, 7);
    else if (unit === 'month') current = addMonths(current, 1);
    else if (unit === 'year') current = addMonths(current, 12);
    else break;

    const checkStart = startOfDay(current);
    const checkEnd = endOfDay(recurrenceEndDate);
    if (checkStart.getTime() > checkEnd.getTime()) break;

    const nextEnd = new Date(current.getTime() + duration);
    series.push({
      title: parent.title,
      notes: parent.notes,
      status: 'scheduled' as TaskStatus,
      projectId: parent.projectId,
      context: parent.context,
      startDate: current.toISOString(),
      endDate: nextEnd.toISOString(),
      estimatedDuration: parent.estimatedDuration,
      isAllDay: parent.isAllDay,
      parentTaskId: parent.id,
      recurrenceUnit: null,
      recurrenceInterval: null,
      recurrenceEndDate: null,
      tags: parent.tags ?? [],
      priority: parent.priority
    });
  }
  return series;
}

export function TasksView({ workspace, onNavigate }: { workspace: Workspace; onNavigate?: (route: MainRoute) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const workspaceId = workspace.id;

  const [view, setView] = useState<ViewMode>('kanban');
  const [filter, setFilter] = useState<TaskFilter>('inbox');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [calendarMode, setCalendarMode] = useState<CalendarMode>('week');
  const [filterStart, setFilterStart] = useState<string>(format(startOfDay(new Date()), 'yyyy-MM-dd'));
  const [filterEnd, setFilterEnd] = useState<string>(format(addDays(new Date(), 14), 'yyyy-MM-dd'));
  const [confirm, setConfirm] = useState<{ open: boolean; title: string; message: string; onConfirm: () => void } | null>(null);
  const [projModal, setProjModal] = useState<{ open: boolean; project: Project | null }>({ open: false, project: null });

  const projectsQ = useQuery({ queryKey: ['tasks-projects', workspaceId], queryFn: listProjects });
  const projects = projectsQ.data?.projects ?? [];

  // Calendar/Gantt need a date-range query; sidebar list uses status/project filter.
  const rangeFrom = useMemo(() => {
    if (view === 'calendar') {
      if (calendarMode === 'month') return startOfMonth(currentDate).toISOString();
      if (calendarMode === 'week') return startOfWeek(currentDate).toISOString();
      return startOfDay(currentDate).toISOString();
    }
    return new Date(filterStart).toISOString();
  }, [view, calendarMode, currentDate, filterStart]);
  const rangeTo = useMemo(() => {
    if (view === 'calendar') {
      if (calendarMode === 'month') return endOfMonth(currentDate).toISOString();
      if (calendarMode === 'week') return endOfWeek(currentDate).toISOString();
      return endOfDay(currentDate).toISOString();
    }
    return endOfDay(new Date(filterEnd)).toISOString();
  }, [view, calendarMode, currentDate, filterEnd]);

  const tasksQ = useQuery({
    queryKey: ['tasks', workspaceId, view, filter, rangeFrom, rangeTo],
    queryFn: () => listTasks({ from: rangeFrom, to: rangeTo })
  });
  const allTasksQ = useQuery({
    queryKey: ['tasks-all', workspaceId],
    queryFn: () => listTasks({})
  });
  const tasks = tasksQ.data?.tasks ?? [];
  // Sidebar / right-panel need the full set (incl. unscheduled) for filtering.
  const allTasks = allTasksQ.data?.tasks ?? tasks;

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['tasks', workspaceId] });
    qc.invalidateQueries({ queryKey: ['tasks-all', workspaceId] });
  }, [qc, workspaceId]);

  const createTaskMut = useMutation({
    mutationFn: (input: Partial<Task>) => createTask({ workspaceId, ...input }),
    onSuccess: () => { invalidate(); },
    onError: (e: Error) => toast.error(`创建失败：${e.message}`)
  });
  const updateTaskMut = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<Task> }) => updateTask(id, input),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(`更新失败：${e.message}`)
  });
  const deleteTaskMut = useMutation({
    mutationFn: (id: string) => deleteTask(id),
    onSuccess: () => { invalidate(); setSelectedTask(null); },
    onError: (e: Error) => toast.error(`删除失败：${e.message}`)
  });
  const duplicateMut = useMutation({
    mutationFn: ({ id, overrides }: { id: string; overrides: Partial<Task> }) => duplicateTask(id, overrides),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(`复制失败：${e.message}`)
  });
  const createProjectMut = useMutation({
    mutationFn: (input: Partial<Project>) => createProject({ workspaceId, ...input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks-projects', workspaceId] }),
    onError: (e: Error) => toast.error(`项目创建失败：${e.message}`)
  });
  const updateProjectMut = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<Project> }) => updateProject(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks-projects', workspaceId] }),
    onError: (e: Error) => toast.error(`项目更新失败：${e.message}`)
  });
  const deleteProjectMut = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks-projects', workspaceId] }),
    onError: (e: Error) => toast.error(`项目删除失败：${e.message}`)
  });

  // --- task handlers ------------------------------------------------------

  const updateTaskHandler = useCallback((id: string, updates: Partial<Task>) => {
    const original = allTasks.find((t) => t.id === id);
    if (!original) { updateTaskMut.mutate({ id, input: updates }); return; }

    const merged = { ...original, ...updates } as Task;
    const isParent = !merged.parentTaskId;

    if (isParent) {
      const recurrenceChanged =
        updates.recurrenceUnit !== undefined || updates.startDate !== undefined ||
        updates.endDate !== undefined || updates.recurrenceEndDate !== undefined ||
        updates.title !== undefined || updates.notes !== undefined ||
        updates.projectId !== undefined || updates.context !== undefined ||
        updates.estimatedDuration !== undefined || updates.tags !== undefined;

      updateTaskMut.mutate({ id, input: updates });

      if (recurrenceChanged && merged.recurrenceUnit != null && merged.startDate && merged.recurrenceEndDate) {
        // Remove existing children then pre-generate the series.
        const childIds = allTasks.filter((t) => t.parentTaskId === id).map((t) => t.id);
        for (const cid of childIds) deleteTaskMut.mutate(cid);
        const series = generateRecurrenceSeries(merged, merged.recurrenceUnit, new Date(merged.startDate), new Date(merged.recurrenceEndDate));
        for (const s of series) createTaskMut.mutate({ parentTaskId: id, ...s });
      }
    } else {
      updateTaskMut.mutate({ id, input: updates });
    }
  }, [allTasks, createTaskMut, deleteTaskMut, updateTaskMut]);

  const addTask = useCallback((title: string, overrides: Partial<Task> = {}) => {
    const status: TaskStatus = (filter as TaskStatus) in GTD_COLUMNS.reduce((a, c) => ({ ...a, [c.key]: 1 }), {})
      ? (filter as TaskStatus)
      : 'inbox';
    const projectId = typeof filter === 'string' && filter.startsWith('p_') ? filter.slice(2) : null;
    createTaskMut.mutate({ title, status, projectId, ...overrides });
  }, [createTaskMut, filter]);

  const addSubtasks = useCallback((subs: Partial<Task>[]) => {
    for (const s of subs) createTaskMut.mutate(s);
  }, [createTaskMut]);

  const toggleStatus = useCallback((task: Task) => {
    const done = task.status === 'done';
    updateTaskHandler(task.id, done
      ? { status: 'inbox', progress: 0, completedAt: null }
      : { status: 'done', progress: 100, completedAt: new Date().toISOString() });
  }, [updateTaskHandler]);

  const deleteTaskHandler = useCallback((id: string) => {
    setConfirm({
      open: true,
      title: '确认删除任务',
      message: '确定要永久删除此任务吗？相关子任务和分段也将移除。',
      onConfirm: () => {
        const childIds = allTasks.filter((t) => t.parentTaskId === id).map((t) => t.id);
        for (const cid of childIds) deleteTaskMut.mutate(cid);
        deleteTaskMut.mutate(id);
      }
    });
  }, [allTasks, deleteTaskMut]);

  const duplicateTaskHandler = useCallback((id: string, overrides: Partial<Task> = {}) => {
    duplicateMut.mutate({ id, overrides });
  }, [duplicateMut]);

  const logSession = useCallback((input: { kind: FocusKind; durationSeconds: number; startedAt: string }) => {
    logFocusSession({ taskId: selectedTask?.id ?? null, ...input }).then(() => {
      if (selectedTask) invalidate();
    }).catch(() => {});
  }, [logFocusSession, selectedTask, invalidate]);

  // --- gantt/calendar range helpers --------------------------------------

  const navItems: { id: ViewMode; label: string; icon: typeof CalendarIcon }[] = [
    { id: 'calendar', label: '日历', icon: CalendarIcon },
    { id: 'gantt', label: '甘特图', icon: GanttIcon },
    { id: 'kanban', label: '看板', icon: KanbanIcon }
  ];

  const handleAutoFitRange = useCallback(() => {
    const scheduled = allTasks.filter((t) => t.startDate && (t.status === 'scheduled' || t.status === 'done'));
    if (scheduled.length === 0) return;
    const times = scheduled.flatMap((t) => {
      const s = new Date(t.startDate!);
      const e = t.endDate ? new Date(t.endDate) : s;
      return [s, e];
    });
    const min = startOfDay(new Date(Math.min(...times.map((d) => d.getTime()))));
    min.setDate(min.getDate() - 1);
    const max = endOfDay(new Date(Math.max(...times.map((d) => d.getTime()))));
    max.setDate(max.getDate() + 2);
    setFilterStart(format(min, 'yyyy-MM-dd'));
    setFilterEnd(format(max, 'yyyy-MM-dd'));
  }, [allTasks]);

  const selectedTaskId = selectedTask?.id ?? null;
  const projectOf = (id: string | null) => projects.find((p) => p.id === id);

  // Keep selected task in sync with the latest server data.
  useEffect(() => {
    if (!selectedTask) return;
    const fresh = allTasks.find((t) => t.id === selectedTask.id);
    if (fresh && fresh !== selectedTask) setSelectedTask(fresh);
  }, [allTasks, selectedTask]);

  if (projectsQ.isLoading || (tasksQ.isLoading && allTasksQ.isLoading)) {
    return (
      <div className="tasks-view">
        <div className="tasks-loading">加载任务中…</div>
      </div>
    );
  }
  if (projectsQ.isError || tasksQ.isError) {
    const msg = (projectsQ.error as Error)?.message ?? (tasksQ.error as Error)?.message ?? '加载失败';
    return (
      <div className="tasks-view">
        <div className="tasks-error">
          <p>任务加载失败：{msg}</p>
          <button className="btn-primary" onClick={() => { projectsQ.refetch(); tasksQ.refetch(); allTasksQ.refetch(); }}>重试</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tasks-view">
      <TasksSidebar
        tasks={allTasks}
        projects={projects}
        filter={filter}
        onFilterChange={setFilter}
        onAddTask={addTask}
        onSelectTask={setSelectedTask}
        onToggleStatus={toggleStatus}
        onAddProject={(name, color) => createProjectMut.mutate({ name, color })}
        onUpdateProject={(id, updates) => updateProjectMut.mutate({ id, input: updates })}
        onDeleteProject={(p) => setConfirm({
          open: true, title: '确认删除项目',
          message: `确定要删除「${p.name}」吗？相关任务将变为未分类。`,
          onConfirm: () => deleteProjectMut.mutate(p.id)
        })}
        selectedTaskId={selectedTaskId}
      />

      <div className="tasks-main">
        <div className="tasks-toolbar">
          <div className="tasks-viewswitch">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>

          <div className="tasks-toolbar-right">
            {view === 'calendar' ? (
              <div className="tasks-calnav">
                <button className="icon-btn" onClick={() => setCurrentDate((d) => addDays(d, calendarMode === 'month' ? -30 : calendarMode === 'week' ? -7 : -1))}>
                  <ChevronLeft size={18} />
                </button>
                <span className="tasks-calnav-label">
                  {format(currentDate, calendarMode === 'month' ? 'yyyy年 MM月' : 'yyyy年 MM月 dd日')}
                </span>
                <button className="icon-btn" onClick={() => setCurrentDate((d) => addDays(d, calendarMode === 'month' ? 30 : calendarMode === 'week' ? 7 : 1))}>
                  <ChevronRight size={18} />
                </button>
                <div className="tasks-mode-switch">
                  {(['day', 'week', 'month'] as CalendarMode[]).map((m) => (
                    <button key={m} className={calendarMode === m ? 'active' : ''} onClick={() => setCalendarMode(m)}>
                      {m === 'day' ? '日' : m === 'week' ? '周' : '月'}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="tasks-rangenav">
                <CalendarDays size={14} />
                <span className="muted">包含无日期任务</span>
                <button className="btn-ghost sm" onClick={handleAutoFitRange}>自动伸缩范围</button>
                <div className="tasks-range-inputs">
                  <input type="date" value={filterStart} onChange={(e) => setFilterStart(e.target.value)} />
                  <span className="muted">至</span>
                  <input type="date" value={filterEnd} onChange={(e) => setFilterEnd(e.target.value)} />
                </div>
              </div>
            )}

            <button className="btn-primary" onClick={() => setProjModal({ open: true, project: null })}>
              <Plus size={14} /> 项目
            </button>
          </div>
        </div>

        <div className="tasks-canvas">
          {view === 'calendar' && (
            <CalendarView
              tasks={tasks}
              projects={projects}
              onTaskUpdate={updateTaskHandler}
              onSelectTask={setSelectedTask}
              onAddTask={addTask}
              onDuplicateTask={duplicateTaskHandler}
              date={currentDate}
              mode={calendarMode}
              selectedTaskId={selectedTaskId}
            />
          )}
          {view === 'gantt' && (
            <GanttView
              tasks={tasks}
              projects={projects}
              onSelectTask={setSelectedTask}
              rangeStart={new Date(filterStart)}
              rangeEnd={new Date(filterEnd)}
              selectedTaskId={selectedTaskId}
            />
          )}
          {view === 'kanban' && (
            <KanbanView
              tasks={filter === 'all' || (filter as string).startsWith('p_') ? allTasks : allTasks}
              projects={projects}
              onTaskUpdate={updateTaskHandler}
              onSelectTask={setSelectedTask}
              onToggleStatus={toggleStatus}
              selectedTaskId={selectedTaskId}
            />
          )}
        </div>
      </div>

      <RightPanel
        task={selectedTask}
        tasks={allTasks}
        projects={projects}
        onUpdateTask={updateTaskHandler}
        onAddTask={addTask}
        onDeleteTask={deleteTaskHandler}
        onAddSubtasks={addSubtasks}
        onSelectTask={setSelectedTask}
      />

      <PomodoroTimer activeTaskId={selectedTaskId} onSessionComplete={logSession} />

      {confirm?.open && (
        <ConfirmModal
          isOpen
          title={confirm.title}
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}

      {projModal.open && (
        <ProjectModal
          isOpen
          project={projModal.project}
          onClose={() => setProjModal({ open: false, project: null })}
          onSave={(name, color) => {
            if (projModal.project) updateProjectMut.mutate({ id: projModal.project.id, input: { name, color } });
            else createProjectMut.mutate({ name, color });
          }}
        />
      )}
    </div>
  );
}

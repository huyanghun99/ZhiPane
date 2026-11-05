import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Calendar as CalendarIcon, BarChart2 as GanttIcon, Columns as KanbanIcon,
  ChevronLeft, ChevronRight, CalendarDays, Plus
} from 'lucide-react';
import type { Workspace } from '../../types';
import { useToast } from '../../components/Toast';
import {
  GTD_COLUMNS,
  listProjects, createProject, updateProject,
  listTasks, createTask, updateTask, deleteTask, duplicateTask, logFocusSession,
  type Task, type TaskStatus, type Project,
  type ViewMode, type CalendarMode, type FocusKind
} from './api';
import type { TaskFilter } from './components/TasksSidebar';
import { RightPanel } from './components/RightPanel';
import { KanbanView } from './components/KanbanView';
import { CalendarView } from './components/CalendarView';
import { GanttView } from './components/GanttView';
import { PomodoroTimer } from './components/PomodoroTimer';
import { ConfirmModal } from './components/ConfirmModal';
import { ProjectModal } from './components/ProjectModal';
import { addDays, format, startOfDay, endOfDay, generateRecurrenceSeries } from './dateUtils';

// Static, render-independent constants — hoisted so they are built once
// instead of on every render.
const GTD_STATUS_KEYS = new Set<string>(GTD_COLUMNS.map((c) => c.key));
const NAV_ITEMS: { id: ViewMode; label: string; icon: typeof CalendarIcon }[] = [
  { id: 'calendar', label: '日历', icon: CalendarIcon },
  { id: 'gantt', label: '甘特图', icon: GanttIcon },
  { id: 'kanban', label: '看板', icon: KanbanIcon }
];

export function TasksView({ workspace, filter, selectedTask, onSelectTask }: {
  workspace: Workspace;
  filter: TaskFilter;
  selectedTask: Task | null;
  onSelectTask: (t: Task | null) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const workspaceId = workspace.id;
  const setSelectedTask = onSelectTask;

  const [view, setView] = useState<ViewMode>('kanban');
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [calendarMode, setCalendarMode] = useState<CalendarMode>('week');
  const [filterStart, setFilterStart] = useState<string>(format(startOfDay(new Date()), 'yyyy-MM-dd'));
  const [filterEnd, setFilterEnd] = useState<string>(format(addDays(new Date(), 14), 'yyyy-MM-dd'));
  const [confirm, setConfirm] = useState<{ open: boolean; title: string; message: string; onConfirm: () => void } | null>(null);
  const [projModal, setProjModal] = useState<{ open: boolean; project: Project | null }>({ open: false, project: null });

  const projectsQ = useQuery({ queryKey: ['tasks-projects', workspaceId], queryFn: listProjects });
  const projects = projectsQ.data?.projects ?? [];

  // All tasks are loaded once; the kanban / calendar / gantt views render the
  // full set so every status and date stays visible (R3-2). The sidebar filter
  // only drives the rail's own selection, not the workbench data.
  const allTasksQ = useQuery({
    queryKey: ['tasks-all', workspaceId],
    queryFn: () => listTasks({})
  });
  const allTasks = allTasksQ.data?.tasks ?? [];

  const invalidate = useCallback(() => {
    // Only ['tasks-all', workspaceId] exists as a query; invalidating a
    // non-existent ['tasks', workspaceId] key was a no-op.
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
  // --- task handlers ------------------------------------------------------

  const updateTaskHandler = useCallback((id: string, updates: Partial<Task>) => {
    const original = allTasks.find((t) => t.id === id);
    if (!original) { updateTaskMut.mutate({ id, input: updates }); return; }

    const merged = { ...original, ...updates } as Task;
    const isParent = !merged.parentTaskId;

    // Keep the original trigger set: title/notes/tags are copied onto every
    // generated child, so those edits must rebuild the series too. Narrowing
    // it would silently drop the child-field sync behaviour.
    const recurrenceChanged = isParent && (
      updates.recurrenceUnit !== undefined || updates.startDate !== undefined ||
      updates.endDate !== undefined || updates.recurrenceEndDate !== undefined ||
      updates.title !== undefined || updates.notes !== undefined ||
      updates.projectId !== undefined || updates.context !== undefined ||
      updates.estimatedDuration !== undefined || updates.tags !== undefined
    );

    if (recurrenceChanged &&
        merged.recurrenceUnit != null && merged.startDate && merged.recurrenceEndDate) {
      const unit = merged.recurrenceUnit;
      const start = new Date(merged.startDate);
      const end = new Date(merged.recurrenceEndDate);
      const childIds = allTasks.filter((t) => t.parentTaskId === id).map((t) => t.id);
      const series = generateRecurrenceSeries(merged, unit, start, end);

      // Persist the parent first, then replace the child series sequentially.
      // Raw API calls (instead of the mutations) avoid one cache invalidation
      // per child — a 100-instance series used to fire ~200 refetches. One
      // invalidate() at the end keeps the UI aligned with the server, and any
      // failure is surfaced instead of leaving silent orphan data.
      void (async () => {
        try {
          await updateTask(id, updates);
          for (const cid of childIds) await deleteTask(cid);
          for (const s of series) await createTask({ workspaceId, ...s });
        } catch (e) {
          toast.error(`循环任务序列更新失败：${(e as Error).message}`);
        } finally {
          invalidate();
        }
      })();
      return;
    }

    updateTaskMut.mutate({ id, input: updates });
  }, [allTasks, updateTaskMut, workspaceId, invalidate, toast]);

  const addTask = useCallback((title: string, overrides: Partial<Task> = {}) => {
    const status: TaskStatus = GTD_STATUS_KEYS.has(filter) ? (filter as TaskStatus) : 'inbox';
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
    }).catch((e: Error) => {
      toast.error(`专注时长记录失败：${e.message}`);
    });
  }, [logFocusSession, selectedTask, invalidate, toast]);

  // --- gantt/calendar range helpers --------------------------------------

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

  // Keep selected task in sync with the latest server data.
  useEffect(() => {
    if (!selectedTask) return;
    const fresh = allTasks.find((t) => t.id === selectedTask.id);
    if (fresh && fresh !== selectedTask) setSelectedTask(fresh);
  }, [allTasks, selectedTask]);

  if (projectsQ.isLoading || allTasksQ.isLoading) {
    return (
      <div className="tasks-view">
        <div className="tasks-loading">加载任务中…</div>
      </div>
    );
  }
  if (projectsQ.isError || allTasksQ.isError) {
    const msg = (projectsQ.error as Error)?.message ?? (allTasksQ.error as Error)?.message ?? '加载失败';
    return (
      <div className="tasks-view">
        <div className="tasks-error">
          <p>任务加载失败：{msg}</p>
          <button className="btn-primary" onClick={() => { projectsQ.refetch(); allTasksQ.refetch(); }}>重试</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tasks-view">
      <div className="tasks-main">
        <div className="tasks-toolbar">
          <div className="tasks-viewswitch">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
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
              tasks={allTasks}
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
              tasks={allTasks}
              projects={projects}
              onSelectTask={setSelectedTask}
              rangeStart={new Date(filterStart)}
              rangeEnd={new Date(filterEnd)}
              selectedTaskId={selectedTaskId}
            />
          )}
          {view === 'kanban' && (
            <KanbanView
              tasks={allTasks}
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

import { api, post, patch, del } from '../../api';

/**
 * Task model mirrors ZenithFlow's, extended with ZhiPane's `today` status and
 * `priority` field. `scheduled` places a task on the calendar/gantt timeline.
 */
export type TaskStatus = 'inbox' | 'today' | 'next' | 'waiting' | 'someday' | 'done' | 'scheduled';
export type TaskPriority = 'none' | 'low' | 'medium' | 'high';
export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year';
export type FocusKind = 'focus' | 'short_break' | 'long_break';
export type ViewMode = 'calendar' | 'gantt' | 'kanban';
export type CalendarMode = 'day' | 'week' | 'month';

export interface Project {
  id: string;
  workspaceId: string;
  spaceId: string | null;
  name: string;
  color: string;
  description: string | null;
  position: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  spaceId: string | null;
  projectId: string | null;
  createdById: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  /** Start of the scheduled block (calendar / gantt). */
  startDate: string | null;
  /** End of the scheduled block. */
  endDate: string | null;
  completedAt: string | null;
  position: number;
  recurrenceUnit: RecurrenceUnit | null;
  recurrenceInterval: number | null;
  recurrenceEndDate: string | null;
  focusSeconds: number;
  /** 0-100 completion, drives gantt bars and card meters. */
  progress: number;
  /** Minutes; calendar block height and gantt weighting. */
  estimatedDuration: number;
  /** GTD context tag, e.g. "@computer". */
  context: string | null;
  tags: string[];
  dependencies: string[];
  isAllDay: boolean;
  /** Multi-session execution: child sessions point at the origin task. */
  parentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FocusSession {
  id: string;
  workspaceId: string;
  taskId: string | null;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  kind: FocusKind;
}

/** GTD buckets shown in the sidebar and as kanban columns. */
export const GTD_COLUMNS: { key: TaskStatus; label: string; hint: string }[] = [
  { key: 'inbox', label: '收件箱', hint: '临时捕获，待处理' },
  { key: 'today', label: '今日', hint: '今天要做的' },
  { key: 'next', label: '下一步', hint: '可立即行动' },
  { key: 'scheduled', label: '已排期', hint: '已安排到日历' },
  { key: 'waiting', label: '等待中', hint: '等待他人/外部' },
  { key: 'someday', label: '将来/也许', hint: '有空再做' },
  { key: 'done', label: '已完成', hint: '已归档' }
];

export const PRIORITY_META: Record<TaskPriority, { label: string; weight: number; color: string }> = {
  none: { label: '无', weight: 0, color: 'var(--muted)' },
  low: { label: '低', weight: 1, color: 'var(--primary)' },
  medium: { label: '中', weight: 2, color: 'var(--warn)' },
  high: { label: '高', weight: 3, color: 'var(--danger)' }
};

/** ZenithFlow's project palette. */
export const PRESET_COLORS = [
  '#22C55E', '#10B981', '#3B82F6', '#6366F1', '#8B5CF6',
  '#EC4899', '#F43F5E', '#F59E0B', '#EAB308', '#71717A'
];

export const RECURRENCE_LABELS: Record<string, string> = {
  day: '每日',
  week: '每周',
  month: '每月',
  year: '每年'
};

// ------------------------------------------------------------- projects
export function listProjects(): Promise<{ projects: Project[] }> {
  return api('/api/tasks/projects');
}
export function createProject(input: Partial<Project>): Promise<{ project: Project }> {
  return post('/api/tasks/projects', input);
}
export function updateProject(id: string, input: Partial<Project>): Promise<{ project: Project }> {
  return patch(`/api/tasks/projects/${id}`, input);
}
export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return del(`/api/tasks/projects/${id}`);
}

// ---------------------------------------------------------------- tasks
export interface TaskQuery {
  status?: TaskStatus;
  projectId?: string;
  /** ISO datetime; returns tasks overlapping [from, to] for calendar/gantt. */
  from?: string;
  to?: string;
}

export function listTasks(q: TaskQuery = {}): Promise<{ tasks: Task[] }> {
  const p = new URLSearchParams();
  if (q.status) p.set('status', q.status);
  if (q.projectId) p.set('projectId', q.projectId);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  const s = p.toString();
  return api(`/api/tasks${s ? `?${s}` : ''}`);
}
export function createTask(input: Partial<Task>): Promise<{ task: Task }> {
  return post('/api/tasks', input);
}
export function updateTask(id: string, input: Partial<Task>): Promise<{ task: Task }> {
  return patch(`/api/tasks/${id}`, input);
}
export function deleteTask(id: string): Promise<{ ok: boolean }> {
  return del(`/api/tasks/${id}`);
}
/** Copy a task, applying overrides (ctrl-drag on calendar, session splitting). */
export function duplicateTask(id: string, overrides: Partial<Task> = {}): Promise<{ task: Task }> {
  return post(`/api/tasks/${id}/duplicate`, overrides);
}

// -------------------------------------------------------- focus sessions
export function logFocusSession(input: {
  taskId?: string | null;
  kind?: FocusKind;
  durationSeconds?: number;
  startedAt?: string;
}): Promise<{ session: FocusSession }> {
  return post('/api/tasks/focus', input);
}
export function listFocusSessions(taskId?: string): Promise<{ sessions: FocusSession[] }> {
  return api(`/api/tasks/focus${taskId ? `?taskId=${taskId}` : ''}`);
}

// ------------------------------------------------------------------- AI
// Backed by ZhiPane's unified (encrypted) AI configuration rather than
// ZenithFlow's localStorage settings.
export function aiBreakdown(input: { title: string; notes?: string; count?: number }): Promise<{
  subtasks: { title: string; estimatedDuration: number }[];
}> {
  return post('/api/tasks/ai/breakdown', input);
}
export function aiPrioritize(taskIds?: string[]): Promise<{ ranking: { id: string; reason: string }[] }> {
  return post('/api/tasks/ai/prioritize', taskIds ? { taskIds } : {});
}

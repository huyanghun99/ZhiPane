import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { tasks, projects, focusSessions, workspaceMembers, workspaces } from '@zhipane/db';
import { createAiProviderForContext, isAiDisabledError } from '../services/ai.service';

export const taskRoutes = new Hono<AppEnv>();
taskRoutes.use('*', authMiddleware);

/** Resolve the caller's primary workspace (personal workbench scope). */
async function getUserWorkspaceId(userId: string): Promise<string> {
  const [wm] = await db
    .select({ workspaceId: workspaces.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaces.createdAt)
    .limit(1);
  if (!wm) throw new Error('No workspace found for user');
  return wm.workspaceId;
}

// ---------------------------------------------------------------- projects
const projectInput = z.object({
  name: z.string().min(1).max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#22c55e'),
  description: z.string().max(2000).optional(),
  spaceId: z.string().uuid().optional().nullable(),
  archived: z.boolean().optional()
});

taskRoutes.get('/projects', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .orderBy(projects.position, projects.name);
  return c.json({ projects: rows });
});

taskRoutes.post('/projects', zValidator('json', projectInput), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const body = c.req.valid('json');
  const [row] = await db
    .insert(projects)
    .values({
      workspaceId,
      name: body.name,
      color: body.color,
      description: body.description ?? null,
      spaceId: body.spaceId ?? null,
      archived: body.archived ?? false
    })
    .returning();
  return c.json({ project: row }, 201);
});

taskRoutes.patch('/projects/:id', zValidator('json', projectInput.partial()), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(projects)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId)))
    .returning();
  if (!row) return c.json({ error: 'project not found' }, 404);
  return c.json({ project: row });
});

taskRoutes.delete('/projects/:id', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const id = c.req.param('id');
  await db.delete(projects).where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId)));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------- tasks
// `scheduled` places a task on the calendar/gantt timeline (ZenithFlow parity);
// `today` and `priority` are ZhiPane extensions kept on top of that model.
const taskInput = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  status: z.enum(['inbox', 'today', 'next', 'waiting', 'someday', 'done', 'scheduled']).optional(),
  priority: z.enum(['none', 'low', 'medium', 'high']).optional(),
  projectId: z.string().uuid().optional().nullable(),
  spaceId: z.string().uuid().optional().nullable(),
  dueDate: z.string().datetime().optional().nullable(),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
  position: z.number().int().optional(),
  recurrenceUnit: z.enum(['day', 'week', 'month', 'year']).optional().nullable(),
  recurrenceInterval: z.number().int().positive().optional().nullable(),
  recurrenceEndDate: z.string().datetime().optional().nullable(),
  progress: z.number().int().min(0).max(100).optional(),
  estimatedDuration: z.number().int().nonnegative().optional(),
  context: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().max(50)).optional(),
  dependencies: z.array(z.string().uuid()).optional(),
  isAllDay: z.boolean().optional(),
  parentTaskId: z.string().uuid().optional().nullable()
});

/** Scalar columns that can be copied straight from the request body. */
const TASK_SCALARS = [
  'title', 'notes', 'status', 'priority', 'projectId', 'spaceId', 'position',
  'recurrenceUnit', 'recurrenceInterval', 'progress', 'estimatedDuration',
  'context', 'tags', 'dependencies', 'isAllDay', 'parentTaskId'
] as const;

const TASK_DATES = ['dueDate', 'startDate', 'endDate', 'recurrenceEndDate', 'completedAt'] as const;

taskRoutes.get('/', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const status = c.req.query('status');
  const projectId = c.req.query('projectId');
  // Calendar / gantt fetch a window of scheduled work via ?from=&to=.
  const from = c.req.query('from');
  const to = c.req.query('to');
  const conditions = [eq(tasks.workspaceId, workspaceId)];
  if (status) conditions.push(eq(tasks.status, status as never));
  if (projectId) conditions.push(eq(tasks.projectId, projectId));
  // Overlap test: task starts before the window ends and ends after it starts.
  // Tasks without an end fall back to their start so single points still match.
  if (from) conditions.push(gte(sql`COALESCE(${tasks.endDate}, ${tasks.startDate})`, new Date(from)));
  if (to) conditions.push(lte(tasks.startDate, new Date(to)));
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(tasks.position, desc(tasks.createdAt));
  return c.json({ tasks: rows });
});

taskRoutes.post('/', zValidator('json', taskInput), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const body = c.req.valid('json');
  // A stale client-side filter (e.g. a project deleted earlier) used to send a
  // dangling projectId and blow up with an opaque FK 500. Reject it clearly so
  // the UI can recover instead of showing a generic "创建失败".
  if (body.projectId) {
    const [project] = await db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, body.projectId), eq(projects.workspaceId, workspaceId))).limit(1);
    if (!project) return c.json({ error: 'projectId does not belong to this workspace' }, 400);
  }
  const [row] = await db
    .insert(tasks)
    .values({
      workspaceId,
      createdById: user.id,
      title: body.title,
      notes: body.notes ?? null,
      status: body.status ?? 'inbox',
      priority: body.priority ?? 'none',
      projectId: body.projectId ?? null,
      spaceId: body.spaceId ?? null,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      startDate: body.startDate ? new Date(body.startDate) : null,
      endDate: body.endDate ? new Date(body.endDate) : null,
      position: body.position ?? 0,
      recurrenceUnit: body.recurrenceUnit ?? null,
      recurrenceInterval: body.recurrenceInterval ?? null,
      recurrenceEndDate: body.recurrenceEndDate ? new Date(body.recurrenceEndDate) : null,
      progress: body.progress ?? 0,
      estimatedDuration: body.estimatedDuration ?? 0,
      context: body.context ?? null,
      tags: body.tags ?? [],
      dependencies: body.dependencies ?? [],
      isAllDay: body.isAllDay ?? false,
      parentTaskId: body.parentTaskId ?? null
    })
    .returning();
  return c.json({ task: row }, 201);
});

taskRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return c.json({ error: 'task not found' }, 404);
  return c.json({ task: row });
});

taskRoutes.patch('/:id', zValidator('json', taskInput.partial().extend({
  completedAt: z.string().datetime().optional().nullable()
})), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of TASK_SCALARS) {
    if (body[k] !== undefined) set[k] = body[k];
  }
  for (const k of TASK_DATES) {
    const v = body[k as keyof typeof body] as string | null | undefined;
    if (v !== undefined) set[k] = v ? new Date(v) : null;
  }
  // Keep completion state coherent: finishing a task fills its progress bar,
  // reopening it clears the completion stamp.
  if (body.status !== undefined && body.completedAt === undefined) {
    if (body.status === 'done') {
      set.completedAt = new Date();
      if (body.progress === undefined) set.progress = 100;
    } else {
      set.completedAt = null;
    }
  }
  const [row] = await db
    .update(tasks)
    .set(set)
    .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
    .returning();
  if (!row) return c.json({ error: 'task not found' }, 404);
  return c.json({ task: row });
});

taskRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const id = c.req.param('id');
  await db.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)));
  return c.json({ ok: true });
});

/**
 * Duplicate a task, optionally overriding fields. Backs ZenithFlow's
 * ctrl/cmd-drag on the calendar (copy instead of move) and the "split into
 * sessions" action, where each copy links back via parentTaskId.
 */
taskRoutes.post('/:id/duplicate', zValidator('json', taskInput.partial()), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const id = c.req.param('id');
  const overrides = c.req.valid('json');

  const [src] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
    .limit(1);
  if (!src) return c.json({ error: 'task not found' }, 404);

  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src;
  const values: Record<string, unknown> = { ...rest, completedAt: null };
  for (const k of TASK_SCALARS) {
    if (overrides[k] !== undefined) values[k] = overrides[k];
  }
  for (const k of TASK_DATES) {
    const v = overrides[k as keyof typeof overrides] as string | null | undefined;
    if (v !== undefined) values[k] = v ? new Date(v) : null;
  }
  const [row] = await db.insert(tasks).values(values as typeof tasks.$inferInsert).returning();
  return c.json({ task: row }, 201);
});

// --------------------------------------------------------- focus sessions
const focusInput = z.object({
  taskId: z.string().uuid().optional().nullable(),
  kind: z.enum(['focus', 'short_break', 'long_break']).default('focus'),
  // When ending a session, pass the elapsed seconds to persist duration.
  durationSeconds: z.number().int().nonnegative().optional(),
  startedAt: z.string().datetime().optional()
});

taskRoutes.post('/focus', zValidator('json', focusInput), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const body = c.req.valid('json');
  const [row] = await db
    .insert(focusSessions)
    .values({
      workspaceId,
      taskId: body.taskId ?? null,
      userId: user.id,
      kind: body.kind,
      startedAt: body.startedAt ? new Date(body.startedAt) : new Date(),
      endedAt: new Date(),
      durationSeconds: body.durationSeconds ?? 0
    })
    .returning();
  // Roll the focus time onto the task for aggregate stats.
  if (body.taskId && body.durationSeconds) {
    await db.execute(
      sql`UPDATE tasks SET focus_seconds = focus_seconds + ${body.durationSeconds} WHERE id = ${body.taskId}`
    );
  }
  return c.json({ session: row }, 201);
});

taskRoutes.get('/focus', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const taskId = c.req.query('taskId');
  const conditions = [eq(focusSessions.workspaceId, workspaceId), eq(focusSessions.userId, user.id)];
  if (taskId) conditions.push(eq(focusSessions.taskId, taskId));
  const rows = await db
    .select()
    .from(focusSessions)
    .where(and(...conditions))
    .orderBy(desc(focusSessions.startedAt))
    .limit(100);
  return c.json({ sessions: rows });
});

// --------------------------------------------------------------------- AI
// ZenithFlow shipped its own AI settings in localStorage. Here the task AI
// features go through ZhiPane's unified, encrypted AI config instead, so the
// Space privacy policy (cloud_allowed / local_only / disabled) is honoured.

/** Extract a JSON value from a model reply that may be fenced or prose-wrapped. */
function parseJsonReply<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Break a goal into concrete, actionable subtasks. */
taskRoutes.post('/ai/breakdown', zValidator('json', z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  count: z.number().int().min(2).max(10).default(5)
})), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const { title, notes, count } = c.req.valid('json');

  try {
    const ai = await createAiProviderForContext({ workspaceId, userId: user.id });
    const reply = await ai.generateText([
      {
        role: 'system',
        content:
          '你是一位 GTD 任务拆解专家。把目标拆成可立即执行的具体子任务。' +
          '只返回 JSON 数组，每项形如 {"title": string, "estimatedDuration": number}，' +
          'estimatedDuration 为预计分钟数。不要输出任何解释。'
      },
      {
        role: 'user',
        content: `目标：${title}\n${notes ? `补充说明：${notes}\n` : ''}请拆解为最多 ${count} 个子任务。`
      }
    ]);

    const parsed = parseJsonReply<{ title: string; estimatedDuration?: number }[]>(reply);
    if (!parsed || !Array.isArray(parsed)) {
      return c.json({ error: 'AI 返回格式无法解析', raw: reply.slice(0, 500) }, 502);
    }
    const subtasks = parsed
      .filter((s) => s && typeof s.title === 'string' && s.title.trim())
      .slice(0, count)
      .map((s) => ({
        title: s.title.trim().slice(0, 500),
        estimatedDuration: Number.isFinite(s.estimatedDuration) ? Math.max(0, Math.round(s.estimatedDuration!)) : 30
      }));
    return c.json({ subtasks });
  } catch (err) {
    if (isAiDisabledError(err)) return c.json({ error: '当前空间已禁用 AI' }, 403);
    return c.json({ error: (err as Error).message }, 500);
  }
});

/** Rank the caller's open tasks by urgency and explain the ordering. */
taskRoutes.post('/ai/prioritize', zValidator('json', z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(50).optional()
}).optional().default({})), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const body = c.req.valid('json');

  const conditions = [eq(tasks.workspaceId, workspaceId), ne(tasks.status, 'done')];
  if (body?.taskIds?.length) conditions.push(inArray(tasks.id, body.taskIds));
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      estimatedDuration: tasks.estimatedDuration
    })
    .from(tasks)
    .where(and(...conditions))
    .limit(50);

  if (rows.length === 0) return c.json({ ranking: [] });

  try {
    const ai = await createAiProviderForContext({ workspaceId, userId: user.id });
    const reply = await ai.generateText([
      {
        role: 'system',
        content:
          '你是一位 GTD 效率顾问。根据截止时间、优先级与预计耗时对任务排序，最紧急的排在最前。' +
          '只返回 JSON 数组，每项形如 {"id": string, "reason": string}，reason 用一句中文说明理由。不要输出解释。'
      },
      {
        role: 'user',
        content: `今天是 ${new Date().toISOString().slice(0, 10)}。请对以下任务排序：\n${JSON.stringify(rows)}`
      }
    ]);

    const parsed = parseJsonReply<{ id: string; reason?: string }[]>(reply);
    if (!parsed || !Array.isArray(parsed)) {
      return c.json({ error: 'AI 返回格式无法解析', raw: reply.slice(0, 500) }, 502);
    }
    // Only echo back ids that actually belong to this workspace.
    const known = new Set(rows.map((r) => r.id));
    const ranking = parsed
      .filter((r) => r && known.has(r.id))
      .map((r) => ({ id: r.id, reason: typeof r.reason === 'string' ? r.reason : '' }));
    return c.json({ ranking });
  } catch (err) {
    if (isAiDisabledError(err)) return c.json({ error: '当前空间已禁用 AI' }, 403);
    return c.json({ error: (err as Error).message }, 500);
  }
});

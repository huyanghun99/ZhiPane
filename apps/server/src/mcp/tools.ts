import type { Context } from 'hono';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { env } from '../env';
import type { AppEnv, SessionUser } from '../middleware/auth';
import type { AgentScope } from '../middleware/agent-auth';
import {
  createPage, updatePage, deletePage, getPageDetail, getPageTree
} from '../services/page.service';
import {
  canViewWorkspace, canViewSpace, canEditSpace, canEditPage
} from '../services/permission.service';

export type McpContext = Context<AppEnv>;

async function rows<T = Record<string, unknown>>(q: SQL): Promise<T[]> {
  const r = await db.execute(q) as unknown as { rows: T[] };
  return r.rows ?? [];
}

function user(c: McpContext): SessionUser { return c.get('user'); }

/** Enforce the token's workspace binding plus the normal membership check. */
async function assertWorkspace(c: McpContext, workspaceId: string) {
  const bound = c.get('agentWorkspaceId');
  if (bound && bound !== workspaceId) throw new Error('Token is not allowed to access this workspace');
  if (!bound && !(await canViewWorkspace(user(c).id, workspaceId))) {
    throw new Error('Forbidden: no access to this workspace');
  }
}

async function workspaceOfSpace(c: McpContext, spaceId: string): Promise<string> {
  const r = await rows<{ workspace_id: string }>(sql`SELECT workspace_id FROM spaces WHERE id = ${spaceId}::uuid LIMIT 1`);
  if (!r[0]) throw new Error('Space not found');
  await assertWorkspace(c, r[0].workspace_id);
  return r[0].workspace_id;
}

async function workspaceOfPage(c: McpContext, pageId: string): Promise<string> {
  const r = await rows<{ workspace_id: string }>(sql`SELECT workspace_id FROM pages WHERE id = ${pageId}::uuid LIMIT 1`);
  if (!r[0]) throw new Error('Page not found');
  await assertWorkspace(c, r[0].workspace_id);
  return r[0].workspace_id;
}

function scopeOf(c: McpContext, scope: AgentScope) {
  const scopes = c.get('agentScopes');
  if (scopes && !scopes.includes(scope)) throw new Error(`Token lacks scope ${scope}`);
}

// ---------------------------------------------------------------- schemas
const S = {
  id: z.string().uuid().describe('uuid'),
  text: z.string().min(1).max(500),
  optionalId: z.string().uuid().optional(),
  idempotency: z.string().max(120).optional(),
};
const schemas = {
  kb_list_workspaces: z.object({}),
  kb_list_spaces: z.object({ workspaceId: S.id }),
  kb_get_tree: z.object({ spaceId: S.id }),
  kb_get_page: z.object({ pageId: S.id }),
  kb_search_pages: z.object({ q: z.string().min(1).max(200), workspaceId: S.id.optional(), limit: z.number().int().min(1).max(50).optional() }),
  kb_create_page: z.object({ spaceId: S.id, title: S.text, contentJson: z.unknown().optional(), parentPageId: S.optionalId, idempotencyKey: S.idempotency }),
  kb_update_page: z.object({ pageId: S.id, contentVersion: z.number().int(), title: z.string().min(1).max(500).optional(), contentJson: z.unknown().optional(), idempotencyKey: S.idempotency }),
  kb_delete_page: z.object({ pageId: S.id, idempotencyKey: S.idempotency }),
  kb_archive_page: z.object({ pageId: S.id, idempotencyKey: S.idempotency }),
  kb_unarchive_page: z.object({ pageId: S.id, idempotencyKey: S.idempotency }),
  kb_move_page: z.object({ pageId: S.id, parentPageId: z.string().uuid().nullable().optional(), spaceId: S.id.optional(), position: z.number().int().optional(), idempotencyKey: S.idempotency }),
  kb_create_space: z.object({ workspaceId: S.id, name: S.text, idempotencyKey: S.idempotency }),
  kb_rename_space: z.object({ spaceId: S.id, name: S.text, idempotencyKey: S.idempotency }),
  kb_archive_space: z.object({ spaceId: S.id, idempotencyKey: S.idempotency }),
  tasks_list: z.object({ workspaceId: S.id.optional(), status: z.string().optional(), projectId: S.optionalId, from: z.string().optional(), to: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
  tasks_get: z.object({ id: S.id }),
  tasks_list_projects: z.object({ workspaceId: S.id.optional() }),
  tasks_calendar: z.object({ from: z.string(), to: z.string(), workspaceId: S.id.optional() }),
  tasks_create: z.object({ title: S.text, workspaceId: S.id.optional(), status: z.string().optional(), projectId: z.string().uuid().nullable().optional(), dueDate: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional(), notes: z.string().optional(), idempotencyKey: S.idempotency }),
  tasks_update: z.object({ id: S.id, title: z.string().min(1).max(500).optional(), status: z.string().optional(), progress: z.number().int().min(0).max(100).optional(), idempotencyKey: S.idempotency }),
  tasks_move: z.object({ id: S.id, status: z.string().optional(), projectId: z.string().uuid().nullable().optional(), startDate: z.string().nullable().optional(), endDate: z.string().nullable().optional(), position: z.number().int().optional(), idempotencyKey: S.idempotency }),
  tasks_delete: z.object({ id: S.id, idempotencyKey: S.idempotency }),
  tasks_complete: z.object({ id: S.id, idempotencyKey: S.idempotency }),
  calendar_get_feed_url: z.object({ workspaceId: S.id.optional() })
};

type ToolName = keyof typeof schemas;

interface ToolDef {
  name: ToolName;
  description: string;
  scope: AgentScope;
  inputSchema: Record<string, unknown>;
  run: (c: McpContext, args: Record<string, unknown>) => Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const idem = { idempotencyKey: str('Optional retry key; repeated calls return the first result') };

/** Effective workspace for task tools: token binding > explicit arg > first membership. */
async function taskWorkspace(c: McpContext, explicit?: string): Promise<string> {
  const bound = c.get('agentWorkspaceId');
  if (bound) {
    if (explicit && explicit !== bound) throw new Error('Token is not allowed to access this workspace');
    return bound;
  }
  if (explicit) { await assertWorkspace(c, explicit); return explicit; }
  const r = await rows<{ workspace_id: string }>(sql`
    SELECT workspace_id FROM workspace_members WHERE user_id = ${user(c).id}::uuid ORDER BY created_at LIMIT 1
  `);
  if (!r[0]) throw new Error('No workspace found for user');
  return r[0].workspace_id;
}

function safeDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const TOOLS: ToolDef[] = [
  // ------------------------------------------------------------ kb read
  {
    name: 'kb_list_workspaces', description: '列出可访问的知识库', scope: 'kb:read',
    inputSchema: obj({}),
    run: async (c) => {
      scopeOf(c, 'kb:read');
      const bound = c.get('agentWorkspaceId');
      const r = await rows(sql`
        SELECT w.id, w.name, wm.role FROM workspaces w
        JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE wm.user_id = ${user(c).id}::uuid ${bound ? sql`AND w.id = ${bound}::uuid` : sql``}
        ORDER BY w.created_at DESC
      `);
      return { workspaces: r };
    }
  },
  {
    name: 'kb_list_spaces', description: '列出某知识库下的空间（不含已归档）', scope: 'kb:read',
    inputSchema: obj({ workspaceId: str('workspace uuid') }, ['workspaceId']),
    run: async (c, a) => {
      scopeOf(c, 'kb:read');
      const { workspaceId } = schemas.kb_list_spaces.parse(a);
      await assertWorkspace(c, workspaceId);
      const r = await rows(sql`
        SELECT s.id, s.name, s.space_kind AS kind, s.lifecycle_status AS status
        FROM spaces s JOIN space_members sm ON sm.space_id = s.id
        WHERE s.workspace_id = ${workspaceId}::uuid AND sm.user_id = ${user(c).id}::uuid
          AND s.lifecycle_status <> 'archived'
        ORDER BY s.created_at DESC
      `);
      return { spaces: r };
    }
  },
  {
    name: 'kb_get_tree', description: '读取空间的笔记目录树', scope: 'kb:read',
    inputSchema: obj({ spaceId: str('space uuid') }, ['spaceId']),
    run: async (c, a) => {
      scopeOf(c, 'kb:read');
      const { spaceId } = schemas.kb_get_tree.parse(a);
      await workspaceOfSpace(c, spaceId);
      if (!(await canViewSpace(user(c).id, spaceId))) throw new Error('Forbidden');
      return { tree: await getPageTree(spaceId) };
    }
  },
  {
    name: 'kb_get_page', description: '读取单篇笔记全文', scope: 'kb:read',
    inputSchema: obj({ pageId: str('page uuid') }, ['pageId']),
    run: async (c, a) => {
      scopeOf(c, 'kb:read');
      const { pageId } = schemas.kb_get_page.parse(a);
      await workspaceOfPage(c, pageId);
      const page = await getPageDetail(pageId);
      if (!page) throw new Error('Page not found');
      return { page };
    }
  },
  {
    name: 'kb_search_pages', description: '按标题/正文关键词搜索笔记', scope: 'kb:read',
    inputSchema: obj({ q: str('关键词'), workspaceId: str('可选，限定知识库'), limit: num('最多返回条数，默认 20') }, ['q']),
    run: async (c, a) => {
      scopeOf(c, 'kb:read');
      const { q, workspaceId, limit } = schemas.kb_search_pages.parse(a);
      const ws = await taskWorkspace(c, workspaceId);
      const r = await rows(sql`
        SELECT id, title, space_id, status, updated_at FROM pages
        WHERE workspace_id = ${ws}::uuid AND status = 'normal'
          AND (title ILIKE ${'%' + q + '%'} OR text_content ILIKE ${'%' + q + '%'})
        ORDER BY updated_at DESC LIMIT ${limit ?? 20}
      `);
      return { pages: r };
    }
  },
  // ------------------------------------------------------------ kb write
  {
    name: 'kb_create_page', description: '新建笔记', scope: 'kb:write',
    inputSchema: obj({ spaceId: str('space uuid'), title: str('标题'), contentJson: { type: 'object', description: 'ProseMirror JSON，可选' }, parentPageId: str('父笔记 uuid，可选'), ...idem }, ['spaceId', 'title']),
    run: async (c, a) => {
      scopeOf(c, 'kb:write');
      const v = schemas.kb_create_page.parse(a);
      await workspaceOfSpace(c, v.spaceId);
      if (!(await canEditSpace(user(c).id, v.spaceId))) throw new Error('Forbidden');
      const { page } = await createPage(user(c), {
        spaceId: v.spaceId, title: v.title,
        contentJson: v.contentJson ?? { type: 'doc', content: [] },
        parentPageId: v.parentPageId ?? null
      } as never);
      return { page };
    }
  },
  {
    name: 'kb_update_page', description: '更新笔记标题/正文；必须带当前 contentVersion 做乐观锁', scope: 'kb:write',
    inputSchema: obj({ pageId: str('page uuid'), contentVersion: num('当前版本号'), title: str('新标题，可选'), contentJson: { type: 'object', description: '新正文，可选' }, ...idem }, ['pageId', 'contentVersion']),
    run: async (c, a) => {
      scopeOf(c, 'kb:write');
      const v = schemas.kb_update_page.parse(a);
      await workspaceOfPage(c, v.pageId);
      if (!(await canEditPage(user(c).id, v.pageId))) throw new Error('Forbidden');
      const r = await updatePage(user(c), v.pageId, {
        contentVersion: v.contentVersion,
        ...(v.title ? { title: v.title } : {}),
        ...(v.contentJson !== undefined ? { contentJson: v.contentJson } : {})
      } as never);
      if (!r.ok) throw new Error(r.reason === 'conflict' ? 'Version conflict: re-read the page and retry' : r.reason);
      return { page: (r as { page: unknown }).page };
    }
  },
  {
    name: 'kb_delete_page', description: '删除笔记（软删）', scope: 'kb:write',
    inputSchema: obj({ pageId: str('page uuid'), ...idem }, ['pageId']),
    run: async (c, a) => {
      scopeOf(c, 'kb:write');
      const { pageId } = schemas.kb_delete_page.parse(a);
      await workspaceOfPage(c, pageId);
      if (!(await canEditPage(user(c).id, pageId))) throw new Error('Forbidden');
      await deletePage(pageId);
      return { ok: true };
    }
  },
  {
    name: 'kb_archive_page', description: '归档笔记（可从归档中心恢复）', scope: 'kb:write',
    inputSchema: obj({ pageId: str('page uuid'), ...idem }, ['pageId']),
    run: async (c, a) => {
      scopeOf(c, 'kb:write');
      const { pageId } = schemas.kb_archive_page.parse(a);
      await workspaceOfPage(c, pageId);
      if (!(await canEditPage(user(c).id, pageId))) throw new Error('Forbidden');
      await db.execute(sql`UPDATE pages SET status='archived', updated_at=now() WHERE id=${pageId}::uuid`);
      return { ok: true };
    }
  },
  {
    name: 'kb_unarchive_page', description: '恢复已归档笔记', scope: 'kb:write',
    inputSchema: obj({ pageId: str('page uuid'), ...idem }, ['pageId']),
    run: async (c, a) => {
      scopeOf(c, 'kb:write');
      const { pageId } = schemas.kb_unarchive_page.parse(a);
      await workspaceOfPage(c, pageId);
      if (!(await canEditPage(user(c).id, pageId))) throw new Error('Forbidden');
      await db.execute(sql`UPDATE pages SET status='normal', updated_at=now() WHERE id=${pageId}::uuid`);
      return { ok: true };
    }
  },
  {
    name: 'kb_move_page', description: '移动笔记（改父节点/跨空间/排序位置）', scope: 'kb:write',
    inputSchema: obj({ pageId: str('page uuid'), parentPageId: str('父笔记 uuid 或 null'), spaceId: str('目标空间 uuid'), position: num('同级排序位置'), ...idem }, ['pageId']),
    run: async (c, a) => {
      scopeOf(c, 'kb:write');
      const v = schemas.kb_move_page.parse(a);
      await workspaceOfPage(c, v.pageId);
      if (!(await canEditPage(user(c).id, v.pageId))) throw new Error('Forbidden');
      if (v.spaceId) {
        await workspaceOfSpace(c, v.spaceId);
        if (!(await canEditSpace(user(c).id, v.spaceId))) throw new Error('Forbidden: no edit access to target space');
      }
      if (v.parentPageId === v.pageId) throw new Error('A page cannot be its own parent');
      await db.execute(sql`
        UPDATE pages SET
          parent_page_id = ${v.parentPageId === undefined ? sql`parent_page_id` : v.parentPageId === null ? sql`NULL` : sql`${v.parentPageId}::uuid`},
          space_id = ${v.spaceId === undefined ? sql`space_id` : sql`${v.spaceId}::uuid`},
          position = ${v.position === undefined ? sql`position` : v.position},
          updated_at = now()
        WHERE id = ${v.pageId}::uuid
      `);
      return { ok: true, page: await getPageDetail(v.pageId) };
    }
  },
  {
    name: 'kb_create_space', description: '新建空间', scope: 'kb:write',
    inputSchema: obj({ workspaceId: str('workspace uuid'), name: str('空间名'), ...idem }, ['workspaceId', 'name']),
    run: async (c, a) => {
      scopeOf(c, 'kb:write');
      const v = schemas.kb_create_space.parse(a);
      await assertWorkspace(c, v.workspaceId);
      const r = await rows<{ id: string }>(sql`
        INSERT INTO spaces (workspace_id, name) VALUES (${v.workspaceId}::uuid, ${v.name}) RETURNING id
      `);
      const id = r[0].id;
      await db.execute(sql`INSERT INTO space_members (space_id, user_id, role) VALUES (${id}::uuid, ${user(c).id}::uuid, 'admin')`);
      return { space: { id, name: v.name, workspaceId: v.workspaceId } };
    }
  },
  {
    name: 'kb_rename_space', description: '重命名空间', scope: 'kb:write',
    inputSchema: obj({ spaceId: str('space uuid'), name: str('新名称'), ...idem }, ['spaceId', 'name']),
    run: async (c, a) => {
      scopeOf(c, 'kb:write');
      const v = schemas.kb_rename_space.parse(a);
      await workspaceOfSpace(c, v.spaceId);
      if (!(await canEditSpace(user(c).id, v.spaceId))) throw new Error('Forbidden');
      await db.execute(sql`UPDATE spaces SET name=${v.name}, updated_at=now() WHERE id=${v.spaceId}::uuid`);
      return { ok: true };
    }
  },
  {
    name: 'kb_archive_space', description: '归档空间（从侧栏隐藏，可恢复）', scope: 'kb:write',
    inputSchema: obj({ spaceId: str('space uuid'), ...idem }, ['spaceId']),
    run: async (c, a) => {
      scopeOf(c, 'kb:write');
      const { spaceId } = schemas.kb_archive_space.parse(a);
      await workspaceOfSpace(c, spaceId);
      if (!(await canEditSpace(user(c).id, spaceId))) throw new Error('Forbidden');
      await db.execute(sql`UPDATE spaces SET lifecycle_status='archived', archived_at=now(), updated_at=now() WHERE id=${spaceId}::uuid`);
      return { ok: true };
    }
  },
  // ------------------------------------------------------------ tasks read
  {
    name: 'tasks_list', description: '列出任务，可按状态/项目/时间窗口过滤', scope: 'tasks:read',
    inputSchema: obj({ workspaceId: str('可选'), status: str('inbox/today/next/waiting/someday/done/scheduled'), projectId: str('项目 uuid'), from: str('ISO 起始时间'), to: str('ISO 结束时间'), limit: num('最多条数') }),
    run: async (c, a) => {
      scopeOf(c, 'tasks:read');
      const v = schemas.tasks_list.parse(a);
      const ws = await taskWorkspace(c, v.workspaceId);
      const r = await rows(sql`
        SELECT * FROM tasks WHERE workspace_id = ${ws}::uuid
          ${v.status ? sql`AND status = ${v.status}` : sql``}
          ${v.projectId ? sql`AND project_id = ${v.projectId}::uuid` : sql``}
          ${v.from ? sql`AND COALESCE(end_date, start_date) >= ${safeDate(v.from)}::timestamptz` : sql``}
          ${v.to ? sql`AND start_date <= ${safeDate(v.to)}::timestamptz` : sql``}
        ORDER BY position, created_at DESC LIMIT ${v.limit ?? 100}
      `);
      return { tasks: r };
    }
  },
  {
    name: 'tasks_get', description: '读取单个任务', scope: 'tasks:read',
    inputSchema: obj({ id: str('task uuid') }, ['id']),
    run: async (c, a) => {
      scopeOf(c, 'tasks:read');
      const { id } = schemas.tasks_get.parse(a);
      const r = await rows(sql`SELECT * FROM tasks WHERE id=${id}::uuid LIMIT 1`);
      if (!r[0]) throw new Error('Task not found');
      await assertWorkspace(c, (r[0] as { workspace_id: string }).workspace_id);
      return { task: r[0] };
    }
  },
  {
    name: 'tasks_list_projects', description: '列出项目', scope: 'tasks:read',
    inputSchema: obj({ workspaceId: str('可选') }),
    run: async (c, a) => {
      scopeOf(c, 'tasks:read');
      const v = schemas.tasks_list_projects.parse(a);
      const ws = await taskWorkspace(c, v.workspaceId);
      const r = await rows(sql`SELECT * FROM projects WHERE workspace_id=${ws}::uuid ORDER BY position, name`);
      return { projects: r };
    }
  },
  {
    name: 'tasks_calendar', description: '按时间窗口查询日程', scope: 'tasks:read',
    inputSchema: obj({ from: str('ISO 起始'), to: str('ISO 结束'), workspaceId: str('可选') }, ['from', 'to']),
    run: async (c, a) => {
      scopeOf(c, 'tasks:read');
      const v = schemas.tasks_calendar.parse(a);
      const ws = await taskWorkspace(c, v.workspaceId);
      const r = await rows(sql`
        SELECT id, title, status, start_date, end_date, due_date, is_all_day,
               recurrence_unit, recurrence_interval, recurrence_end_date, project_id
        FROM tasks WHERE workspace_id=${ws}::uuid
          AND COALESCE(end_date, start_date, due_date) >= ${safeDate(v.from)}::timestamptz
          AND COALESCE(start_date, due_date) <= ${safeDate(v.to)}::timestamptz
        ORDER BY COALESCE(start_date, due_date)
      `);
      return { events: r };
    }
  },
  // ------------------------------------------------------------ tasks write
  {
    name: 'tasks_create', description: '新建任务', scope: 'tasks:write',
    inputSchema: obj({ title: str('标题'), workspaceId: str('可选'), status: str('状态'), projectId: str('项目 uuid'), startDate: str('ISO'), endDate: str('ISO'), dueDate: str('ISO'), notes: str('备注'), ...idem }, ['title']),
    run: async (c, a) => {
      scopeOf(c, 'tasks:write');
      const v = schemas.tasks_create.parse(a);
      const ws = await taskWorkspace(c, v.workspaceId);
      if (v.projectId) {
        const p = await rows(sql`SELECT id FROM projects WHERE id=${v.projectId}::uuid AND workspace_id=${ws}::uuid LIMIT 1`);
        if (!p[0]) throw new Error('projectId does not belong to this workspace');
      }
      const r = await rows<{ id: string }>(sql`
        INSERT INTO tasks (workspace_id, created_by_id, title, notes, status, project_id,
                           due_date, start_date, end_date)
        VALUES (${ws}::uuid, ${user(c).id}::uuid, ${v.title}, ${v.notes ?? null},
                COALESCE(${v.status ?? null}, 'inbox'), ${v.projectId ?? null}::uuid,
                ${safeDate(v.dueDate)}::timestamptz, ${safeDate(v.startDate)}::timestamptz,
                ${safeDate(v.endDate)}::timestamptz)
        RETURNING id
      `);
      return { task: { id: r[0].id, title: v.title, workspaceId: ws } };
    }
  },
  {
    name: 'tasks_update', description: '更新任务标题/状态/进度', scope: 'tasks:write',
    inputSchema: obj({ id: str('task uuid'), title: str('标题'), status: str('状态'), progress: num('0-100'), ...idem }, ['id']),
    run: async (c, a) => {
      scopeOf(c, 'tasks:write');
      const v = schemas.tasks_update.parse(a);
      await taskGuard(c, v.id);
      await db.execute(sql`
        UPDATE tasks SET
          title = ${v.title === undefined ? sql`title` : v.title},
          status = ${v.status === undefined ? sql`status` : v.status},
          progress = ${v.progress === undefined ? sql`progress` : v.progress},
          updated_at = now()
        WHERE id=${v.id}::uuid
      `);
      return { ok: true };
    }
  },
  {
    name: 'tasks_move', description: '移动任务：改状态/项目/时间/排序，用于拖到日历或改期', scope: 'tasks:write',
    inputSchema: obj({ id: str('task uuid'), status: str('状态'), projectId: str('项目 uuid 或 null'), startDate: str('ISO'), endDate: str('ISO'), position: num('排序'), ...idem }, ['id']),
    run: async (c, a) => {
      scopeOf(c, 'tasks:write');
      const v = schemas.tasks_move.parse(a);
      await taskGuard(c, v.id);
      if (v.projectId) {
        const p = await rows(sql`SELECT id FROM projects WHERE id=${v.projectId}::uuid LIMIT 1`);
        if (!p[0]) throw new Error('projectId not found');
      }
      await db.execute(sql`
        UPDATE tasks SET
          status = ${v.status === undefined ? sql`status` : v.status},
          project_id = ${v.projectId === undefined ? sql`project_id` : v.projectId === null ? sql`NULL` : sql`${v.projectId}::uuid`},
          start_date = ${v.startDate === undefined ? sql`start_date` : sql`${safeDate(v.startDate)}::timestamptz`},
          end_date = ${v.endDate === undefined ? sql`end_date` : sql`${safeDate(v.endDate)}::timestamptz`},
          position = ${v.position === undefined ? sql`position` : v.position},
          updated_at = now()
        WHERE id=${v.id}::uuid
      `);
      return { ok: true };
    }
  },
  {
    name: 'tasks_delete', description: '删除任务', scope: 'tasks:write',
    inputSchema: obj({ id: str('task uuid'), ...idem }, ['id']),
    run: async (c, a) => {
      scopeOf(c, 'tasks:write');
      const { id } = schemas.tasks_delete.parse(a);
      await taskGuard(c, id);
      await db.execute(sql`DELETE FROM tasks WHERE id=${id}::uuid`);
      return { ok: true };
    }
  },
  {
    name: 'tasks_complete', description: '标记任务完成', scope: 'tasks:write',
    inputSchema: obj({ id: str('task uuid'), ...idem }, ['id']),
    run: async (c, a) => {
      scopeOf(c, 'tasks:write');
      const { id } = schemas.tasks_complete.parse(a);
      await taskGuard(c, id);
      await db.execute(sql`UPDATE tasks SET status='done', progress=100, completed_at=now(), updated_at=now() WHERE id=${id}::uuid`);
      return { ok: true };
    }
  },
  {
    name: 'calendar_get_feed_url', description: '返回 CalDAV 与 .ics 订阅地址', scope: 'calendar:read',
    inputSchema: obj({ workspaceId: str('可选') }),
    run: async (c, a) => {
      scopeOf(c, 'calendar:read');
      const v = schemas.calendar_get_feed_url.parse(a);
      const ws = await taskWorkspace(c, v.workspaceId);
      const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
      return {
        caldavUrl: `${base}/caldav/${user(c).id}/calendars/${ws}/`,
        icsUrl: `${base}/caldav/${user(c).id}/calendars/${ws}/feed.ics`,
        hint: 'CalDAV 客户端用 Agent Token 作为密码（Basic）或在 Authorization 头传 Bearer'
      };
    }
  }
];

async function taskGuard(c: McpContext, taskId: string) {
  const r = await rows<{ workspace_id: string }>(sql`SELECT workspace_id FROM tasks WHERE id=${taskId}::uuid LIMIT 1`);
  if (!r[0]) throw new Error('Task not found');
  await assertWorkspace(c, r[0].workspace_id);
}

export function toolDescriptors() {
  return TOOLS.map((t) => ({
    name: t.name, description: t.description, inputSchema: t.inputSchema
  }));
}

export async function callTool(c: McpContext, name: string, args: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(c, args ?? {});
}

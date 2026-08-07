import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { createGroupSchema, updateGroupSchema, addGroupMemberSchema } from '@zhipane/shared';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { groups, groupMembers } from '@zhipane/db';
import { canManageWorkspace } from '../services/permission.service';

export const groupRoutes = new Hono<AppEnv>();
groupRoutes.use('*', authMiddleware);

groupRoutes.get('/', async (c) => {
  const user = c.get('user');
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) return c.json({ error: 'workspaceId is required' }, 400);
  if (!(await canManageWorkspace(user.id, workspaceId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.select().from(groups).where(eq(groups.workspaceId, workspaceId));
  return c.json({ groups: rows });
});

groupRoutes.post('/', zValidator('json', createGroupSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  if (!(await canManageWorkspace(user.id, input.workspaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [group] = await db.insert(groups).values({ workspaceId: input.workspaceId, name: input.name }).returning();
  return c.json({ group }, 201);
});

groupRoutes.patch('/:id', zValidator('json', updateGroupSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const [group] = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
  if (!group) return c.json({ error: 'Not found' }, 404);
  if (!(await canManageWorkspace(user.id, group.workspaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [updated] = await db.update(groups).set({ ...(input.name ? { name: input.name } : {}) }).where(eq(groups.id, id)).returning();
  return c.json({ group: updated });
});

groupRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [group] = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
  if (!group) return c.json({ error: 'Not found' }, 404);
  if (!(await canManageWorkspace(user.id, group.workspaceId))) return c.json({ error: 'Forbidden' }, 403);
  await db.delete(groups).where(eq(groups.id, id));
  return c.json({ ok: true });
});

groupRoutes.get('/:id/members', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [group] = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
  if (!group) return c.json({ error: 'Not found' }, 404);
  if (!(await canManageWorkspace(user.id, group.workspaceId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.select().from(groupMembers).where(eq(groupMembers.groupId, id));
  return c.json({ members: rows });
});

groupRoutes.post('/:id/members', zValidator('json', addGroupMemberSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const [group] = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
  if (!group) return c.json({ error: 'Not found' }, 404);
  if (!(await canManageWorkspace(user.id, group.workspaceId))) return c.json({ error: 'Forbidden' }, 403);
  await db.insert(groupMembers).values({ groupId: id, userId: input.userId });
  return c.json({ ok: true }, 201);
});

groupRoutes.delete('/:id/members/:userId', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const userId = c.req.param('userId');
  const [group] = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
  if (!group) return c.json({ error: 'Not found' }, 404);
  if (!(await canManageWorkspace(user.id, group.workspaceId))) return c.json({ error: 'Forbidden' }, 403);
  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, userId)));
  return c.json({ ok: true });
});

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { createWorkspaceSchema, updateWorkspaceSchema } from '@zhipane/shared';
import { db } from '../db/client';
import { workspaces, workspaceMembers, spaces, spaceMembers } from '@zhipane/db';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { canViewWorkspace, canManageWorkspace } from '../services/permission.service';
import { provisionDefaultWorkspace } from '../services/provision.service';
import { env } from '../env';

export const workspaceRoutes = new Hono<AppEnv>();
workspaceRoutes.use('*', authMiddleware);

workspaceRoutes.get('/', async (c) => {
  const user = c.get('user');
  const result = await db.execute(sql`
    SELECT w.*, wm.role
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ${user.id}
    ORDER BY w.created_at DESC
  `);
  return c.json({ workspaces: result.rows });
});

// On-demand provisioning for accounts that have no workspace yet (e.g. an
// account created before auto-provisioning on registration existed). Idempotent.
workspaceRoutes.post('/provision-default', async (c) => {
  const user = c.get('user');
  const result = await provisionDefaultWorkspace(user.id, user.name);
  if (!result) {
    const existing = await db.execute(sql`
      SELECT w.*, wm.role
      FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = ${user.id}
      ORDER BY w.created_at DESC
    `);
    return c.json({ workspaces: existing.rows, provisioned: false });
  }
  return c.json({ workspace: result.workspace, space: result.space, provisioned: true });
});

workspaceRoutes.post('/', zValidator('json', createWorkspaceSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  const [workspace] = await db.insert(workspaces).values({
    name: input.name,
    embeddingDimension: env.EMBEDDING_DIMENSION,
    embeddingModel: env.AI_EMBEDDING_MODEL
  }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: 'owner' });
  // Every knowledge base owns at least one space (知识库 → 空间 → 笔记).
  // Previously a new workspace had ZERO spaces, so switching to it fell back
  // to "/" and the root redirect bounced back to the previous workspace.
  const [space] = await db.insert(spaces).values({
    workspaceId: workspace.id,
    name: '默认空间',
    spaceKind: 'area',
    lifecycleStatus: 'active'
  }).returning();
  await db.insert(spaceMembers).values({ spaceId: space.id, userId: user.id, role: 'admin' });
  return c.json({ workspace, space }, 201);
});

workspaceRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!(await canViewWorkspace(user.id, id))) return c.json({ error: 'Forbidden' }, 403);
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  if (!workspace) return c.json({ error: 'Not found' }, 404);
  return c.json({ workspace });
});

workspaceRoutes.patch('/:id', zValidator('json', updateWorkspaceSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  if (!(await canManageWorkspace(user.id, id))) return c.json({ error: 'Forbidden' }, 403);
  const [updated] = await db.update(workspaces).set({ ...(input.name ? { name: input.name } : {}), updatedAt: sql`now()` }).where(eq(workspaces.id, id)).returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ workspace: updated });
});

workspaceRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!(await canManageWorkspace(user.id, id))) return c.json({ error: 'Forbidden' }, 403);
  // Soft-delete all pages under this workspace's spaces first (preserves data),
  // then hard-delete spaces + members + workspace.
  await db.execute(sql`
    UPDATE pages SET status = 'deleted', updated_at = now()
    WHERE space_id IN (SELECT id FROM spaces WHERE workspace_id = ${id})
  `);
  await db.delete(spaceMembers).where(eq(spaceMembers.spaceId, sql`(SELECT id FROM spaces WHERE workspace_id = ${id})`));
  await db.delete(spaces).where(eq(spaces.workspaceId, id));
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, id));
  await db.delete(workspaces).where(eq(workspaces.id, id));
  return c.json({ ok: true });
});

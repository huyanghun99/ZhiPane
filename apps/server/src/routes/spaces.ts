import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { createSpaceSchema, updateSpaceSchema } from '@zhipane/shared';
import { db } from '../db/client';
import { spaces, spaceMembers } from '@zhipane/db';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { canManageSpace, canManageWorkspace } from '../services/permission.service';

export const spaceRoutes = new Hono<AppEnv>();
spaceRoutes.use('*', authMiddleware);

spaceRoutes.get('/', async (c) => {
  const user = c.get('user');
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) return c.json({ error: 'workspaceId is required' }, 400);
  // Phase 1 (D1): optional Active/Completed/Archived (and kind) filtering.
  const lifecycleParam = c.req.query('lifecycle');
  const kindParam = c.req.query('kind');
  const lifecycle = (['active', 'on_hold', 'completed', 'archived'] as const).includes(lifecycleParam as never) ? lifecycleParam : null;
  const kind = (['project', 'area', 'resource', 'inbox'] as const).includes(kindParam as never) ? kindParam : null;
  const clauses = [
    sql`s.workspace_id = ${workspaceId}`,
    sql`sm.user_id = ${user.id}`
  ];
  if (lifecycle) clauses.push(sql`s.lifecycle_status = ${lifecycle}`);
  if (kind) clauses.push(sql`s.space_kind = ${kind}`);
  const result = await db.execute(sql`
    SELECT s.*, sm.role,
           s.lifecycle_status AS "lifecycleStatus",
           s.space_kind AS "kind",
           s.workspace_id AS "workspaceId"
    FROM spaces s
    JOIN space_members sm ON sm.space_id = s.id
    WHERE ${sql.join(clauses, sql` AND `)}
    ORDER BY s.created_at DESC
  `);
  return c.json({ spaces: result.rows });
});

spaceRoutes.post('/', zValidator('json', createSpaceSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  if (!(await canManageWorkspace(user.id, input.workspaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [space] = await db.insert(spaces).values({
    workspaceId: input.workspaceId,
    name: input.name,
    aiPrivacyPolicy: input.aiPrivacyPolicy,
    spaceKind: input.spaceKind,
    lifecycleStatus: input.lifecycleStatus,
    archivePolicy: input.archivePolicy ?? { mode: 'manual', inactiveDays: 180, completedGraceDays: 30 }
  }).returning();
  await db.insert(spaceMembers).values({ spaceId: space.id, userId: user.id, role: 'admin' });
  return c.json({ space }, 201);
});

spaceRoutes.patch('/:id', zValidator('json', updateSpaceSchema), async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  if (!(await canManageSpace(user.id, id))) return c.json({ error: 'Forbidden' }, 403);
  const [updated] = await db.update(spaces).set({
    ...(input.name ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.aiPrivacyPolicy ? { aiPrivacyPolicy: input.aiPrivacyPolicy } : {}),
    ...(input.autoLlmProcessing !== undefined ? { autoLlmProcessing: input.autoLlmProcessing } : {}),
    ...(input.spaceKind ? { spaceKind: input.spaceKind } : {}),
    ...(input.lifecycleStatus ? { lifecycleStatus: input.lifecycleStatus } : {}),
    ...(input.startedAt ? { startedAt: new Date(input.startedAt) } : {}),
    ...(input.targetEndAt ? { targetEndAt: new Date(input.targetEndAt) } : {}),
    ...(input.archivePolicy ? { archivePolicy: input.archivePolicy } : {}),
    updatedAt: sql`now()`
  }).where(eq(spaces.id, id)).returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ space: updated });
});

// Phase 1 gate: a Project marked `completed` must NOT be auto-archived. This
// endpoint only records completion; archiving is a separate, deliberate act
// (handled in later phases / via explicit archive).
spaceRoutes.post('/:id/complete', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!(await canManageSpace(user.id, id))) return c.json({ error: 'Forbidden' }, 403);
  const [updated] = await db.update(spaces).set({
    lifecycleStatus: 'completed',
    completedAt: sql`now()`,
    updatedAt: sql`now()`
  }).where(eq(spaces.id, id)).returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ space: updated });
});

spaceRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [space] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1);
  if (!space) return c.json({ error: 'Not found' }, 404);
  if (!(await canManageWorkspace(user.id, space.workspaceId))) return c.json({ error: 'Forbidden' }, 403);
  await db.delete(spaces).where(eq(spaces.id, id));
  return c.json({ ok: true });
});

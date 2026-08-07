import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { createShareSchema } from '@zhipane/shared';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { shares, pages, wikiTopics } from '@zhipane/db';
import { canViewPage } from '../services/permission.service';

export const shareRoutes = new Hono<AppEnv>();
shareRoutes.use('*', authMiddleware);

function generateToken(): string {
  return randomBytes(24).toString('hex');
}

shareRoutes.post('/', zValidator('json', createShareSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  if (input.targetType === 'page') {
    if (!(await canViewPage(user.id, input.targetId))) return c.json({ error: 'Forbidden' }, 403);
  } else {
    const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, input.targetId)).limit(1);
    if (!topic) return c.json({ error: 'Not found' }, 404);
  }
  let snapshotTitle: string | null = null;
  let snapshotContentJson: unknown = null;
  let snapshotTextContent: string | null = null;
  if (input.shareMode === 'snapshot') {
    if (input.targetType === 'page') {
      const [page] = await db.select().from(pages).where(eq(pages.id, input.targetId)).limit(1);
      if (page) { snapshotTitle = page.title; snapshotContentJson = page.contentJson; snapshotTextContent = page.textContent; }
    } else {
      const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, input.targetId)).limit(1);
      if (topic) { snapshotTitle = topic.title; snapshotContentJson = topic.contentJson; snapshotTextContent = topic.textContent; }
    }
  }
  const [share] = await db.insert(shares).values({
    workspaceId: input.workspaceId, targetType: input.targetType, targetId: input.targetId,
    shareToken: generateToken(), shareMode: input.shareMode, snapshotTitle, snapshotContentJson, snapshotTextContent, createdById: user.id
  }).returning();
  return c.json({ share }, 201);
});

shareRoutes.get('/', async (c) => {
  const user = c.get('user');
  const targetType = c.req.query('targetType');
  const targetId = c.req.query('targetId');
  if (!targetType || !targetId) return c.json({ error: 'targetType and targetId are required' }, 400);
  const rows = await db.execute(sql`SELECT * FROM shares WHERE created_by_id = ${user.id} AND target_type = ${targetType} AND target_id = ${targetId} AND is_enabled = TRUE ORDER BY created_at DESC`);
  return c.json({ shares: rows.rows });
});

shareRoutes.delete('/:shareId', async (c) => {
  const user = c.get('user');
  const result = await db.execute(sql`UPDATE shares SET is_enabled = FALSE, disabled_at = now() WHERE id = ${c.req.param('shareId')} AND created_by_id = ${user.id} RETURNING *`);
  if (!result.rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ share: result.rows[0] });
});

shareRoutes.post('/:shareId/regenerate-token', async (c) => {
  const user = c.get('user');
  const result = await db.execute(sql`UPDATE shares SET share_token = ${generateToken()} WHERE id = ${c.req.param('shareId')} AND created_by_id = ${user.id} AND is_enabled = TRUE RETURNING *`);
  if (!result.rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ share: result.rows[0] });
});

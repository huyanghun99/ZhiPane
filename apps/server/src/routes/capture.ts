import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { captureSchema } from '@zhipane/shared';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { pages, spaces } from '@zhipane/db';
import { canEditSpace } from '../services/permission.service';
import { enqueueJob } from '../services/job-runner';
import { getSpacePolicy } from '../services/ai.service';
import { tokenizeChineseFriendly } from '../utils/text';

export const captureRoutes = new Hono<AppEnv>();
captureRoutes.use('*', authMiddleware);

captureRoutes.post('/', zValidator('json', captureSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  if (!(await canEditSpace(user.id, input.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  // Derive the real workspaceId from the space (never trust the client).
  const [space] = await db.select().from(spaces).where(eq(spaces.id, input.spaceId)).limit(1);
  if (!space) return c.json({ error: 'Space not found' }, 404);
  const [page] = await db.insert(pages).values({
    workspaceId: space.workspaceId,
    spaceId: space.id,
    title: input.title,
    contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: input.content }] }] },
    textContent: input.content,
    ftsTokens: tokenizeChineseFriendly(`${input.title}\n${input.content}\n${input.tags.join(' ')}`),
    createdById: user.id,
    updatedById: user.id,
    llmDirtyReason: 'quick_capture'
  }).returning();
  const policy = await getSpacePolicy(space.id);
  if (policy !== 'disabled') {
    await enqueueJob({ workspaceId: page.workspaceId, spaceId: page.spaceId, entityType: 'page', entityId: page.id, type: 'page.process_llm', runAfterSeconds: 30 });
  } else {
    await db.update(pages).set({ llmProcessStatus: 'ignored' }).where(and(eq(pages.id, page.id)));
  }
  return c.json({ page }, 201);
});

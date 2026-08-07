import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { patchEdgeSchema } from '@zhipane/shared';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { pages, wikiTopics } from '@zhipane/db';
import { canViewSpace } from '../services/permission.service';
import { getGraphAroundEntity, getSpaceGraph, getEvidenceCard, acceptEdge, rejectEdge, patchEdge } from '../services/graph.service';

export const graphRoutes = new Hono<AppEnv>();
graphRoutes.use('*', authMiddleware);

async function resolvePageScope(pageId: string) {
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  return page ? { workspaceId: page.workspaceId, spaceId: page.spaceId } : null;
}

async function resolveTopicScope(topicId: string) {
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  return topic ? { workspaceId: topic.workspaceId, spaceId: topic.spaceId } : null;
}

graphRoutes.get('/around-page/:pageId', async (c) => {
  const user = c.get('user');
  const scope = await resolvePageScope(c.req.param('pageId'));
  if (!scope) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, scope.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  return c.json(await getGraphAroundEntity({ ...scope, sourceType: 'page', sourceId: c.req.param('pageId') }));
});

graphRoutes.get('/around-topic/:topicId', async (c) => {
  const user = c.get('user');
  const scope = await resolveTopicScope(c.req.param('topicId'));
  if (!scope) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, scope.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  return c.json(await getGraphAroundEntity({ ...scope, sourceType: 'topic', sourceId: c.req.param('topicId') }));
});

graphRoutes.get('/around-entity/:entityId', async (c) => {
  const user = c.get('user');
  const workspaceId = c.req.query('workspaceId');
  const spaceId = c.req.query('spaceId');
  if (!workspaceId || !spaceId) return c.json({ error: 'workspaceId and spaceId are required' }, 400);
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  return c.json(await getGraphAroundEntity({ workspaceId, spaceId, sourceType: 'entity', sourceId: c.req.param('entityId') }));
});

graphRoutes.get('/space/:spaceId', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const result = await db.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM spaces WHERE id = ${spaceId} LIMIT 1`);
  if (!result.rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json(await getSpaceGraph(result.rows[0].workspace_id, spaceId));
});

graphRoutes.get('/edges/:edgeId/evidence', async (c) => {
  const edge = await getEvidenceCard(c.req.param('edgeId'));
  if (!edge) return c.json({ error: 'Not found' }, 404);
  return c.json({ edge });
});

graphRoutes.post('/edges/:edgeId/accept', async (c) => {
  const user = c.get('user');
  const edge = await getEvidenceCard(c.req.param('edgeId'));
  if (!edge) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, edge.space_id))) return c.json({ error: 'Forbidden' }, 403);
  return c.json({ edge: await acceptEdge(c.req.param('edgeId'), user.id) });
});

graphRoutes.post('/edges/:edgeId/reject', async (c) => {
  const user = c.get('user');
  const edge = await getEvidenceCard(c.req.param('edgeId'));
  if (!edge) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, edge.space_id))) return c.json({ error: 'Forbidden' }, 403);
  return c.json({ edge: await rejectEdge(c.req.param('edgeId')) });
});

graphRoutes.patch('/edges/:edgeId', zValidator('json', patchEdgeSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  const edge = await getEvidenceCard(c.req.param('edgeId'));
  if (!edge) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, edge.space_id))) return c.json({ error: 'Forbidden' }, 403);
  return c.json({ edge: await patchEdge(c.req.param('edgeId'), input) });
});

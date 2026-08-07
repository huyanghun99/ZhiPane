import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createTopicSchema, updateTopicSchema } from '@zhipane/shared';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { pages, pageKnowledgeMaps, knowledgeClaims, wikiTopics, llmSuggestions, spaces, topicCandidates, topicOperations } from '@zhipane/db';
import { canEditSpace, canViewSpace, canEditPage, canManageSpace } from '../services/permission.service';
import { getSpacePolicy, isAiDisabledError, createAiProviderForContext } from '../services/ai.service';
import { enqueueJob } from '../services/job-runner';
import { confirmEdgesForSuggestion } from '../services/graph.service';
import { undoSuggestion, promoteCandidate, dismissCandidate, generateRefreshDiff, applyRefreshDiff, mergeTopics, splitTopic, undoTopicOperation, archiveTopic, reactivateTopic, deleteTopic, retryFailedTopicSynthesis, assignCandidateToTopic, degradeTopicToFacet } from '../services/wiki.service';
import { recordActivity, getActivityStats, listActivityEvents } from '../services/activity.service';
import { evaluateLifecycle, LIFECYCLE_SUGGESTION_TYPES } from '../services/lifecycle.service';
import { getKnowledgeMetrics } from '../services/knowledge-metrics';
import { generateClosurePackage, storeClosurePackage, getClosurePackage, deriveTopicToSpace } from '../services/closure.service';
import type { ActivityEventType } from '@zhipane/shared';

export const llmWikiRoutes = new Hono<AppEnv>();
llmWikiRoutes.use('*', authMiddleware);

llmWikiRoutes.get('/pages/:pageId/knowledge-map', async (c) => {
  const user = c.get('user');
  const [page] = await db.select().from(pages).where(eq(pages.id, c.req.param('pageId'))).limit(1);
  if (!page || !(await canViewSpace(user.id, page.spaceId))) return c.json({ error: 'Not found' }, 404);
  const [map] = await db.select().from(pageKnowledgeMaps).where(and(eq(pageKnowledgeMaps.pageId, page.id), eq(pageKnowledgeMaps.contentVersion, page.contentVersion))).limit(1);
  const claims = map ? await db.select().from(knowledgeClaims).where(eq(knowledgeClaims.knowledgeMapId, map.id)).limit(200) : [];
  return c.json({ map, claims });
});

llmWikiRoutes.get('/knowledge-metrics', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.query('spaceId');
  if (!spaceId || !(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  return c.json({ metrics: getKnowledgeMetrics().filter((item) => !item.pageId || item.pageId) });
});

llmWikiRoutes.get('/inbox', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.query('spaceId');
  if (!spaceId) return c.json({ error: 'spaceId is required' }, 400);
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.select().from(pages).where(sql`space_id = ${spaceId} AND llm_process_status = 'pending' AND status = 'normal'`).limit(100);
  return c.json({ inbox: rows });
});

llmWikiRoutes.post('/pages/:pageId/process-now', async (c) => {
  const user = c.get('user');
  const pageId = c.req.param('pageId');
  if (!(await canEditPage(user.id, pageId))) return c.json({ error: 'Forbidden' }, 403);
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page) return c.json({ error: 'Not found' }, 404);
  if ((await getSpacePolicy(page.spaceId)) === 'disabled') {
    return c.json({ error: 'AI is disabled for this space' }, 400);
  }
  await db.update(pages).set({ llmProcessStatus: 'pending', llmDirtyReason: 'manual_trigger', updatedAt: sql`now()` }).where(eq(pages.id, pageId));
  await enqueueJob({ workspaceId: page.workspaceId, spaceId: page.spaceId, entityType: 'page', entityId: page.id, type: 'page.process_llm', runAfterSeconds: 0, priority: 10 });
  return c.json({ ok: true });
});

// Re-process every normal page in a space: re-indexes AND regenerates Topics /
// Suggestions. Useful to backfill the LLM Wiki after the generator ships, or to
// refresh artifacts for an existing corpus.
llmWikiRoutes.post('/spaces/:spaceId/reprocess', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  if (!(await canEditSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  if ((await getSpacePolicy(spaceId)) === 'disabled') {
    return c.json({ error: 'AI is disabled for this space' }, 400);
  }
  const rows = await db.execute<any>(sql`
    SELECT id, workspace_id, space_id FROM pages WHERE space_id = ${spaceId} AND status = 'normal'
  `);
  for (const p of rows.rows) {
    await db.update(pages).set({ llmProcessStatus: 'pending', llmDirtyReason: 'bulk_reprocess', updatedAt: sql`now()` }).where(eq(pages.id, p.id));
    await enqueueJob({ workspaceId: p.workspace_id, spaceId: p.space_id, entityType: 'page', entityId: p.id, type: 'page.process_llm', runAfterSeconds: 0, priority: 10 });
  }
  return c.json({ ok: true, enqueued: rows.rows.length });
});

llmWikiRoutes.post('/spaces/:spaceId/pause', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  if (!(await canEditSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [updated] = await db.update(spaces).set({ autoLlmProcessing: false, updatedAt: sql`now()` }).where(eq(spaces.id, spaceId)).returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ space: updated });
});

llmWikiRoutes.post('/spaces/:spaceId/resume', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  if (!(await canEditSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [updated] = await db.update(spaces).set({ autoLlmProcessing: true, updatedAt: sql`now()` }).where(eq(spaces.id, spaceId)).returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ space: updated });
});

llmWikiRoutes.get('/topics', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.query('spaceId');
  if (!spaceId) return c.json({ error: 'spaceId is required' }, 400);
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  // Phase 0 task 3: archived topics are excluded by default; opt-in via
  // ?includeArchived=true so callers can still reach them deliberately.
  // Phase 1 (D4): archived is now a *lifecycle* axis, independent of `stale`
  // (freshness). We exclude on lifecycle_status, falling back to the legacy
  // `status` column for any row not yet backfilled.
  const includeArchived = c.req.query('includeArchived') === 'true';
  const lifecycleParam = c.req.query('lifecycle');
  const lifecycle = (['active', 'cooling', 'dormant', 'archived'] as const).includes(lifecycleParam as never)
    ? lifecycleParam
    : null;
  const clauses = [eq(wikiTopics.spaceId, spaceId)];
  if (lifecycle) clauses.push(sql`${wikiTopics.lifecycleStatus} = ${lifecycle}`);
  // Default behaviour hides archived topics (Phase 0 task 3). But an explicit
  // `lifecycle` filter is an intentional scope — e.g. `?lifecycle=archived`
  // must return archived topics — so we skip the exclusion in that case.
  if (!includeArchived && !lifecycle) {
    clauses.push(sql`(${wikiTopics.lifecycleStatus} IS NULL OR ${wikiTopics.lifecycleStatus} <> 'archived')`);
    clauses.push(sql`(${wikiTopics.status} IS NULL OR ${wikiTopics.status} <> 'archived')`);
  }
  const rows = await db.select().from(wikiTopics).where(and(...clauses)).limit(100);
  return c.json({ topics: rows });
});

llmWikiRoutes.post('/topics', zValidator('json', createTopicSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  if (!(await canEditSpace(user.id, input.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [topic] = await db.insert(wikiTopics).values({
    workspaceId: input.workspaceId, spaceId: input.spaceId, title: input.title,
    contentJson: input.contentJson ?? { type: 'doc', content: [] }, aiSummary: input.aiSummary ?? '',
    status: 'accepted', source: 'user_created', createdById: user.id,
    // Phase 1 (D4): a user-created topic is published, fresh and active.
    publicationStatus: 'accepted', freshnessStatus: 'fresh', lifecycleStatus: 'active'
  }).returning();
  return c.json({ topic }, 201);
});

llmWikiRoutes.post('/topics/:topicId/retry-synthesis', async (c) => {
  const user = c.get('user');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, c.req.param('topicId'))).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  try {
    const ai = await createAiProviderForContext({ workspaceId: topic.workspaceId, spaceId: topic.spaceId });
    const result = await retryFailedTopicSynthesis(topic.id, ai);
    if (!result.ok) return c.json({ error: result.error ?? '综合仍未通过质量检查' }, 422);
    const [updated] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topic.id)).limit(1);
    return c.json({ topic: updated });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '重试失败' }, 500);
  }
});

llmWikiRoutes.get('/topics/:topicId', async (c) => {
  const user = c.get('user');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, c.req.param('topicId'))).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  // Phase 4: a merged topic is a redirect stub — surface where it points so the
  // client can transparently follow the merge (old links keep working).
  const redirectedTo = topic.mergedIntoTopicId ?? undefined;
  // Phase 5 (F3): a topic detail view is a genuine user action — record it.
  await recordActivity({ workspaceId: topic.workspaceId, spaceId: topic.spaceId, entityType: 'topic', entityId: topic.id, eventType: 'view', userId: user.id }).catch(() => {});
  return c.json({ topic, redirectedTo });
});

llmWikiRoutes.patch('/topics/:topicId', zValidator('json', updateTopicSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, c.req.param('topicId'))).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  // Phase 0 task 4: editing the title or body is a user edit — mark the topic
  // `user_edited` so AI refresh / overwrite policies never silently clobber it.
  // Phase 1 (D4): keep the three status axes in sync with the legacy `status`.
  const isArchive = input.status === 'archived';
  const set: Record<string, unknown> = {
    ...(input.title ? { title: input.title, status: 'user_edited', publicationStatus: 'user_edited', userEditedAt: sql`now()` } : {}),
    ...(input.contentJson !== undefined ? { contentJson: input.contentJson, status: 'user_edited', publicationStatus: 'user_edited', userEditedAt: sql`now()` } : {}),
    ...(input.status ? { status: input.status, userEditedAt: sql`now()` } : {}),
    ...(input.updatePolicy ? { updatePolicy: input.updatePolicy } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.lifecycleStatus ? { lifecycleStatus: input.lifecycleStatus } : {})
  };
  // Archiving is a deliberate lifecycle transition (legacy + new axis).
  if (isArchive) {
    set.lifecycleStatus = 'archived';
    set.archivedAt = sql`now()`;
    set.archiveReason = 'manual';
  }
  const [updated] = await db.update(wikiTopics).set(set).where(eq(wikiTopics.id, c.req.param('topicId'))).returning();
  // Phase 5 (F3): editing the title or body is a genuine user edit — record it.
  if (input.title || input.contentJson !== undefined) {
    await recordActivity({ workspaceId: updated.workspaceId, spaceId: updated.spaceId, entityType: 'topic', entityId: updated.id, eventType: 'edit', userId: user.id }).catch(() => {});
  }
  return c.json({ topic: updated });
});

// Phase B (B2.3): soft-delete a Topic. Reachable only by an editor; the Topic
// is archived with reason 'deleted' (never hard-deleted) so it stays auditable
// and recoverable. Hidden from the default list, visible via ?lifecycle=archived.
llmWikiRoutes.delete('/topics/:topicId', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  await deleteTopic(topicId, user.id);
  return c.json({ ok: true });
});

llmWikiRoutes.post('/topics/:topicId/accept', async (c) => {
  const user = c.get('user');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, c.req.param('topicId'))).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [updated] = await db.update(wikiTopics).set({ status: 'accepted', updatedAt: sql`now()` }).where(eq(wikiTopics.id, c.req.param('topicId'))).returning();
  return c.json({ topic: updated });
});

// Revert an accepted topic back to `suggested` (undo of the accept action).
llmWikiRoutes.post('/topics/:topicId/undo', async (c) => {
  const user = c.get('user');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, c.req.param('topicId'))).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [updated] = await db.update(wikiTopics).set({ status: 'suggested', updatedAt: sql`now()` }).where(eq(wikiTopics.id, c.req.param('topicId'))).returning();
  return c.json({ topic: updated });
});

// Spec §22.4: trigger refresh suggestions for a (stale) topic.
llmWikiRoutes.post('/topics/:topicId/refresh-suggestions', async (c) => {
  const user = c.get('user');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, c.req.param('topicId'))).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  await enqueueJob({
    workspaceId: topic.workspaceId,
    spaceId: topic.spaceId,
    entityType: 'topic',
    entityId: topic.id,
    type: 'topic.refresh_suggestions',
    runAfterSeconds: 0
  });
  return c.json({ ok: true, topicId: topic.id });
});

// Phase 4 (E5): generate an itemised refresh diff for a (stale) Topic without
// overwriting it. The diff is stored as a pending suggestion for item-by-item
// application. Never mutates the topic body here.
llmWikiRoutes.post('/topics/:topicId/refresh-diff', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  let ai: Awaited<ReturnType<typeof createAiProviderForContext>>;
  try {
    ai = await createAiProviderForContext({ workspaceId: topic.workspaceId, spaceId: topic.spaceId, userId: user.id });
  } catch (err) {
    if (isAiDisabledError(err)) return c.json({ error: 'AI is disabled for this space' }, 400);
    throw err;
  }
  const diff = await generateRefreshDiff(topicId, ai);
  if (!diff) return c.json({ error: 'could not generate a refresh diff (AI unavailable or no sources)' }, 422);
  return c.json({ ok: true, diff });
});

// Phase 4 (E5): fetch the stored refresh diff (if any) for a Topic.
llmWikiRoutes.get('/topics/:topicId/refresh-diff', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.execute<any>(sql`
    SELECT payload FROM llm_suggestions
    WHERE topic_id = ${topicId} AND type = 'topic_refresh_diff' AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `);
  const diff = rows.rows[0]?.payload?.diff ?? null;
  return c.json({ diff });
});

// Phase 4 (E5): apply selected items of a refresh diff to a Topic, item-by-item.
llmWikiRoutes.post('/topics/:topicId/apply-refresh', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json<{ itemIndexes?: number[] }>().catch(() => ({ itemIndexes: [] }));
  const itemIndexes = Array.isArray(body.itemIndexes) ? body.itemIndexes : [];
  if (itemIndexes.length === 0) return c.json({ error: 'no items selected' }, 400);
  const result = await applyRefreshDiff(topicId, itemIndexes, user.id);
  const [updated] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  return c.json({ ok: true, ...result, topic: updated });
});

// Phase 4: merge a Topic INTO another. The merged topic becomes a redirect stub.
llmWikiRoutes.post('/topics/:topicId/merge', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json<{ targetTopicId: string }>();
  if (!body.targetTopicId) return c.json({ error: 'targetTopicId is required' }, 400);
  const { operationId } = await mergeTopics(body.targetTopicId, topicId, user.id);
  const [survivor] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, body.targetTopicId)).limit(1);
  const [merged] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  return c.json({ ok: true, operationId, survivor, merged });
});

// Phase 4: split selected keyPoints of a Topic into a new Topic.
llmWikiRoutes.post('/topics/:topicId/split', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json<{ title: string; keyPointIds: string[] }>();
  if (!body.title || !Array.isArray(body.keyPointIds) || body.keyPointIds.length === 0) {
    return c.json({ error: 'title and keyPointIds are required' }, 400);
  }
  const { topicId: newTopicId, operationId } = await splitTopic(topicId, body.title, body.keyPointIds, user.id);
  const [newTopic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, newTopicId)).limit(1);
  const [parent] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  return c.json({ ok: true, operationId, topic: newTopic, parent }, 201);
});

// Phase 4: list reversible operations (merge / split) for a Topic.
llmWikiRoutes.get('/topics/:topicId/operations', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.select().from(topicOperations).where(sql`topic_id = ${topicId} OR target_topic_id = ${topicId}`).orderBy(sql`created_at DESC`);
  return c.json({ operations: rows });
});

// Phase 4: undo a recorded merge / split operation (fully reversible).
llmWikiRoutes.post('/topics/operations/:opId/undo', async (c) => {
  const user = c.get('user');
  const opId = c.req.param('opId');
  const [op] = await db.select().from(topicOperations).where(eq(topicOperations.id, opId)).limit(1);
  if (!op) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, op.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  await undoTopicOperation(opId, user.id);
  return c.json({ ok: true });
});

llmWikiRoutes.post('/topics/:topicId/degrade', async (c) => {
  const user = c.get('user');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, c.req.param('topicId'))).limit(1);
  if (!topic || !(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Not found' }, 404);
  await degradeTopicToFacet(topic.id, user.id);
  return c.json({ ok: true });
});

// Phase 5 (F3): record a generic real user activity event (e.g. search click,
// citation open) emitted by the UI. Background tasks MUST NOT call this. The
// caller supplies the entity's spaceId for a permission check; we verify the
// user can at least view that space before writing the event.
llmWikiRoutes.post('/activity', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ spaceId: string; entityType: 'topic' | 'page'; entityId: string; eventType: string; metadata?: Record<string, unknown> }>().catch(() => null);
  if (!body || !body.spaceId || !body.entityId || !body.eventType) return c.json({ error: 'spaceId, entityId and eventType are required' }, 400);
  if (!(await canViewSpace(user.id, body.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const wsRow = (await db.select({ ws: spaces.workspaceId }).from(spaces).where(eq(spaces.id, body.spaceId)).limit(1)).at(0);
  await recordActivity({
    workspaceId: wsRow?.ws ?? '',
    spaceId: body.spaceId,
    entityType: body.entityType, entityId: body.entityId, eventType: body.eventType as ActivityEventType, userId: user.id, metadata: body.metadata
  }).catch(() => {});
  return c.json({ ok: true });
});

// Phase 5 (F3): fetch rolled-up activity stats for a Topic.
llmWikiRoutes.get('/topics/:topicId/activity', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const stats = await getActivityStats('topic', topicId);
  const events = await listActivityEvents('topic', topicId, 50);
  return c.json({ stats, events });
});

// Phase 5: archive a Topic (deliberate user action — the "归档中心").
llmWikiRoutes.post('/topics/:topicId/archive', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: 'manual' as const }));
  await archiveTopic(topicId, user.id, body.reason ?? 'manual');
  const [updated] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  return c.json({ topic: updated });
});

// Phase 5: reactivate an archived Topic (recovery path of the archive center).
llmWikiRoutes.post('/topics/:topicId/reactivate', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  await reactivateTopic(topicId, user.id);
  const [updated] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  return c.json({ topic: updated });
});

// Phase 5 (F4): run the lifecycle evaluation Job for a Space (or whole workspace).
// Generates Suggestions only — never archives directly. Idempotent.
llmWikiRoutes.post('/lifecycle/evaluate', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ workspaceId?: string; spaceId?: string }>().catch(() => ({}) as { workspaceId?: string; spaceId?: string });
  if (body.spaceId && !(await canEditSpace(user.id, body.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const { suggestions } = await evaluateLifecycle(body.workspaceId, body.spaceId);
  return c.json({ ok: true, suggestions });
});

// Phase 5 (F4): list pending lifecycle Suggestions for a Space (归档中心 / 生命周期面板).
llmWikiRoutes.get('/lifecycle/suggestions', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.query('spaceId');
  if (!spaceId) return c.json({ error: 'spaceId is required' }, 400);
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const types = LIFECYCLE_SUGGESTION_TYPES.map((t) => `'${t}'`).join(',');
  const rows = await db.execute<any>(sql`
    SELECT * FROM llm_suggestions
    WHERE space_id = ${spaceId} AND type IN (${sql.raw(types)}) AND status = 'pending'
    ORDER BY created_at DESC
  `);
  return c.json({ suggestions: rows.rows });
});

// Phase 6 (F1): generate + store a project closure package (AI suggestions only
// — never moves/derives Topics; that is a separate user-confirmed action).
llmWikiRoutes.post('/projects/:spaceId/closure', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  let ai: Awaited<ReturnType<typeof createAiProviderForContext>> | undefined;
  try {
    ai = await createAiProviderForContext({ workspaceId: space.workspaceId, spaceId, userId: user.id });
  } catch (err) {
    if (isAiDisabledError(err)) ai = undefined;
    else throw err;
  }
  const pkg = await generateClosurePackage(spaceId, ai);
  await storeClosurePackage(spaceId, pkg, user.id);
  return c.json({ ok: true, closure: pkg });
});

// Phase 6 (F1): fetch the stored closure package for a project.
llmWikiRoutes.get('/projects/:spaceId/closure', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const closure = await getClosurePackage(spaceId);
  return c.json({ closure });
});

// Phase 6 (F2): confirm a recommended promotion — derive the Topic into the
// target Space. AI only *suggested* it; this is the explicit user action.
llmWikiRoutes.post('/projects/:spaceId/closure/promote', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json<{ topicId: string; targetSpaceId: string; newTitle?: string }>().catch(() => null);
  if (!body || !body.topicId || !body.targetSpaceId) return c.json({ error: 'topicId and targetSpaceId are required' }, 400);
  const { topicId, operationId } = await deriveTopicToSpace(body.topicId, body.targetSpaceId, user.id, body.newTitle);
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  return c.json({ ok: true, topicId, operationId, topic });
});

// Phase 6 (F1/F2): the final step of the archive wizard — archive the project
// Space. Sets lifecycle_status='archived' and down-weights (NOT deletes) its
// Topics, so they stay searchable / citable / recoverable (spec rule 10).
llmWikiRoutes.post('/projects/:spaceId/archive', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ error: 'Not found' }, 404);
  if (!(await canManageSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  await db.execute(sql`UPDATE spaces SET lifecycle_status = 'archived', archived_at = now(), updated_at = now() WHERE id = ${spaceId}`);
  await db.execute(sql`
    UPDATE wiki_topics
    SET lifecycle_status = 'archived', status = 'archived', archived_at = now(), updated_at = now()
    WHERE space_id = ${spaceId} AND merged_into_topic_id IS NULL AND lifecycle_status <> 'archived'
  `);
  const [updated] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  return c.json({ space: updated });
});

// Phase 6 (F2): general user-confirmed Topic derivation (copy into another Space).
// The original Topic is preserved with full history (gate: 原项目历史完整).
llmWikiRoutes.post('/topics/:topicId/derive', async (c) => {
  const user = c.get('user');
  const topicId = c.req.param('topicId');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json<{ targetSpaceId: string; newTitle?: string }>().catch(() => null);
  if (!body || !body.targetSpaceId) return c.json({ error: 'targetSpaceId is required' }, 400);
  const { topicId: newId, operationId } = await deriveTopicToSpace(topicId, body.targetSpaceId, user.id, body.newTitle);
  const [newTopic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, newId)).limit(1);
  return c.json({ ok: true, topicId: newId, operationId, topic: newTopic });
});

// Source pages that back a topic (drives the Topic Center detail view).
llmWikiRoutes.get('/topics/:topicId/sources', async (c) => {
  const user = c.get('user');
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, c.req.param('topicId'))).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  if (!(await canViewSpace(user.id, topic.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.execute<any>(sql`
    SELECT p.id, p.title FROM topic_sources ts
    JOIN pages p ON p.id = ts.page_id
    WHERE ts.topic_id = ${topic.id}
    ORDER BY p.updated_at DESC LIMIT 50
  `);
  return c.json({ sources: rows.rows });
});

// Phase 0 task 6: surface pages whose Wiki artifact generation failed, so the
// UI can show a persistent, retryable warning instead of a silent success.
llmWikiRoutes.get('/spaces/:spaceId/wiki-errors', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.execute<any>(sql`
    SELECT id, title, wiki_error_message FROM pages
    WHERE space_id = ${spaceId} AND wiki_error_message IS NOT NULL AND status = 'normal'
    ORDER BY updated_at DESC LIMIT 100
  `);
  return c.json({ errors: rows.rows });
});

llmWikiRoutes.get('/suggestions', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.query('spaceId');
  if (!spaceId) return c.json({ error: 'spaceId is required' }, 400);
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const pageId = c.req.query('pageId');
  const where = pageId
    ? sql`space_id = ${spaceId} AND status = 'pending' AND page_id = ${pageId}::uuid`
    : sql`space_id = ${spaceId} AND status = 'pending'`;
  const rows = await db.select().from(llmSuggestions).where(where).limit(200);
  return c.json({ suggestions: rows });
});

// Phase 2 (D2): Candidate endpoints. A page only ever produces *candidates*;
// these let the UI list and promote / dismiss them without auto-creating
// formal Topics during page processing.
// Phase B (B1.3): trigger Space clustering asynchronously. Aggregates the
// space's candidates into formal Topics (alias / embedding / LLM fuzzy
// matching). Instead of running inline (which could hang the HTTP connection
// on a large Space — T3), we enqueue a `space.consolidate_topic_candidates`
// job and return its id; the UI polls /api/jobs/:id for progress. The same job
// is also enqueued automatically after each page is indexed (see job-runner).
llmWikiRoutes.post('/spaces/:spaceId/consolidate', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  if (!(await canEditSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ error: 'Not found' }, 404);
  // Short-circuit: a disabled space has no AI/embedding work to do.
  if ((await getSpacePolicy(spaceId)) === 'disabled') {
    return c.json({ error: 'AI is disabled for this space' }, 400);
  }
  const { jobId } = await enqueueJob({
    workspaceId: space.workspaceId,
    spaceId: space.id,
    entityType: 'space',
    entityId: space.id,
    type: 'space.consolidate_topic_candidates',
    runAfterSeconds: 0,
    priority: 200,
    dedupeKey: `space:${space.id}:consolidate`
  });
  return c.json({ ok: true, jobId });
});

llmWikiRoutes.get('/candidates', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.query('spaceId');
  if (!spaceId) return c.json({ error: 'spaceId is required' }, 400);
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const pageId = c.req.query('pageId');
  const status = c.req.query('status') ?? 'candidate';
  const filter = pageId
    ? sql`space_id = ${spaceId} AND status = ${status} AND page_id = ${pageId}::uuid`
    : sql`space_id = ${spaceId} AND status = ${status}`;
  const rows = await db.select().from(topicCandidates).where(filter).limit(200);
  return c.json({ candidates: rows });
});

llmWikiRoutes.post('/candidates/:id/promote', async (c) => {
  const user = c.get('user');
  const [cand] = await db.select().from(topicCandidates).where(eq(topicCandidates.id, c.req.param('id'))).limit(1);
  if (!cand) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, cand.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const { topicId } = await promoteCandidate(cand.id, user.id);
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  return c.json({ topic }, 201);
});

llmWikiRoutes.post('/candidates/:id/assign', async (c) => {
  const user = c.get('user');
  const [candidate] = await db.select().from(topicCandidates).where(eq(topicCandidates.id, c.req.param('id'))).limit(1);
  if (!candidate || !(await canEditSpace(user.id, candidate.spaceId))) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json<{ topicId?: string }>();
  if (!body.topicId) return c.json({ error: 'topicId is required' }, 400);
  await assignCandidateToTopic(candidate.id, body.topicId);
  return c.json({ ok: true });
});

llmWikiRoutes.post('/candidates/:id/dismiss', async (c) => {
  const user = c.get('user');
  const [cand] = await db.select().from(topicCandidates).where(eq(topicCandidates.id, c.req.param('id'))).limit(1);
  if (!cand) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, cand.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  await dismissCandidate(cand.id);
  return c.json({ ok: true });
});

llmWikiRoutes.post('/suggestions/:id/accept', async (c) => {
  const user = c.get('user');
  const [suggestion] = await db.select().from(llmSuggestions).where(eq(llmSuggestions.id, c.req.param('id'))).limit(1);
  if (!suggestion) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, suggestion.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  // Phase 2 (D2): accepting a candidate suggestion promotes it to a formal Topic.
  if (suggestion.type === 'topic_candidate') {
    const candidateId = (suggestion.payload as { candidateId?: string }).candidateId;
    if (candidateId) {
      const { topicId } = await promoteCandidate(candidateId, user.id);
      const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
      return c.json({ suggestion: { ...suggestion, status: 'accepted' }, topic });
    }
  }
  const [updated] = await db.update(llmSuggestions).set({ status: 'accepted', updatedAt: sql`now()` }).where(eq(llmSuggestions.id, c.req.param('id'))).returning();
  // M6: accepting a cross-link / topic proposal confirms the implied graph edge.
  try { await confirmEdgesForSuggestion(updated as unknown as { type: string; payload: Record<string, unknown> }); } catch { /* non-fatal */ }
  return c.json({ suggestion: updated });
});

llmWikiRoutes.post('/suggestions/:id/ignore', async (c) => {
  const user = c.get('user');
  const [suggestion] = await db.select().from(llmSuggestions).where(eq(llmSuggestions.id, c.req.param('id'))).limit(1);
  if (!suggestion) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, suggestion.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [updated] = await db.update(llmSuggestions).set({ status: 'ignored', updatedAt: sql`now()` }).where(eq(llmSuggestions.id, c.req.param('id'))).returning();
  return c.json({ suggestion: updated });
});

// Revert a previously accepted suggestion. Restores the suggestion to
// `pending` and undoes the side-effect it caused (topic / edge). Keeps
// every AI-driven change reversible (trustworthy-AI acceptance criterion).
llmWikiRoutes.post('/suggestions/:id/undo', async (c) => {
  const user = c.get('user');
  const [suggestion] = await db.select().from(llmSuggestions).where(eq(llmSuggestions.id, c.req.param('id'))).limit(1);
  if (!suggestion) return c.json({ error: 'Not found' }, 404);
  if (!(await canEditSpace(user.id, suggestion.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  await undoSuggestion(c.req.param('id'));
  const [updated] = await db.select().from(llmSuggestions).where(eq(llmSuggestions.id, c.req.param('id'))).limit(1);
  return c.json({ suggestion: updated });
});

llmWikiRoutes.post('/suggestions/bulk-accept', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ spaceId: string; ids: string[] }>();
  if (!(await canEditSpace(user.id, body.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.select({ id: llmSuggestions.id, type: llmSuggestions.type, payload: llmSuggestions.payload }).from(llmSuggestions).where(and(eq(llmSuggestions.spaceId, body.spaceId), inArray(llmSuggestions.id, body.ids)));
  await db.update(llmSuggestions).set({ status: 'accepted', updatedAt: new Date() }).where(and(eq(llmSuggestions.spaceId, body.spaceId), inArray(llmSuggestions.id, body.ids)));
  // P0-1 (LLM wiki优化.md): bulk-accept must go through the same domain
  // service as single accept. For topic_candidate suggestions, promote each
  // one to a formal Topic via promoteCandidate instead of only flipping the
  // suggestion status (otherwise batch and single accept diverge).
  const promotedTopics: { topicId: string; suggestionId: string }[] = [];
  for (const r of rows) {
    if (r.type === 'topic_candidate') {
      const candidateId = (r.payload as { candidateId?: string }).candidateId;
      if (candidateId) {
        try {
          const { topicId } = await promoteCandidate(candidateId, user.id);
          promotedTopics.push({ topicId, suggestionId: r.id });
        } catch { /* a single failure must not abort the whole batch */ }
      }
      continue;
    }
    // M6: confirm the implied graph edges for non-candidate suggestions.
    try { await confirmEdgesForSuggestion(r as { type: string; payload: Record<string, unknown> }); } catch { /* non-fatal */ }
  }
  return c.json({ ok: true, promotedTopics });
});

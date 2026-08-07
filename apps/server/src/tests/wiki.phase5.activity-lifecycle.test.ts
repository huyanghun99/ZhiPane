import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAiProvider } from '@zhipane/ai';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb, sessionCookie, runPendingJob } from './test-utils';
import { createApp } from '../app';
import { wikiTopics, spaces, knowledgeEdges } from '@zhipane/db';
import { hybridSearch } from '../services/search.service';
import { indexTopicForSearch } from '../services/wiki.service';
import { recordActivity, getActivityStats } from '../services/activity.service';
import { evaluateLifecycle } from '../services/lifecycle.service';
import type { TopicSynthesis } from '@zhipane/shared';

vi.mock('../services/ai.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createAiProviderForContext: vi.fn(async () => new MockAiProvider()) };
});

const ai = () => new MockAiProvider();
const SYNC = 'topic-synthesis-v1' as const;

function makeSynthesis(keyPointTitles: string[]): TopicSynthesis {
  return {
    schemaVersion: SYNC,
    definition: keyPointTitles.join('、'),
    overview: 'overview text',
    keyPoints: keyPointTitles.map((t, i) => ({
      id: `kp-${i + 1}`,
      title: t,
      content: `${t} shared knowledge content`,
      citations: [{ chunkId: 'missing', pageId: 'missing', excerpt: '' }]
    })),
    subtopics: [],
    conflicts: [],
    decisions: [],
    openQuestions: [],
    relatedTopicIds: [],
    generatedFromContentVersions: []
  };
}

async function processPage(user: { id: string }, spaceId: string, title: string, textContent: string): Promise<string> {
  const app = createApp();
  const cookie = await sessionCookie(user);
  const res = await app.request('/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ spaceId, title, textContent })
  });
  const pageId = (await res.json()).page.id;
  await db.execute(sql`UPDATE jobs SET run_after = now() WHERE entity_id = ${pageId} AND status = 'pending'`);
  await runPendingJob();
  return pageId;
}

const DAY = 24 * 60 * 60 * 1000;

async function makeTopic(sp: { id: string; workspaceId: string }, user: { id: string }, overrides: Record<string, unknown> = {}) {
  const [t] = await db
    .insert(wikiTopics)
    .values({
      workspaceId: sp.workspaceId,
      spaceId: sp.id,
      title: (overrides.title as string) ?? 'Topic',
      contentJson: makeSynthesis([(overrides.kp as string) ?? 'Alpha']) as unknown,
      textContent: 'body',
      status: 'accepted',
      source: 'ai_generated',
      publicationStatus: 'accepted',
      freshnessStatus: 'fresh',
      lifecycleStatus: 'active',
      createdById: user.id,
      ...overrides
    })
    .returning();
  return t;
}

describe('Phase 5 — activity & lifecycle', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  /* ---- Gate 1: 后台任务不伪造活跃度 (background jobs do NOT fake activity) ---- */
  it('records no activity from background indexing / artifact / stale jobs', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    // A topic that exists before any background work.
    const topic = await makeTopic(sp, user, { kp: 'Alpha' });

    // Run the page-processing pipeline (indexing + artifact generation + stale
    // marking + consolidate enqueue) — all background, best-effort jobs.
    await processPage(user, sp.id, 'Background page', '# Background\nThis page is processed by the background job only.');

    // Gate: zero activity events were written by any background task.
    const events = await db.execute<any>(sql`SELECT * FROM knowledge_activity_events`);
    expect(events.rows).toHaveLength(0);

    // The pre-existing topic was not touched: no stats row, no last-activity stamp.
    const stats = await getActivityStats('topic', topic.id);
    expect(stats).toBeNull();
    const [t] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}`).limit(1);
    expect(t.lastMeaningfulActivityAt).toBeNull();
  });

  /* ---- Gate 2: 保护规则生效 (protection rules block archive suggestions) ---- */
  it('does not suggest archiving protected topics, but does for an inactive unprotected one', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const area = await makeSpace(ws, user, 'area-space', 'cloud_allowed');

    const past = new Date(Date.now() - 200 * DAY);

    // 1) pinned
    const pinned = await makeTopic(area, user, { title: 'Pinned', kp: 'Pinned', pinned: true, lastMeaningfulActivityAt: past });
    // 2) user_edited
    const userEdited = await makeTopic(area, user, { title: 'UserEdited', kp: 'UserEdited', publicationStatus: 'user_edited', lastMeaningfulActivityAt: past });
    // 3) keepActiveUntil in the future
    const keepActive = await makeTopic(area, user, { title: 'KeepActive', kp: 'KeepActive', keepActiveUntil: new Date(Date.now() + 10 * DAY), lastMeaningfulActivityAt: past });
    // 4) has an unhandled stale flag
    const stale = await makeTopic(area, user, { title: 'Stale', kp: 'Stale', freshnessStatus: 'stale', lastMeaningfulActivityAt: past });

    // 5) referenced by an active project
    const proj = await makeSpace(ws, user, 'proj', 'cloud_allowed');
    await db.update(spaces).set({ spaceKind: 'project', lifecycleStatus: 'active' }).where(sql`id = ${proj.id}`);
    const [srcTopic] = await db.insert(wikiTopics).values({
      workspaceId: ws.id, spaceId: proj.id, title: 'Src', contentJson: makeSynthesis(['Src']) as unknown,
      textContent: 's', status: 'accepted', source: 'ai_generated', publicationStatus: 'accepted',
      freshnessStatus: 'fresh', lifecycleStatus: 'active'
    }).returning();
    const refTarget = await makeTopic(area, user, { title: 'Referenced', kp: 'Referenced', lastMeaningfulActivityAt: past });
    await db.insert(knowledgeEdges).values({
      workspaceId: ws.id, spaceId: proj.id, sourceType: 'topic', sourceId: srcTopic.id,
      targetType: 'topic', targetId: refTarget.id, relationType: 'related', status: 'confirmed'
    });

    // 6) unprotected, 200 days inactive -> SHOULD be suggested for archive
    const inactive = await makeTopic(area, user, { title: 'Inactive', kp: 'Inactive', lastMeaningfulActivityAt: past });

    const { suggestions } = await evaluateLifecycle(ws.id, area.id);

    // Suggestions carry topicId (a UUID), not the title — map it back to the
    // title we assigned so the assertions check the right Topic.
    const titleById = new Map<string, string>([
      [pinned.id, 'Pinned'],
      [userEdited.id, 'UserEdited'],
      [keepActive.id, 'KeepActive'],
      [stale.id, 'Stale'],
      [refTarget.id, 'Referenced'],
      [inactive.id, 'Inactive']
    ]);
    const archivedFor = (topicTitle: string) =>
      suggestions.filter((s) => s.type === 'lifecycle_archive' && titleById.get(s.topicId) === topicTitle);

    expect(archivedFor('Pinned')).toHaveLength(0);
    expect(archivedFor('UserEdited')).toHaveLength(0);
    expect(archivedFor('KeepActive')).toHaveLength(0);
    expect(archivedFor('Stale')).toHaveLength(0);
    expect(archivedFor('Referenced')).toHaveLength(0);
    // The only one that should be flagged:
    expect(archivedFor('Inactive')).toHaveLength(1);

    // Idempotent: re-running does not stack duplicate suggestions.
    const { suggestions: second } = await evaluateLifecycle(ws.id, area.id);
    expect(second.filter((s) => s.type === 'lifecycle_archive' && titleById.get(s.topicId) === 'Inactive')).toHaveLength(1);
  });

  /* ---- Gate 3: archived 降权但可查 (archived down-weighted but queryable) ---- */
  it('down-weights archived topics in current intent, boosts them in historical, and lists them', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    const active = await makeTopic(sp, user, { title: 'ActiveTopic', kp: 'Shared Alpha' });
    const archived = await makeTopic(sp, user, { title: 'ArchivedTopic', kp: 'Shared Beta', lifecycleStatus: 'archived', archivedAt: new Date() });

    await indexTopicForSearch({ id: active.id, workspaceId: ws.id, spaceId: sp.id, title: active.title }, makeSynthesis(['Shared Alpha']), ai());
    await indexTopicForSearch({ id: archived.id, workspaceId: ws.id, spaceId: sp.id, title: archived.title }, makeSynthesis(['Shared Beta']), ai());

    const current = await hybridSearch({ userId: user.id, workspaceId: ws.id, spaceId: sp.id, query: 'shared', limit: 10, mode: 'keyword', intent: 'current' });
    const hist = await hybridSearch({ userId: user.id, workspaceId: ws.id, spaceId: sp.id, query: 'shared', limit: 10, mode: 'keyword', intent: 'historical' });

    const find = (list: typeof current, id: string) => list.find((r) => r.topicId === id)!;
    expect(find(current, active.id)).toBeDefined();
    expect(find(current, archived.id)).toBeDefined();
    // Current intent: archived is down-weighted below the active topic.
    expect(find(current, archived.id).score).toBeLessThan(find(current, active.id).score);
    // Historical intent: archived is boosted above the active topic.
    expect(find(hist, archived.id).score).toBeGreaterThan(find(hist, active.id).score);
    // Archived results carry lifecycle metadata for the historical warning.
    expect(find(current, archived.id).archivedAt).toBeDefined();
    expect(find(current, archived.id).lifecycleStatus).toBe('archived');

    // Archived topics are still explicitly listable (归档中心).
    const app = createApp();
    const cookie = await sessionCookie(user);
    const listRes = await app.request(`/api/llm-wiki/topics?spaceId=${sp.id}&lifecycle=archived`, { headers: { cookie } });
    const list = (await listRes.json()) as { topics: { id: string }[] };
    expect(list.topics.map((t) => t.id)).toContain(archived.id);
  });

  /* ---- Gate 4: 历史查询正确 (30-day activity windows are exact) ---- */
  it('counts only the last 30 days of activity in rolled-up stats', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const topic = await makeTopic(sp, user, { kp: 'Stats' });

    const recent = new Date(Date.now() - 5 * DAY);
    const old = new Date(Date.now() - 40 * DAY);

    // 2 recent views + 1 old view.
    await recordActivity({ workspaceId: ws.id, spaceId: sp.id, entityType: 'topic', entityId: topic.id, eventType: 'view', userId: user.id, occurredAt: recent });
    await recordActivity({ workspaceId: ws.id, spaceId: sp.id, entityType: 'topic', entityId: topic.id, eventType: 'view', userId: user.id, occurredAt: recent });
    await recordActivity({ workspaceId: ws.id, spaceId: sp.id, entityType: 'topic', entityId: topic.id, eventType: 'view', userId: user.id, occurredAt: old });
    // 1 recent RAG citation.
    await recordActivity({ workspaceId: ws.id, spaceId: sp.id, entityType: 'topic', entityId: topic.id, eventType: 'rag_citation', userId: user.id, occurredAt: recent });

    const stats = await getActivityStats('topic', topic.id);
    expect(stats).not.toBeNull();
    // Only the 2 recent views count toward the 30-day window.
    expect((stats as Record<string, number>).views30d).toBe(2);
    // The RAG citation is tracked separately.
    expect((stats as Record<string, number>).ragCitations30d).toBe(1);
    // lastViewedAt reflects the most recent (recent) view, not the old one.
    const lastViewed = new Date((stats as Record<string, string>).lastViewedAt);
    expect(Math.abs(lastViewed.getTime() - recent.getTime())).toBeLessThan(60 * 1000);
  });
});

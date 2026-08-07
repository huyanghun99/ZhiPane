import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAiProvider } from '@zhipane/ai';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb, sessionCookie, runPendingJob } from './test-utils';
import { createApp } from '../app';
import {
  wikiTopics,
  topicSources,
  documentChunks,
  topicOperations,
  llmSuggestions
} from '@zhipane/db';
import {
  refreshTopicSuggestions,
  applyRefreshDiff,
  mergeTopics,
  undoTopicOperation,
  indexTopicForSearch
} from '../services/wiki.service';
import { createAiProviderForContext } from '../services/ai.service';
import type { AiProvider } from '@zhipane/ai';
import type { TopicSynthesis } from '@zhipane/shared';

// Use the deterministic MockAiProvider for every AI call so the suite runs
// fully offline (no real LLM / embedding service). We keep the REAL ai.service
// exports (getSpacePolicy, vectorToSqlLiteral, ...) and only override the AI
// provider factory, so page/space routes that import other ai.service helpers
// keep working.
vi.mock('../services/ai.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createAiProviderForContext: vi.fn(async () => new MockAiProvider())
  };
});

const ai = () => new MockAiProvider();
const SYNC = 'topic-synthesis-v1' as const;

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

function makeSynthesis(keyPointTitles: string[]): TopicSynthesis {
  return {
    schemaVersion: SYNC,
    definition: keyPointTitles.join('、'),
    overview: 'overview text',
    keyPoints: keyPointTitles.map((t, i) => ({
      id: `kp-${i + 1}`,
      title: t,
      content: `${t} content`,
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

describe('Phase 4 — refresh, merge, split', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  /* ---- Gate 1: 用户正文不被覆盖 (user_edited body is never overwritten) ---- */
  it('does NOT overwrite a user_edited topic body on refresh (diff stored, body intact)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const p1 = await processPage(user, sp.id, 'Alpha page', '# Alpha\nAlpha is the first concept. It is important.');
    const p2 = await processPage(user, sp.id, 'Beta page', '# Beta\nBeta is the second concept. It is also important.');

    const seeded = makeSynthesis(['Alpha']);
    const [topic] = await db
      .insert(wikiTopics)
      .values({
        workspaceId: ws.id, spaceId: sp.id, title: 'User Topic',
        contentJson: seeded as unknown, textContent: 'user body',
        status: 'user_edited', source: 'user_created',
        publicationStatus: 'user_edited', freshnessStatus: 'stale', lifecycleStatus: 'active',
        createdById: user.id
      })
      .returning();
    await db.insert(topicSources).values([
      { topicId: topic.id, pageId: p1, addedBy: 'user', contributionType: 'key_point' },
      { topicId: topic.id, pageId: p2, addedBy: 'user', contributionType: 'key_point' }
    ]);

    const res = await refreshTopicSuggestions(topic.id);
    // Structured topic: refresh returns success (diff generated) without overwrite.
    expect(res.refreshed).toBe(true);

    const [after] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}`).limit(1);
    // Gate: the user's body (contentJson) is byte-for-byte unchanged.
    expect(after.contentJson).toEqual(seeded);
    expect(after.publicationStatus).toBe('user_edited');
    // Stale is preserved (we never silently "fixed" a user_edited topic).
    expect(after.freshnessStatus).toBe('stale');

    // A refresh-diff suggestion was stored for item-by-item review.
    const diff = await db.select().from(llmSuggestions).where(sql`topic_id = ${topic.id} AND type = 'topic_refresh_diff' AND status = 'pending'`);
    expect(diff).toHaveLength(1);
  });

  /* ---- Gate 2: Diff 可逐项应用 (refresh diff is applied item-by-item) ---- */
  it('generates an itemised diff and applies a single item without breaking validity', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const p1 = await processPage(user, sp.id, 'Alpha page', '# Alpha\nAlpha is the first concept. It is important.');
    const p2 = await processPage(user, sp.id, 'Beta page', '# Beta\nBeta is the second concept. It is also important.');

    // Topic currently only knows about Alpha; Beta is a NEW source -> diff add.
    const seeded = makeSynthesis(['Alpha']);
    const [topic] = await db
      .insert(wikiTopics)
      .values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Growing Topic',
        contentJson: seeded as unknown, textContent: 'body',
        status: 'accepted', source: 'ai_generated',
        publicationStatus: 'accepted', freshnessStatus: 'stale', lifecycleStatus: 'active'
      })
      .returning();
    await db.insert(topicSources).values([
      { topicId: topic.id, pageId: p1, addedBy: 'ai', contributionType: 'key_point' },
      { topicId: topic.id, pageId: p2, addedBy: 'ai', contributionType: 'key_point' }
    ]);

    // Refresh stores an itemised diff (without overwriting the body).
    const refreshRes = await refreshTopicSuggestions(topic.id);
    expect(refreshRes.refreshed).toBe(true);
    const diff = refreshRes.diff!;
    expect(diff).not.toBeNull();
    // Exactly one new key point (Beta) is proposed.
    const addItems = diff.items.filter((i) => i.kind === 'add_key_point');
    expect(addItems.length).toBe(1);
    expect(addItems[0].kind === 'add_key_point' && addItems[0].keyPoint.title).toBe('Beta');

    // Apply ONLY the first (add) item.
    const applyRes = await applyRefreshDiff(topic.id, [0], user.id);
    expect(applyRes.applied).toBe(1);

    const [after] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}`).limit(1);
    const afterSynth = after.contentJson as TopicSynthesis;
    expect(afterSynth.keyPoints.map((k) => k.title).sort()).toEqual(['Alpha', 'Beta']);
    // Fresh again after applying the diff.
    expect(after.freshnessStatus).toBe('fresh');
    // The diff suggestion is resolved.
    const pending = await db.select().from(llmSuggestions).where(sql`topic_id = ${topic.id} AND type = 'topic_refresh_diff' AND status = 'pending'`);
    expect(pending).toHaveLength(0);
  });

  /* ---- Gate 3: 合并后可追溯和恢复 (merge is traceable and reversible) ---- */
  it('merges a topic into another, records an operation, and fully undoes it', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    const survivorSynth = makeSynthesis(['Survivor']);
    const [survivor] = await db
      .insert(wikiTopics)
      .values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Survivor',
        contentJson: survivorSynth as unknown, textContent: 's', status: 'accepted',
        source: 'ai_generated', publicationStatus: 'accepted', freshnessStatus: 'fresh', lifecycleStatus: 'active', createdById: user.id
      })
      .returning();
    const mergedSynth = makeSynthesis(['Merged']);
    const [merged] = await db
      .insert(wikiTopics)
      .values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Merged',
        contentJson: mergedSynth as unknown, textContent: 'm', status: 'accepted',
        source: 'ai_generated', publicationStatus: 'accepted', freshnessStatus: 'fresh', lifecycleStatus: 'active', createdById: user.id
      })
      .returning();

    // Index both so they have RAG chunks (topic_id set) that the merge re-points.
    await indexTopicForSearch({ id: survivor.id, workspaceId: ws.id, spaceId: sp.id, title: survivor.title }, survivorSynth, ai());
    await indexTopicForSearch({ id: merged.id, workspaceId: ws.id, spaceId: sp.id, title: merged.title }, mergedSynth, ai());

    const { operationId } = await mergeTopics(survivor.id, merged.id, user.id);

    // The merged topic is now a redirect stub pointing at the survivor.
    const [m] = await db.select().from(wikiTopics).where(sql`id = ${merged.id}`).limit(1);
    expect(m.mergedIntoTopicId).toBe(survivor.id);
    expect(m.lifecycleStatus).toBe('archived');
    expect(m.status).toBe('archived');

    // Its RAG chunks were re-pointed to the survivor (so search keeps working).
    const mergedChunks = await db.select().from(documentChunks).where(sql`topic_id = ${merged.id}::uuid`);
    expect(mergedChunks).toHaveLength(0);
    const survivorChunks = await db.select().from(documentChunks).where(sql`topic_id = ${survivor.id}::uuid`);
    expect(survivorChunks.length).toBeGreaterThan(0);

    // The operation is recorded for traceability / audit.
    const [op] = await db.select().from(topicOperations).where(sql`id = ${operationId}`).limit(1);
    expect(op).toBeDefined();
    expect(op.operationType).toBe('merge');
    expect(op.topicId).toBe(merged.id);
    expect(op.targetTopicId).toBe(survivor.id);
    expect(op.undoneAt).toBeNull();

    // Redirect is surfaced by the GET endpoint.
    const app = createApp();
    const cookie = await sessionCookie(user);
    const getRes = await app.request(`/api/llm-wiki/topics/${merged.id}`, { headers: { cookie } });
    const getBody = (await getRes.json()) as { redirectedTo?: string };
    expect(getBody.redirectedTo).toBe(survivor.id);

    // Undo the merge -> the merged topic is fully restored.
    await undoTopicOperation(operationId, user.id);
    const [restored] = await db.select().from(wikiTopics).where(sql`id = ${merged.id}`).limit(1);
    expect(restored.mergedIntoTopicId).toBeNull();
    expect(restored.lifecycleStatus).toBe('active');
    expect(restored.status).toBe('accepted');
    // Its RAG chunks are re-pointed back to it.
    const restoredChunks = await db.select().from(documentChunks).where(sql`topic_id = ${merged.id}::uuid`);
    expect(restoredChunks.length).toBeGreaterThan(0);
    // The operation is marked undone.
    const [opAfter] = await db.select().from(topicOperations).where(sql`id = ${operationId}`).limit(1);
    expect(opAfter.undoneAt).not.toBeNull();
  });

  /* ---- Gate 4: 合并在事务中提交，reindex 失败不回滚数据 (merge is atomic) ---- */
  it('commits the merge even when re-indexing fails (sources moved + operation recorded)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    const survivorSynth = makeSynthesis(['Survivor']);
    const [survivor] = await db
      .insert(wikiTopics)
      .values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Survivor',
        contentJson: survivorSynth as unknown, textContent: 's', status: 'accepted',
        source: 'ai_generated', publicationStatus: 'accepted', freshnessStatus: 'fresh', lifecycleStatus: 'active', createdById: user.id
      })
      .returning();
    const mergedSynth = makeSynthesis(['Merged']);
    const [merged] = await db
      .insert(wikiTopics)
      .values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Merged',
        contentJson: mergedSynth as unknown, textContent: 'm', status: 'accepted',
        source: 'ai_generated', publicationStatus: 'accepted', freshnessStatus: 'fresh', lifecycleStatus: 'active', createdById: user.id
      })
      .returning();

    // Give the merged topic a source + a RAG chunk that the merge must move.
    // pageId must be a real (existing) page UUID to satisfy the FK.
    const srcPage = await processPage(user, sp.id, 'Src page', '# Src\nSource content for the merge.');
    await db.insert(topicSources).values({ topicId: merged.id, pageId: srcPage, addedBy: 'ai', contributionType: 'key_point' });
    await db.insert(documentChunks).values({
      workspaceId: ws.id, spaceId: sp.id, pageId: null, topicId: merged.id,
      chunkIndex: 0, title: merged.title, content: 'old chunk', ftsTokens: 'old',
      embedding: new Array(1536).fill(0), embeddingModel: 'mock-embedding', embeddingDimension: 1536
    });

    // Force the merge's re-index (createAiProviderForContext) to throw on embed.
    const failingProvider = {
      generateText: async () => 'x',
      streamText: async function* () {},
      embed: async () => { throw new Error('embed boom'); },
      embedBatch: async () => { throw new Error('embed boom'); }
    } as unknown as AiProvider;
    vi.mocked(createAiProviderForContext).mockImplementationOnce(async () => failingProvider);

    const { operationId } = await mergeTopics(survivor.id, merged.id, user.id);

    // Merge still committed despite re-index failure (Gate: 合并可完整回滚/提交).
    const [m] = await db.select().from(wikiTopics).where(sql`id = ${merged.id}`).limit(1);
    expect(m.mergedIntoTopicId).toBe(survivor.id);
    expect(m.lifecycleStatus).toBe('archived');

    // Provenance moved to the survivor.
    const survivorSources = await db.select().from(topicSources).where(sql`topic_id = ${survivor.id}`);
    expect(survivorSources).toHaveLength(1);
    const mergedSources = await db.select().from(topicSources).where(sql`topic_id = ${merged.id}`);
    expect(mergedSources).toHaveLength(0);

    // RAG chunk re-pointed to the survivor.
    const survivorChunks = await db.select().from(documentChunks).where(sql`topic_id = ${survivor.id}::uuid`);
    expect(survivorChunks).toHaveLength(1);

    // Audit record persisted.
    const [op] = await db.select().from(topicOperations).where(sql`id = ${operationId}`).limit(1);
    expect(op.operationType).toBe('merge');
  });

  /* ---- Gate 5: 索引更新失败不丢旧数据 (index failure keeps old chunks) ---- */
  it('keeps the existing index when embedding fails (old chunks retained)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const [topic] = await db
      .insert(wikiTopics)
      .values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Kept',
        contentJson: makeSynthesis(['A']) as unknown, textContent: 't', status: 'accepted',
        source: 'ai_generated', publicationStatus: 'accepted', freshnessStatus: 'fresh', lifecycleStatus: 'active', createdById: user.id
      })
      .returning();

    // Pre-existing RAG chunk (the "old" index).
    await db.insert(documentChunks).values({
      workspaceId: ws.id, spaceId: sp.id, pageId: null, topicId: topic.id,
      chunkIndex: 0, title: 'Kept', content: 'old index', ftsTokens: 'old',
      embedding: new Array(1536).fill(0), embeddingModel: 'mock-embedding', embeddingDimension: 1536
    });
    const before = await db.select().from(documentChunks).where(sql`topic_id = ${topic.id}::uuid`);
    expect(before).toHaveLength(1);

    // Embed throws before any DELETE runs, so the old chunk must survive.
    const failingProvider = {
      generateText: async () => 'x',
      streamText: async function* () {},
      embed: async () => { throw new Error('embed boom'); },
      embedBatch: async () => { throw new Error('embed boom'); }
    } as unknown as AiProvider;

    await expect(
      indexTopicForSearch({ id: topic.id, workspaceId: ws.id, spaceId: sp.id, title: 'Kept' }, makeSynthesis(['A']), failingProvider)
    ).rejects.toThrow('embed boom');

    const after = await db.select().from(documentChunks).where(sql`topic_id = ${topic.id}::uuid`);
    expect(after).toHaveLength(1);
    expect(after[0].content).toBe('old index');
  });
});

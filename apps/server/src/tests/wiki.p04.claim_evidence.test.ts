import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAiProvider, type AiProvider } from '@zhipane/ai';
import { sql, eq, and } from 'drizzle-orm';
import { createApp } from '../app';
import { db, makeUser, makeWorkspace, makeSpace, cleanDb, sessionCookie, runPendingJob } from './test-utils';
import { topicClaims, knowledgeClaims, claimEvidence, pageKnowledgeMaps, topicCandidates, documentChunks, wikiTopics } from '@zhipane/db';
import {
  generateTopicSynthesisFromClaims,
  type ClaimBundle,
  type SupportChunk
} from '../services/wiki.service';

// ---------- unit tests (no DB) ---------------------------------------------

const mockAi = () => new MockAiProvider();

const sampleChunks: SupportChunk[] = [
  { chunkId: 'chunk-a1', pageId: 'page-a', content: '# 机器学习基础\n机器学习是研究如何让计算机系统从数据中学习的学科。', contentVersion: 1 },
  { chunkId: 'chunk-b2', pageId: 'page-b', content: '# 深度学习\n深度学习是机器学习的一个分支，使用多层神经网络。', contentVersion: 1 }
];

const sampleBundles: ClaimBundle[] = [
  { claimId: 'claim-01', text: '机器学习是研究如何让计算机系统从数据中学习的学科', sectionAnchor: 'section-01', evidence: [sampleChunks[0]] },
  { claimId: 'claim-02', text: '深度学习是机器学习的一个分支，使用多层神经网络', sectionAnchor: 'section-02', evidence: [sampleChunks[1]] }
];

describe('P0-4: Claim-Evidence synthesis (unit)', () => {
  it('returns a failed result when no bundles are provided', async () => {
    const result = await generateTopicSynthesisFromClaims([], mockAi());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('Claim-Evidence');
      expect(result.diagnostics.evidenceCount).toBe(0);
      expect(result.diagnostics.usedFallback).toBe(false);
    }
  });

  it('produces a ready synthesis with both claimId and chunkId in citations', async () => {
    const result = await generateTopicSynthesisFromClaims(sampleBundles, mockAi());
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      // Every keyPoint must have at least one citation with both ids.
      for (const kp of result.synthesis.keyPoints) {
        expect(kp.citations.length).toBeGreaterThan(0);
        for (const c of kp.citations) {
          expect(c.chunkId).toBeTruthy();
          expect(c.claimId).toBeTruthy();
          // chunkId must come from the supplied bundles
          expect(sampleChunks.some((sc) => sc.chunkId === c.chunkId)).toBe(true);
          // claimId must come from the supplied bundles
          expect(sampleBundles.some((b) => b.claimId === c.claimId)).toBe(true);
        }
      }
      // Diagnostics: should reflect the combined evidence chunk count
      expect(result.diagnostics.evidenceCount).toBe(sampleChunks.length);
      expect(result.diagnostics.usedFallback).toBe(false);
    }
  });

  it('reports a failed result when the LLM returns non-JSON garbage', async () => {
    const garbageAi = {
      async generateText() { return 'not json'; },
      async *streamText() {},
      async embed() { return []; },
      async embedBatch(texts: string[]) { return texts.map(() => []); }
    } as unknown as AiProvider;
    const result = await generateTopicSynthesisFromClaims(sampleBundles, garbageAi);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      // Either extractJson threw, or sanitizeSynthesis returned null — both
      // surface as a failed result with the supplied evidence preserved.
      expect(result.evidencePreview.length).toBeGreaterThan(0);
      expect(result.diagnostics.usedFallback).toBe(false);
    }
  });

  it('deduplicates evidence chunks across bundles that share the same chunk', async () => {
    const overlapping: ClaimBundle[] = [
      { claimId: 'claim-x', text: 'Claim X', sectionAnchor: 's1', evidence: [sampleChunks[0]] },
      { claimId: 'claim-y', text: 'Claim Y', sectionAnchor: 's2', evidence: [sampleChunks[0], sampleChunks[1]] }
    ];
    const result = await generateTopicSynthesisFromClaims(overlapping, mockAi());
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      // Two distinct chunks even though 3 evidence references were supplied
      expect(result.diagnostics.evidenceCount).toBe(2);
    }
  });
});

// ---------- integration tests (DB) -----------------------------------------

// Inserts a page + chunks + page_knowledge_map + knowledge_claims + claim_evidence
// + a topic_candidate, so we can exercise the P0-4 promoteCandidate path
// without depending on the full page-processing pipeline's claim generation.
async function seedPageWithClaimsAndCandidate(
  user: { id: string },
  spaceId: string,
  workspaceId: string
): Promise<{ pageId: string; candidateId: string; claimIds: string[] }> {
  const app = createApp();
  const cookie = await sessionCookie(user);
  // 1. Create a page (this also queues an indexing job).
  const res = await app.request('/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      spaceId,
      title: 'P0-4 测试页面',
      textContent: '# 第一节\n这是第一节的内容，用于生成第一个 Claim。\n\n# 第二节\n这是第二节的内容，用于生成第二个 Claim。'
    })
  });
  const pageId = (await res.json()).page.id as string;
  // Run the indexing job so document_chunks exist.
  await db.execute(sql`UPDATE jobs SET run_after = now() WHERE entity_id = ${pageId}::uuid AND status = 'pending'`);
  await runPendingJob();

  // Clean up auto-generated topic_candidates and knowledge_claims so only our
  // manual inserts remain (generateWikiArtifacts creates candidates from the
  // page title via topic-extraction-v1 mock, which would interfere with the
  // test's assertions about specific claim IDs and createdTopics count).
  await db.delete(topicCandidates).where(and(eq(topicCandidates.pageId, pageId), eq(topicCandidates.status, 'candidate')));
  await db.delete(knowledgeClaims).where(eq(knowledgeClaims.pageId, pageId));

  // 2. Fetch the chunks that were created for this page.
  const chunkRows = await db
    .select({ id: documentChunks.id, content: documentChunks.content })
    .from(documentChunks)
    .where(eq(documentChunks.pageId, pageId));
  if (chunkRows.length === 0) throw new Error('test setup failed: no document_chunks created');
  const chunkId = chunkRows[0].id;

  // 3. Insert or update the page_knowledge_map. The page processing pipeline
  // already created one via generatePageKnowledgeArtifacts, so use upsert.
  const mapJson = { schemaVersion: 'page-knowledge-map-v1', documentType: 'multi_topic_notes', primaryTopic: 'P0-4 测试页面', sectionTree: [], facets: [{ id: 'facet-1', label: '第一节', sectionAnchor: 'section-01', chunkIds: [chunkId], confidence: 0.8 }], processedCharacterCount: 80, inputCharacterCount: 80, coverageRatio: 1 };
  const [pkm] = await db
    .insert(pageKnowledgeMaps)
    .values({
      workspaceId,
      spaceId,
      pageId,
      contentVersion: 1,
      status: 'ready',
      mapJson,
      summary: 'P0-4 测试页面',
      sourceChunkCount: chunkRows.length
    })
    .onConflictDoUpdate({
      target: [pageKnowledgeMaps.pageId, pageKnowledgeMaps.contentVersion],
      set: { mapJson, summary: 'P0-4 测试页面', sourceChunkCount: chunkRows.length, updatedAt: sql`now()` }
    })
    .returning();

  // 4. Insert two knowledge_claims + their claim_evidence (both citing the same chunk).
  const claimTexts = [
    { text: '第一节的核心观点是测试 Claim 生成与引用绑定。', anchor: 'section-01' },
    { text: '第二节的核心观点是 Claim-Evidence 模型支持多 Claim 综合主题。', anchor: 'section-02' }
  ];
  const claimIds: string[] = [];
  for (const c of claimTexts) {
    const [claim] = await db
      .insert(knowledgeClaims)
      .values({
        workspaceId,
        spaceId,
        pageId,
        knowledgeMapId: pkm.id,
        sectionAnchor: c.anchor,
        text: c.text,
        normalizedText: c.text.toLowerCase().replace(/\s+/g, ''),
        kind: 'claim',
        confidence: 80,
        status: 'generated',
        contentVersion: 1
      })
      .returning();
    claimIds.push(claim.id);
    await db
      .insert(claimEvidence)
      .values({
        claimId: claim.id,
        chunkId,
        excerpt: chunkRows[0].content.slice(0, 200),
        relevanceScore: 100
      })
      .onConflictDoNothing();
  }

  // 5. Insert a topic_candidate for this page (simulating what generateWikiArtifacts does).
  const [cand] = await db
    .insert(topicCandidates)
    .values({
      workspaceId,
      spaceId,
      pageId,
      chunkId,
      title: 'P0-4 测试主题',
      summary: '由 Claim-Evidence 模型生成的候选主题',
      profile: { summary: 'P0-4 测试主题' },
      status: 'candidate'
    })
    .returning();

  return { pageId, candidateId: cand.id, claimIds };
}

describe('P0-4: Claim-Evidence integration (promoteCandidate writes topic_claims)', () => {
  beforeEach(async () => {
    await cleanDb();
    vi.spyOn(await import('../services/ai.service'), 'createAiProviderForContext')
      .mockImplementation(() => Promise.resolve(new MockAiProvider()) as any);
  });

  it('creates topic_claims rows binding the page Claims to the promoted Topic (create_emerging)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const { candidateId, claimIds } = await seedPageWithClaimsAndCandidate(user, sp.id, ws.id);

    expect(claimIds.length).toBe(2);

    // Promote the candidate -> should create a Topic + topic_claims rows.
    const app = createApp();
    const cookie = await sessionCookie(user);
    const res = await app.request(`/api/llm-wiki/candidates/${candidateId}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const topicId = body.topic.id as string;
    expect(topicId).toBeTruthy();

    // P0-4 assertion: topic_claims rows must exist, binding the page's Claims
    // to the promoted Topic with routing_action = 'create_emerging'.
    const tcRows = await db
      .select({ claimId: topicClaims.claimId, routingAction: topicClaims.routingAction })
      .from(topicClaims)
      .where(eq(topicClaims.topicId, topicId));
    expect(tcRows.length).toBeGreaterThan(0);
    for (const r of tcRows) {
      expect(r.routingAction).toBe('create_emerging');
      expect(claimIds).toContain(r.claimId);
    }
  });

  it('consolidateCandidates writes topic_claims with update_existing for an existing Topic', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    // First page produces a candidate.
    const { claimIds: claimIds1 } = await seedPageWithClaimsAndCandidate(user, sp.id, ws.id);

    // Pre-create an existing accepted Topic with the same normalized title so
    // consolidateCandidates routes the candidate into it (update_existing path).
    await db
      .insert(wikiTopics)
      .values({
        workspaceId: ws.id,
        spaceId: sp.id,
        title: 'P0-4 测试主题',
        contentJson: { schemaVersion: 'topic-synthesis-v1', definition: '已有主题', overview: '已有主题的概述', keyPoints: [] },
        textContent: '已有主题',
        status: 'accepted',
        source: 'ai_generated',
        normalizedTitle: 'p04测试主题',
        aliases: ['p04测试主题'],
        publicationStatus: 'accepted',
        freshnessStatus: 'fresh',
        lifecycleStatus: 'active'
      })
      .returning();

    // Update the candidate's title to match the existing Topic's normalized title
    // so consolidateCandidates finds the existing Topic.
    await db.execute(sql`UPDATE topic_candidates SET title = 'P0-4 测试主题' WHERE title = 'P0-4 测试主题'`);

    // Run consolidation.
    const { consolidateCandidates } = await import('../services/wiki.service');
    const result = await consolidateCandidates(sp.id, new MockAiProvider());
    // The candidate should be routed to the existing Topic (not create a new one).
    expect(result.createdTopics).toBe(0);

    // P0-4 assertion: topic_claims rows must exist with routing_action = 'update_existing'.
    const tcRows = await db
      .select({ claimId: topicClaims.claimId, routingAction: topicClaims.routingAction })
      .from(topicClaims);
    expect(tcRows.length).toBeGreaterThan(0);
    for (const r of tcRows) {
      expect(r.routingAction).toBe('update_existing');
      expect(claimIds1).toContain(r.claimId);
    }
  });
});

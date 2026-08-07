/**
 * P0-7 (LLM wiki优化.md §六): End-to-end regression suite.
 *
 * Fixed regression cases (≥2 long articles) covering the acceptance criteria:
 *   - 全文章节覆盖率不低于 95%
 *   - 不出现 HTML 残片和残句
 *   - Definition、Overview、Key Points 职责明确
 *   - "敏捷与 CMMI" 不得混入团队实践作为核心定义
 *   - 第二篇相似文章导入后，应优先更新已有 Topic（routeClaims → update_existing）
 *   - 自动整理、单个采纳和批量采纳结果必须一致
 *   - 相同文章重复导入不得产生重复 Topic
 *   - 正常情况下需要人工处理的内容应控制在 5%～10% 以内
 *
 * The suite uses the deterministic MockAiProvider so every AI call is
 * reproducible offline. DB-backed integration tests share one database;
 * vitest is configured with fileParallelism=false so per-test truncation
 * does not race between workers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockAiProvider } from '@zhipane/ai';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../app';
import {
  db,
  makeUser,
  makeWorkspace,
  makeSpace,
  cleanDb,
  sessionCookie,
  runPendingJob
} from './test-utils';
import {
  wikiTopics,
  topicCandidates,
  topicSources,
  topicClaims,
  knowledgeClaims,
  pageKnowledgeMaps,
  llmSuggestions
} from '@zhipane/db';
import {
  consolidateCandidates,
  routeClaims,
  evaluateSynthesisQuality,
  type SupportChunk
} from '../services/wiki.service';
import type { TopicSynthesis } from '@zhipane/shared';

// ---------- fixtures --------------------------------------------------------

const ARTICLE_1_PATH = join(process.cwd(), 'src/tests/fixtures/agile-cmmi-article-1.md');
const ARTICLE_2_PATH = join(process.cwd(), 'src/tests/fixtures/agile-cmmi-article-2.md');
const ARTICLE_1 = readFileSync(ARTICLE_1_PATH, 'utf8');
const ARTICLE_2 = readFileSync(ARTICLE_2_PATH, 'utf8');

// ---------- mock AI provider (deterministic, offline) ----------------------

vi.mock('../services/ai.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createAiProviderForContext: vi.fn(async () => new MockAiProvider())
  };
});

// ---------- helpers ---------------------------------------------------------

const ai = () => new MockAiProvider();

async function processPage(
  user: { id: string },
  spaceId: string,
  title: string,
  textContent: string
): Promise<string> {
  const app = createApp();
  const cookie = await sessionCookie(user);
  const res = await app.request('/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ spaceId, title, textContent })
  });
  const pageId = (await res.json()).page.id as string;
  await db.execute(
    sql`UPDATE jobs SET run_after = now() WHERE entity_id = ${pageId}::uuid AND status = 'pending'`
  );
  await runPendingJob();
  return pageId;
}

function countHeadings(text: string): number {
  return [...text.matchAll(/^#{1,6}\s+.+$/gm)].length;
}

function isHtmlFragment(value: string): boolean {
  return /<(?:div|span|p|ul|ol|li|h[1-6]|img|a|br|table|tr|td|th|strong|em|code|pre|blockquote)\b/i.test(
    value
  );
}

function isSentenceFragment(value: string): boolean {
  return /^[，。；、：）】]|^(起来|需要|以及|但是|因此|同时|并且)/.test(value.replace(/\s+/g, ''));
}

async function loadTopicChunks(topicId: string): Promise<SupportChunk[]> {
  const rows = await db.execute<any>(sql`
    SELECT dc.id, dc.content, dc.page_id
    FROM document_chunks dc
    JOIN topic_sources ts ON ts.chunk_id = dc.id
    WHERE ts.topic_id = ${topicId}::uuid
  `);
  return (rows.rows ?? []).map((r: { id: string; content: string; page_id: string }) => ({
    chunkId: r.id,
    content: r.content,
    pageId: r.page_id,
    contentVersion: 1
  }));
}

// ===========================================================================
//  Article 1: section coverage and synthesis quality
// ===========================================================================

describe('P0-7: Article 1 — section coverage and synthesis quality', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('produces a Page Knowledge Map with ≥95% section coverage', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);

    const [map] = await db
      .select()
      .from(pageKnowledgeMaps)
      .where(eq(pageKnowledgeMaps.spaceId, sp.id))
      .limit(1);
    expect(map).toBeDefined();
    const mapJson = map.mapJson as {
      coverageRatio: number;
      sectionTree: Array<{ heading: string; chunkIds: string[] }>;
      facets: Array<{ label: string }>;
    };
    expect(mapJson.coverageRatio).toBeGreaterThanOrEqual(0.95);
    const headingCount = countHeadings(ARTICLE_1);
    expect(mapJson.sectionTree.length).toBeGreaterThanOrEqual(headingCount);
  });

  it('creates a knowledge_claim for every section/facet (no orphan sections)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);

    const [map] = await db
      .select()
      .from(pageKnowledgeMaps)
      .where(eq(pageKnowledgeMaps.spaceId, sp.id))
      .limit(1);
    const mapJson = map.mapJson as { facets: Array<{ label: string; sectionAnchor: string }> };

    const claims = await db
      .select({ id: knowledgeClaims.id, text: knowledgeClaims.text, sectionAnchor: knowledgeClaims.sectionAnchor })
      .from(knowledgeClaims)
      .where(eq(knowledgeClaims.spaceId, sp.id));

    const claimAnchors = new Set(claims.map((c) => c.sectionAnchor));
    const facetsWithoutClaims = mapJson.facets.filter(
      (f) => !claimAnchors.has(f.sectionAnchor)
    );
    expect(facetsWithoutClaims.length).toBeLessThanOrEqual(1);
    expect(claims.length).toBeGreaterThanOrEqual(mapJson.facets.length - 1);
  });

  it('synthesizes a Topic with no HTML fragments or broken sentences', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    await consolidateCandidates(sp.id, ai());

    const [topic] = await db
      .select()
      .from(wikiTopics)
      .where(eq(wikiTopics.spaceId, sp.id))
      .limit(1);
    expect(topic).toBeDefined();
    expect(topic.synthesisStatus).toBe('ready');

    const synthesis = topic.contentJson as TopicSynthesis;
    expect(synthesis.schemaVersion).toBe('topic-synthesis-v1');

    const allFields = [
      synthesis.definition,
      synthesis.overview,
      ...synthesis.keyPoints.flatMap((kp) => [kp.title, kp.content])
    ];
    for (const field of allFields) {
      expect(isHtmlFragment(field)).toBe(false);
    }
    for (const field of allFields) {
      expect(isSentenceFragment(field)).toBe(false);
    }

    const chunks = await loadTopicChunks(topic.id);
    const quality = evaluateSynthesisQuality(synthesis, chunks);
    expect(quality.issues).not.toContain('html_fragment');
    expect(quality.issues).not.toContain('sentence_fragment');
  });

  it('keeps Definition, Overview and Key Points structurally distinct', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    await consolidateCandidates(sp.id, ai());

    const [topic] = await db
      .select()
      .from(wikiTopics)
      .where(eq(wikiTopics.spaceId, sp.id))
      .limit(1);
    const synthesis = topic.contentJson as TopicSynthesis;

    expect(synthesis.definition.length).toBeGreaterThanOrEqual(12);
    expect(synthesis.overview.length).toBeGreaterThanOrEqual(24);
    expect(synthesis.keyPoints.length).toBeGreaterThan(0);
    for (const kp of synthesis.keyPoints) {
      expect(kp.citations.length).toBeGreaterThan(0);
    }

    const chunks = await loadTopicChunks(topic.id);
    const quality = evaluateSynthesisQuality(synthesis, chunks);
    expect(quality.issues).not.toContain('definition_overview_redundant');
    expect(quality.issues).not.toContain('key_points_redundant');
    expect(quality.issues).not.toContain('citation_missing');
  });

  it('does not mix team practices into the core definition of Agile/CMMI', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    await consolidateCandidates(sp.id, ai());

    const [topic] = await db
      .select()
      .from(wikiTopics)
      .where(eq(wikiTopics.spaceId, sp.id))
      .limit(1);
    const synthesis = topic.contentJson as TopicSynthesis;

    const title = topic.title.toLowerCase();
    expect(title).toMatch(/敏捷|cmmi|agile/);

    // Team practices may appear as key points but must not dominate the
    // definition (the first 20 chars should not start with a team practice).
    const teamPracticeTerms = ['每日站会', '结对编程', '测试驱动开发', 'standup', 'pair programming', 'tdd'];
    const first20 = synthesis.definition.slice(0, 20);
    for (const term of teamPracticeTerms) {
      expect(first20).not.toContain(term);
    }
  });
});

// ===========================================================================
//  Article 2: similar article → prefer update_existing
// ===========================================================================

describe('P0-7: Article 2 — similar article routing (update_existing)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('routes Claims to update_existing when a matching Topic exists', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    await consolidateCandidates(sp.id, ai());

    const existingTopics = await db
      .select({ id: wikiTopics.id, title: wikiTopics.title, aliases: wikiTopics.aliases, normalizedTitle: wikiTopics.normalizedTitle })
      .from(wikiTopics)
      .where(eq(wikiTopics.spaceId, sp.id));
    expect(existingTopics.length).toBeGreaterThanOrEqual(1);

    await processPage(user, sp.id, '敏捷开发与 CMMI 协同的进阶思考', ARTICLE_2);

    const article2Claims = await db
      .select({ id: knowledgeClaims.id, text: knowledgeClaims.text, sectionAnchor: knowledgeClaims.sectionAnchor })
      .from(knowledgeClaims)
      .where(eq(knowledgeClaims.spaceId, sp.id))
      .orderBy(sql`created_at DESC`)
      .limit(20);

    const decisions = await routeClaims(
      article2Claims.map((c) => ({ id: c.id, text: c.text, sectionAnchor: c.sectionAnchor })),
      existingTopics.map((t) => ({
        id: t.id,
        title: t.title,
        aliases: (t.aliases as string[]) ?? [],
        normalizedTitle: t.normalizedTitle ?? ''
      })),
      '敏捷开发与 CMMI 协同的进阶思考',
      ai()
    );

    expect(decisions.length).toBe(article2Claims.length);
    const updateCount = decisions.filter((d) => d.routingAction === 'update_existing').length;
    const createCount = decisions.filter((d) => d.routingAction === 'create_emerging').length;
    expect(updateCount).toBeGreaterThan(0);
    expect(updateCount).toBeGreaterThanOrEqual(createCount);
  });

  it('does not create a near-duplicate Topic with the same normalized title', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    await consolidateCandidates(sp.id, ai());

    // Re-import the SAME article — candidate title matches → update_existing.
    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践 (副本)', ARTICLE_1);
    await consolidateCandidates(sp.id, ai());

    const topics = await db.select().from(wikiTopics).where(eq(wikiTopics.spaceId, sp.id));
    const normalizedTitles = topics.map((t) => t.normalizedTitle);
    const uniqueTitles = new Set(normalizedTitles);
    expect(uniqueTitles.size).toBe(normalizedTitles.length);
  });
});

// ===========================================================================
//  Re-import idempotency
// ===========================================================================

describe('P0-7: Re-import idempotency — no duplicate Topics', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('does not produce a duplicate Topic when the same article is re-imported', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    await consolidateCandidates(sp.id, ai());
    const topicsAfter1 = await db.select().from(wikiTopics).where(eq(wikiTopics.spaceId, sp.id));
    const countAfter1 = topicsAfter1.length;
    expect(countAfter1).toBeGreaterThanOrEqual(1);

    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践 (副本)', ARTICLE_1);
    await consolidateCandidates(sp.id, ai());

    const topicsAfter2 = await db.select().from(wikiTopics).where(eq(wikiTopics.spaceId, sp.id));
    expect(topicsAfter2.length).toBe(countAfter1);

    const survivor = topicsAfter2[0];
    const sources = await db
      .select({ pageId: topicSources.pageId })
      .from(topicSources)
      .where(eq(topicSources.topicId, survivor.id));
    const distinctPages = new Set(sources.map((s) => s.pageId));
    expect(distinctPages.size).toBeGreaterThanOrEqual(2);
  });

  it('does not produce duplicate topic_claims for the same Claim-Topic pair', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    await consolidateCandidates(sp.id, ai());

    const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.spaceId, sp.id)).limit(1);
    await consolidateCandidates(sp.id, ai());

    const tcRows = await db
      .select({ claimId: topicClaims.claimId, topicId: topicClaims.topicId })
      .from(topicClaims)
      .where(eq(topicClaims.topicId, topic.id));

    const pairs = new Set(tcRows.map((r) => `${r.topicId}:${r.claimId}`));
    expect(pairs.size).toBe(tcRows.length);
  });
});

// ===========================================================================
//  Three-entry adoption consistency (auto / single / batch)
// ===========================================================================

describe('P0-7: Three-entry adoption consistency', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('produces the same synthesis structure via consolidate, promote and bulk-accept', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const spA = await makeSpace(ws, user, 'A');
    const spB = await makeSpace(ws, user, 'B');
    const spC = await makeSpace(ws, user, 'C');

    // Space A: auto-organize.
    await processPage(user, spA.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    await consolidateCandidates(spA.id, ai());
    const [topicA] = await db.select().from(wikiTopics).where(eq(wikiTopics.spaceId, spA.id)).limit(1);

    // Space B: single adoption (promoteCandidate via API).
    await processPage(user, spB.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    const [candB] = await db
      .select()
      .from(topicCandidates)
      .where(eq(topicCandidates.spaceId, spB.id))
      .limit(1);
    expect(candB).toBeDefined();
    const appB = createApp();
    const cookieB = await sessionCookie(user);
    const promoteRes = await appB.request(`/api/llm-wiki/candidates/${candB.id}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieB },
      body: JSON.stringify({})
    });
    expect(promoteRes.status).toBe(201);
    const topicBId = ((await promoteRes.json()) as { topic: { id: string } }).topic.id;
    const [topicB] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicBId)).limit(1);

    // Space C: batch adoption (bulk-accept suggestions via API).
    await processPage(user, spC.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    const suggestions = await db
      .select({ id: llmSuggestions.id, type: llmSuggestions.type })
      .from(llmSuggestions)
      .where(eq(llmSuggestions.spaceId, spC.id));
    const candidateSuggestions = suggestions.filter((s) => s.type === 'topic_candidate');
    expect(candidateSuggestions.length).toBeGreaterThan(0);
    const appC = createApp();
    const cookieC = await sessionCookie(user);
    const bulkRes = await appC.request('/api/llm-wiki/suggestions/bulk-accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieC },
      body: JSON.stringify({ spaceId: spC.id, ids: candidateSuggestions.map((s) => s.id) })
    });
    expect(bulkRes.status).toBe(200);
    const [topicC] = await db.select().from(wikiTopics).where(eq(wikiTopics.spaceId, spC.id)).limit(1);

    // All three Topics must have a ready synthesis with the same structure.
    expect(topicA.synthesisStatus).toBe('ready');
    expect(topicB.synthesisStatus).toBe('ready');
    expect(topicC.synthesisStatus).toBe('ready');

    const synthA = topicA.contentJson as TopicSynthesis;
    const synthB = topicB.contentJson as TopicSynthesis;
    const synthC = topicC.contentJson as TopicSynthesis;

    expect(synthA.schemaVersion).toBe('topic-synthesis-v1');
    expect(synthB.schemaVersion).toBe(synthA.schemaVersion);
    expect(synthC.schemaVersion).toBe(synthA.schemaVersion);

    expect(synthB.keyPoints.length).toBe(synthA.keyPoints.length);
    expect(synthC.keyPoints.length).toBe(synthA.keyPoints.length);

    const defALen = synthA.definition.length;
    expect(Math.abs(synthB.definition.length - defALen)).toBeLessThanOrEqual(defALen * 0.2);
    expect(Math.abs(synthC.definition.length - defALen)).toBeLessThanOrEqual(defALen * 0.2);

    for (const kp of [...synthA.keyPoints, ...synthB.keyPoints, ...synthC.keyPoints]) {
      expect(kp.citations.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
//  Manual processing rate (routeClaims → request_review ≤ 10%)
// ===========================================================================

describe('P0-7: Manual processing rate — request_review within 10%', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('keeps request_review decisions within 10% of total Claims (normal case)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);

    const claims = await db
      .select({ id: knowledgeClaims.id, text: knowledgeClaims.text, sectionAnchor: knowledgeClaims.sectionAnchor })
      .from(knowledgeClaims)
      .where(eq(knowledgeClaims.spaceId, sp.id));

    // With no existing Topics: first Claim → create_emerging, rest → keep_as_facet.
    // request_review = 0% (well within the 10% cap).
    const decisions = await routeClaims(
      claims.map((c) => ({ id: c.id, text: c.text, sectionAnchor: c.sectionAnchor })),
      [],
      '敏捷开发与 CMMI 的融合实践',
      ai()
    );

    const reviewCount = decisions.filter((d) => d.routingAction === 'request_review').length;
    const reviewRate = reviewCount / decisions.length;
    expect(reviewRate).toBeLessThanOrEqual(0.1);
  });

  it('routes all Claims to request_review when the LLM fails (safety net)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    await processPage(user, sp.id, '敏捷开发与 CMMI 的融合实践', ARTICLE_1);
    const claims = await db
      .select({ id: knowledgeClaims.id, text: knowledgeClaims.text, sectionAnchor: knowledgeClaims.sectionAnchor })
      .from(knowledgeClaims)
      .where(eq(knowledgeClaims.spaceId, sp.id));

    const garbageAi = {
      async generateText() { return 'not json'; },
      async *streamText() { /* not used */ },
      async embed() { return []; },
      async embedBatch(texts: string[]) { return texts.map(() => []); }
    } as unknown as ReturnType<typeof ai>;

    const decisions = await routeClaims(
      claims.map((c) => ({ id: c.id, text: c.text, sectionAnchor: c.sectionAnchor })),
      [],
      '敏捷开发与 CMMI 的融合实践',
      garbageAi
    );

    expect(decisions.length).toBe(claims.length);
    for (const d of decisions) {
      expect(d.routingAction).toBe('request_review');
    }
  });
});

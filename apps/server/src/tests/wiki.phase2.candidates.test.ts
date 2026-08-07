import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as aiService from '../services/ai.service';
import { createApp } from '../app';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb, sessionCookie, runPendingJob } from './test-utils';
import { topicCandidates, wikiTopics, pageAiProfiles } from '@zhipane/db';

const aiSpy = vi.spyOn(aiService, 'createAiProviderForContext');

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

describe('Phase 2 — Candidate ↔ Topic decoupling', () => {
  beforeEach(async () => {
    await cleanDb();
    aiSpy.mockRestore(); // use the real provider (MockAiProvider) by default
  });

  /* ---- Gate 1 + 2: short page -> candidates (chunk-linked), NO formal Topic ---- */
  it('processes a short page into chunk-linked candidates without creating Topics', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await processPage(user, sp.id, '短笔记', '# 项目计划\n这是关于项目计划的简短笔记内容。');

    const topics = await db.select().from(wikiTopics).where(sql`space_id = ${sp.id}`);
    expect(topics).toHaveLength(0); // Gate 1: single short page creates no formal Topic

    const cands = await db.select().from(topicCandidates).where(sql`space_id = ${sp.id}`);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.chunkId).not.toBeNull(); // Gate 2: Candidate has a Chunk reference
    }
  });

  /* ---- Task: structured Page Profile populated ---- */
  it('populates a structured page_ai_profile (tags/keywords/entities)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const pageId = await processPage(user, sp.id, 'Profile note', '# 设计原则\n关于设计原则的一些笔记内容。');

    const [p] = await db.select().from(pageAiProfiles).where(sql`page_id = ${pageId}`);
    expect(p).toBeDefined();
    expect(Array.isArray(p.tags) && p.tags.length).toBeGreaterThan(0);
    expect(Array.isArray(p.entities)).toBe(true);
  });

  /* ---- Gate 3: AI failure must not manufacture a formal Topic ---- */
  it('AI failure does not create a formal Topic', async () => {
    aiSpy.mockRejectedValue(new Error('AI unavailable'));
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await processPage(user, sp.id, 'Note', '# 主题\n一些内容用于测试。');

    const topics = await db.select().from(wikiTopics).where(sql`space_id = ${sp.id}`);
    expect(topics).toHaveLength(0); // Gate 3: no formal Topic despite AI failure
  });

  /* ---- Promotion: candidate -> formal Topic with chunk-linked source ---- */
  it('promotes a candidate into a formal Topic (with chunk source)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await processPage(user, sp.id, 'Promote note', '# 可晋升主题\n内容。');

    const cands = await db.select().from(topicCandidates).where(sql`space_id = ${sp.id}`);
    expect(cands.length).toBeGreaterThan(0);
    const cand = cands[0];

    const app = createApp();
    const cookie = await sessionCookie(user);
    const prom = await app.request(`/api/llm-wiki/candidates/${cand.id}/promote`, { method: 'POST', headers: { cookie } });
    expect(prom.status).toBe(201);
    const { topic } = await prom.json() as { topic: { id: string; status: string } };
    expect(topic.status).toBe('accepted');

    const topics = await db.select().from(wikiTopics).where(sql`space_id = ${sp.id}`);
    expect(topics).toHaveLength(1);

    const sources = await db.execute<any>(sql`SELECT * FROM topic_sources WHERE topic_id = ${topic.id}`);
    expect(sources.rows.length).toBe(1);
    expect(sources.rows[0].chunk_id).toBe(cand.chunkId);

    const [updated] = await db.select().from(topicCandidates).where(sql`id = ${cand.id}`);
    expect(updated.status).toBe('promoted');
    expect(updated.promotedTopicId).toBe(topic.id);
  });

  /* ---- Candidate API: list + permission ---- */
  it('GET /candidates lists candidates and enforces view permission', async () => {
    const owner = await makeUser();
    const ws = await makeWorkspace(owner);
    const sp = await makeSpace(ws, owner);
    await processPage(owner, sp.id, 'Cand note', '# 候选主题\n这是一段用于测试候选列表接口的内容。');

    const app = createApp();
    const cookie = await sessionCookie(owner);
    const list = await app.request(`/api/llm-wiki/candidates?spaceId=${sp.id}`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const { candidates } = await list.json() as { candidates: unknown[] };
    expect(candidates.length).toBeGreaterThan(0);

    const stranger = await makeUser();
    await makeWorkspace(stranger);
    const forbidden = await app.request(`/api/llm-wiki/candidates?spaceId=${sp.id}`, { headers: { cookie: await sessionCookie(stranger) } });
    expect(forbidden.status).toBe(403);
  });
});

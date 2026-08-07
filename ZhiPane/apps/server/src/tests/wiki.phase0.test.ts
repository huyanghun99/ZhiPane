import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the AI service so we can force refresh success / failure deterministically
// without touching the network (MockAiProvider is used under NODE_ENV=test anyway).
vi.mock('../services/ai.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ai.service')>();
  return {
    ...actual,
    createAiProviderForContext: vi.fn()
  };
});

import { createApp } from '../app';
import { MockAiProvider } from '@zhipane/ai';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb, sessionCookie } from './test-utils';
import { wikiTopics, llmSuggestions, pages, topicSources, topicCandidates } from '@zhipane/db';
import { markTopicsStaleForPage, refreshTopicSuggestions, generateWikiArtifacts } from '../services/wiki.service';
import { createAiProviderForContext } from '../services/ai.service';

const aiMock = vi.mocked(createAiProviderForContext);

describe('Phase 0 — wiki correctness', () => {
  beforeEach(async () => {
    await cleanDb();
    aiMock.mockReset();
  });

  /* ---- Task 2: refresh failure must NOT clear stale / set accepted ---- */
  describe('refreshTopicSuggestions', () => {
    async function seedStaleTopic() {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      const [page] = await db.insert(pages).values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Source note',
        contentJson: { type: 'doc', content: [] }, textContent: 'some real content here', status: 'normal',
        createdById: user.id, updatedById: user.id
      }).returning();
      const [topic] = await db.insert(wikiTopics).values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Old Topic',
        contentJson: { type: 'doc', content: [] }, source: 'ai_generated', status: 'stale',
        updatePolicy: 'suggest_only'
      }).returning();
      await db.insert(topicSources).values({ topicId: topic.id, pageId: page.id });
      await db.insert(llmSuggestions).values({
        workspaceId: ws.id, spaceId: sp.id, pageId: page.id, topicId: topic.id,
        type: 'stale_topic', risk: 'low', status: 'pending',
        payload: { topicId: topic.id, topicTitle: 'Old Topic' }, evidence: {}
      });
      return { ws, sp, page, topic };
    }

    it('on AI success: sets accepted and clears the stale suggestion', async () => {
      const { topic } = await seedStaleTopic();
      aiMock.mockResolvedValue(new MockAiProvider());

      const res = await refreshTopicSuggestions(topic.id);
      expect(res.refreshed).toBe(true);

      const [t] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}`).limit(1);
      expect(t?.status).toBe('accepted');

      const sugg = await db.select().from(llmSuggestions)
        .where(sql`topic_id = ${topic.id} AND type = 'stale_topic'`);
      expect(sugg).toHaveLength(1);
      expect(sugg[0].status).toBe('ignored');
    });

    it('on AI failure: keeps stale, keeps the stale suggestion, reports failure', async () => {
      const { topic } = await seedStaleTopic();
      aiMock.mockRejectedValue(new Error('AI unavailable'));

      const res = await refreshTopicSuggestions(topic.id);
      expect(res.refreshed).toBe(false);
      expect(res.error).toBeTruthy();

      const [t] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}`).limit(1);
      // MUST remain stale — never silently "fixed".
      expect(t?.status).toBe('stale');

      const sugg = await db.select().from(llmSuggestions)
        .where(sql`topic_id = ${topic.id} AND type = 'stale_topic'`);
      expect(sugg).toHaveLength(1);
      // MUST remain pending — the user is still prompted to act.
      expect(sugg[0].status).toBe('pending');
    });
  });

  /* ---- Task 3: archived topics excluded by default, opt-in via includeArchived ---- */
  describe('GET /topics archived filtering', () => {
    it('excludes archived by default and includes them with includeArchived=true', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      await db.insert(wikiTopics).values([
        { workspaceId: ws.id, spaceId: sp.id, title: 'Live', contentJson: { type: 'doc', content: [] }, status: 'accepted' },
        { workspaceId: ws.id, spaceId: sp.id, title: 'Archived', contentJson: { type: 'doc', content: [] }, status: 'archived' }
      ]);

      const app = createApp();
      const cookie = await sessionCookie(user);

      const resDefault = await app.request(`/api/llm-wiki/topics?spaceId=${sp.id}`, { headers: { cookie } });
      expect(resDefault.status).toBe(200);
      const bodyDefault = await resDefault.json() as { topics: { id: string; title: string; status: string }[] };
      expect(bodyDefault.topics.map((t) => t.title)).toEqual(['Live']);

      const resAll = await app.request(`/api/llm-wiki/topics?spaceId=${sp.id}&includeArchived=true`, { headers: { cookie } });
      expect(resAll.status).toBe(200);
      const bodyAll = await resAll.json() as { topics: { id: string; title: string; status: string }[] };
      expect(bodyAll.topics.map((t) => t.title).sort()).toEqual(['Archived', 'Live']);
    });
  });

  /* ---- Task 4: editing title / content marks user_edited ---- */
  describe('PATCH /topics user_edited', () => {
    it('marks user_edited when title is changed', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      const [topic] = await db.insert(wikiTopics).values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Orig', contentJson: { type: 'doc', content: [] }, status: 'accepted'
      }).returning();

      const app = createApp();
      const cookie = await sessionCookie(user);
      const res = await app.request(`/api/llm-wiki/topics/${topic.id}`, {
        method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed' })
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { topic: { status: string } };
      expect(body.topic.status).toBe('user_edited');
    });

    it('marks user_edited when contentJson is changed', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      const [topic] = await db.insert(wikiTopics).values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Orig', contentJson: { type: 'doc', content: [] }, status: 'accepted'
      }).returning();

      const app = createApp();
      const cookie = await sessionCookie(user);
      const res = await app.request(`/api/llm-wiki/topics/${topic.id}`, {
        method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] } })
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { topic: { status: string } };
      expect(body.topic.status).toBe('user_edited');
    });
  });

  /* ---- Task 5: page processing yields candidate suggestions (medium risk) ---- */
  describe('generateWikiArtifacts', () => {
    it('creates topic_candidate suggestions with medium risk and NO formal Topic', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      const [page] = await db.insert(pages).values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Note',
        contentJson: { type: 'doc', content: [] },
        textContent: '# 项目计划\n这是关于项目计划的笔记内容。',
        status: 'normal', createdById: user.id, updatedById: user.id
      }).returning();

      await generateWikiArtifacts(
        { id: page.id, workspace_id: ws.id, space_id: sp.id, title: page.title, text_content: page.textContent, updated_by_id: user.id },
        new MockAiProvider()
      );

      // Phase 2 (D2): candidates, not formal Topics.
      const sugg = await db.select().from(llmSuggestions)
        .where(sql`space_id = ${sp.id} AND type = 'topic_candidate'`);
      expect(sugg.length).toBeGreaterThan(0);
      for (const s of sugg) expect(s.risk).toBe('medium');

      const cands = await db.select().from(topicCandidates).where(sql`space_id = ${sp.id}`);
      expect(cands.length).toBeGreaterThan(0);

      // A single short page must NOT create any formal wiki_topics.
      const topics = await db.select().from(wikiTopics).where(sql`space_id = ${sp.id}`);
      expect(topics).toHaveLength(0);
    });
  });

  /* ---- Task 1 (regression): archived topics are never flagged stale ---- */
  describe('markTopicsStaleForPage', () => {
    it('does NOT flag an archived topic as stale', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      const [page] = await db.insert(pages).values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Source note',
        contentJson: { type: 'doc', content: [] }, textContent: 'x', status: 'normal',
        createdById: user.id, updatedById: user.id
      }).returning();
      const [topic] = await db.insert(wikiTopics).values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Archived Topic',
        contentJson: { type: 'doc', content: [] }, source: 'ai_generated', status: 'archived',
        updatePolicy: 'suggest_only'
      }).returning();
      await db.insert(topicSources).values({ topicId: topic.id, pageId: page.id });

      await markTopicsStaleForPage(page.id);

      const [t] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}`).limit(1);
      expect(t?.status).toBe('archived');
    });
  });
});

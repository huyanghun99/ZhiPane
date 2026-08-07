import { beforeEach, describe, expect, it } from 'vitest';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb } from './test-utils';
import { wikiTopics, llmSuggestions, pages, topicSources } from '@zhipane/db';
import { markTopicsStaleForPage, undoSuggestion } from '../services/wiki.service';

describe('wiki — stale topics & reversible suggestions', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('marks accepted AI topics stale (never silently overwrites) when a source page is reprocessed', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    const [page] = await db.insert(pages).values({
      workspaceId: ws.id, spaceId: sp.id, title: 'Source note',
      contentJson: { type: 'doc', content: [] }, textContent: 'updated content', status: 'normal',
      createdById: user.id, updatedById: user.id
    }).returning();
    const [topic] = await db.insert(wikiTopics).values({
      workspaceId: ws.id, spaceId: sp.id, title: 'Old Topic',
      contentJson: { type: 'doc', content: [] }, source: 'ai_generated', status: 'accepted',
      updatePolicy: 'suggest_only'
    }).returning();
    await db.insert(topicSources).values({ topicId: topic.id, pageId: page.id });

    await markTopicsStaleForPage(page.id);

    const [updated] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}`).limit(1);
    expect(updated?.status).toBe('stale');

    const sugg = await db.select().from(llmSuggestions)
      .where(sql`space_id = ${sp.id} AND type = 'stale_topic' AND status = 'pending'`);
    expect(sugg).toHaveLength(1);
    expect((sugg[0].payload as { topicId?: string }).topicId).toBe(topic.id);
  });

  it('does NOT flag topics with auto_update policy', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    const [page] = await db.insert(pages).values({
      workspaceId: ws.id, spaceId: sp.id, title: 'Source note',
      contentJson: { type: 'doc', content: [] }, textContent: 'x', status: 'normal',
      createdById: user.id, updatedById: user.id
    }).returning();
    const [topic] = await db.insert(wikiTopics).values({
      workspaceId: ws.id, spaceId: sp.id, title: 'Auto Topic',
      contentJson: { type: 'doc', content: [] }, source: 'ai_generated', status: 'accepted',
      updatePolicy: 'auto_update'
    }).returning();
    await db.insert(topicSources).values({ topicId: topic.id, pageId: page.id });

    await markTopicsStaleForPage(page.id);

    const [updated] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}`).limit(1);
    expect(updated?.status).toBe('accepted');
  });

  it('undo reverts an accepted suggestion and its side effect', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    const [topic] = await db.insert(wikiTopics).values({
      workspaceId: ws.id, spaceId: sp.id, title: 'T', contentJson: { type: 'doc', content: [] },
      source: 'ai_generated', status: 'accepted'
    }).returning();
    const [sugg] = await db.insert(llmSuggestions).values({
      workspaceId: ws.id, spaceId: sp.id, pageId: null, topicId: topic.id,
      type: 'topic_proposal', risk: 'low', status: 'accepted',
      payload: { topicId: topic.id, topicTitle: 'T' }, evidence: {}
    }).returning();

    await undoSuggestion(sugg.id);

    const [s] = await db.select().from(llmSuggestions).where(sql`id = ${sugg.id}`).limit(1);
    expect(s?.status).toBe('pending');
    const [t] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}`).limit(1);
    expect(t?.status).toBe('suggested');
  });
});

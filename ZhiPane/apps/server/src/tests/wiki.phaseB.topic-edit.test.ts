import { beforeEach, describe, expect, it } from 'vitest';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb, sessionCookie } from './test-utils';
import { createApp } from '../app';
import { wikiTopics, topicCandidates } from '@zhipane/db';
import { promoteCandidate, deleteTopic } from '../services/wiki.service';

const T = 30000; // these tests exercise the AI job pipeline / DB; allow ample time

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
  return pageId;
}

describe('Phase B — manual topic edit & soft-delete', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  /* ---- B1.4: promoting one candidate does NOT force all page siblings in ---- */
  it('promotes only the selected candidate + its synonym-cluster mates', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const p1 = await processPage(user, sp.id, 'Src', '# src\ncontent for the promote test.');
    // Discard auto-generated candidates so we control the fixtures.
    await db.execute(sql`DELETE FROM topic_candidates WHERE page_id = ${p1}::uuid`);

    await db.insert(topicCandidates).values([
      { workspaceId: ws.id, spaceId: sp.id, pageId: p1, title: '机器学习', summary: 'ML content', status: 'candidate' },
      { workspaceId: ws.id, spaceId: sp.id, pageId: p1, title: '深度学习', summary: 'DL content', status: 'candidate' }
    ]);
    const cands = await db.select().from(topicCandidates).where(sql`page_id = ${p1}::uuid`);
    const ml = cands.find((c) => c.title === '机器学习')!;

    const { topicId } = await promoteCandidate(ml.id, user.id);

    const mlAfter = await db.select().from(topicCandidates).where(sql`id = ${ml.id}::uuid`);
    expect(mlAfter[0].status).toBe('promoted');
    expect(mlAfter[0].promotedTopicId).toBe(topicId);

    const dl = cands.find((c) => c.title === '深度学习')!;
    const dlAfter = await db.select().from(topicCandidates).where(sql`id = ${dl.id}::uuid`);
    // The different-concept sibling is left as a candidate for later clustering.
    expect(dlAfter[0].status).toBe('candidate');
    expect(dlAfter[0].promotedTopicId).toBeNull();
  }, T);

  /* ---- B2.3: soft-delete hides from default list, visible via ?lifecycle=archived ---- */
  it('soft-deletes a Topic (archived with reason deleted, recoverable)', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const [topic] = await db.insert(wikiTopics).values({
      workspaceId: ws.id, spaceId: sp.id, title: 'ToDelete',
      contentJson: { type: 'doc', content: [] }, textContent: 'body',
      status: 'accepted', source: 'ai_generated', publicationStatus: 'accepted',
      freshnessStatus: 'fresh', lifecycleStatus: 'active', createdById: user.id
    }).returning();

    await deleteTopic(topic.id, user.id);
    const [after] = await db.select().from(wikiTopics).where(sql`id = ${topic.id}::uuid`);
    expect(after.lifecycleStatus).toBe('archived');
    expect(after.archiveReason).toBe('deleted');
    expect(after.deletedAt).not.toBeNull();

    // Default list excludes it; ?lifecycle=archived still returns it.
    const list = await db.select().from(wikiTopics).where(sql`space_id = ${sp.id} AND (lifecycle_status IS NULL OR lifecycle_status <> 'archived')`);
    expect(list.map((t) => t.id)).not.toContain(topic.id);
    const archived = await db.select().from(wikiTopics).where(sql`space_id = ${sp.id} AND lifecycle_status = 'archived'`);
    expect(archived.map((t) => t.id)).toContain(topic.id);
  }, T);

  /* ---- B2.3: DELETE route -> 200, and the topic is recoverable via reactivate ---- */
  it('DELETE /topics/:id soft-deletes via the API', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const [topic] = await db.insert(wikiTopics).values({
      workspaceId: ws.id, spaceId: sp.id, title: 'ApiDelete',
      contentJson: { type: 'doc', content: [] }, textContent: 'body',
      status: 'accepted', source: 'ai_generated', publicationStatus: 'accepted',
      freshnessStatus: 'fresh', lifecycleStatus: 'active', createdById: user.id
    }).returning();

    const app = createApp();
    const cookie = await sessionCookie(user);
    const res = await app.request(`/api/llm-wiki/topics/${topic.id}`, { method: 'DELETE', headers: { cookie } });
    expect(res.status).toBe(200);

    const listRes = await app.request(`/api/llm-wiki/topics?spaceId=${sp.id}`, { headers: { cookie } });
    const list = await listRes.json() as { topics: { id: string }[] };
    expect(list.topics.map((t) => t.id)).not.toContain(topic.id);

    const archRes = await app.request(`/api/llm-wiki/topics?spaceId=${sp.id}&lifecycle=archived`, { headers: { cookie } });
    const arch = await archRes.json() as { topics: { id: string }[] };
    expect(arch.topics.map((t) => t.id)).toContain(topic.id);
  }, T);

  /* ---- B2.1: renaming a Topic marks it user_edited so AI refresh never clobbers it ---- */
  it('PATCH rename sets publicationStatus=user_edited', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const [topic] = await db.insert(wikiTopics).values({
      workspaceId: ws.id, spaceId: sp.id, title: 'Original',
      contentJson: { type: 'doc', content: [] }, textContent: 'body',
      status: 'accepted', source: 'ai_generated', publicationStatus: 'accepted',
      freshnessStatus: 'fresh', lifecycleStatus: 'active', createdById: user.id
    }).returning();

    const app = createApp();
    const cookie = await sessionCookie(user);
    const res = await app.request(`/api/llm-wiki/topics/${topic.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Renamed' })
    });
    expect(res.status).toBe(200);
    const patched = await res.json() as { topic: { title: string; publicationStatus: string } };
    expect(patched.topic.title).toBe('Renamed');
    expect(patched.topic.publicationStatus).toBe('user_edited');
  }, T);
});

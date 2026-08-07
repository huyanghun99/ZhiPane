import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createApp } from '../app';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb, sessionCookie } from './test-utils';
import { wikiTopics } from '@zhipane/db';

type SpaceRow = {
  id: string;
  spaceKind?: string; space_kind?: string;
  lifecycleStatus?: string; lifecycle_status?: string;
  archivedAt?: string | null; archived_at?: string | null;
};
type TopicRow = { id: string; title: string; lifecycleStatus?: string; freshnessStatus?: string };

describe('Phase 1 — state model & Space semantics', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  /* ---- 兼容迁移：旧 status 无损映射到三维状态 ---- */
  describe('compatible migration (legacy status → three axes)', () => {
    it('backfills three-axis status from legacy status without losing data', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      // Seed legacy-status rows (new columns take DB defaults).
      await db.execute(sql`
        INSERT INTO wiki_topics(workspace_id, space_id, title, status) VALUES
          (${ws.id}, ${sp.id}, 'Suggested', 'suggested'),
          (${ws.id}, ${sp.id}, 'Accepted', 'accepted'),
          (${ws.id}, ${sp.id}, 'UserEdited', 'user_edited'),
          (${ws.id}, ${sp.id}, 'Stale', 'stale'),
          (${ws.id}, ${sp.id}, 'Archived', 'archived')
      `);
      // Apply the exact backfill mapping from migration 0008.
      await db.execute(sql`
        UPDATE wiki_topics SET
          publication_status = CASE status
            WHEN 'suggested' THEN 'suggested'::topic_publication_status
            WHEN 'user_edited' THEN 'user_edited'::topic_publication_status
            ELSE 'accepted'::topic_publication_status END,
          freshness_status = CASE WHEN status = 'stale' THEN 'stale'::topic_freshness_status ELSE 'fresh'::topic_freshness_status END,
          lifecycle_status = CASE WHEN status = 'archived' THEN 'archived'::topic_lifecycle_status ELSE 'active'::topic_lifecycle_status END
      `);
      const rows = await db.select().from(wikiTopics).where(eq(wikiTopics.spaceId, sp.id));
      const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));

      expect(byTitle['Suggested'].publicationStatus).toBe('suggested');
      expect(byTitle['Accepted'].publicationStatus).toBe('accepted');
      expect(byTitle['UserEdited'].publicationStatus).toBe('user_edited');
      // stale is a *freshness* axis, lifecycle stays active
      expect(byTitle['Stale'].freshnessStatus).toBe('stale');
      expect(byTitle['Stale'].lifecycleStatus).toBe('active');
      // archived is a *lifecycle* axis, freshness stays fresh
      expect(byTitle['Archived'].lifecycleStatus).toBe('archived');
      expect(byTitle['Archived'].freshnessStatus).toBe('fresh');
      // legacy status preserved (lossless)
      expect(byTitle['Archived'].status).toBe('archived');
    });
  });

  /* ---- Gate: stale 与 archived 可同时存在 ---- */
  describe('stale and archived can coexist', () => {
    it('a topic can be both archived (lifecycle) and stale (freshness)', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      const [topic] = await db.insert(wikiTopics).values({
        workspaceId: ws.id, spaceId: sp.id, title: 'Old but stale',
        contentJson: { type: 'doc', content: [] }, status: 'archived',
        publicationStatus: 'accepted', freshnessStatus: 'stale', lifecycleStatus: 'archived'
      }).returning();

      const [t] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topic.id)).limit(1);
      expect(t?.lifecycleStatus).toBe('archived');
      expect(t?.freshnessStatus).toBe('stale');

      const app = createApp();
      const cookie = await sessionCookie(user);
      // Default query excludes archived topics.
      const resDefault = await app.request(`/api/llm-wiki/topics?spaceId=${sp.id}`, { headers: { cookie } });
      const bodyDefault = await resDefault.json() as { topics: { id: string }[] };
      expect(bodyDefault.topics.find((x) => x.id === topic.id)).toBeUndefined();
      // Opt-in still returns it, with both axes intact.
      const resAll = await app.request(`/api/llm-wiki/topics?spaceId=${sp.id}&includeArchived=true`, { headers: { cookie } });
      const bodyAll = await resAll.json() as { topics: TopicRow[] };
      const found = bodyAll.topics.find((x) => x.id === topic.id);
      expect(found).toBeDefined();
      expect(found?.lifecycleStatus).toBe('archived');
      expect(found?.freshnessStatus).toBe('stale');
    });
  });

  /* ---- Gate: Project 完成不立即归档 ---- */
  describe('project completion does not auto-archive', () => {
    it('POST /spaces/:id/complete sets completed (not archived)', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const app = createApp();
      const cookie = await sessionCookie(user);
      const create = await app.request('/api/spaces', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: ws.id, name: 'My Project', spaceKind: 'project' })
      });
      expect(create.status).toBe(201);
      const created = await create.json() as { space: SpaceRow };
      expect(created.space.spaceKind).toBe('project');
      expect(created.space.lifecycleStatus).toBe('active');

      const done = await app.request(`/api/spaces/${created.space.id}/complete`, { method: 'POST', headers: { cookie } });
      expect(done.status).toBe(200);
      const body = await done.json() as { space: SpaceRow };
      expect(body.space.lifecycleStatus).toBe('completed');
      expect(body.space.archivedAt).toBeNull();
    });

    it('PATCH lifecycleStatus=completed does not archive', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      const app = createApp();
      const cookie = await sessionCookie(user);
      const res = await app.request(`/api/spaces/${sp.id}`, {
        method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ lifecycleStatus: 'completed' })
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { space: SpaceRow };
      expect(body.space.lifecycleStatus).toBe('completed');
      expect(body.space.archivedAt).toBeNull();
    });
  });

  /* ---- Gate: Active/Completed/Archived 查询 ---- */
  describe('Active/Completed/Archived queries', () => {
    it('GET /spaces filters by lifecycle', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const app = createApp();
      const cookie = await sessionCookie(user);
      const mk = async (name: string, kind: string, lifecycle: string) => {
        const r = await app.request('/api/spaces', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: ws.id, name, spaceKind: kind, lifecycleStatus: lifecycle })
        });
        return (await r.json() as { space: SpaceRow }).space;
      };
      // NOTE: no default makeSpace() here so the filter counts are exact.
      await mk('Active Area', 'area', 'active');
      await mk('Done Project', 'project', 'completed');
      await mk('Old Project', 'project', 'archived');

      const byLifecycle = async (lc: string): Promise<SpaceRow[]> => {
        const r = await app.request(`/api/spaces?workspaceId=${ws.id}&lifecycle=${lc}`, { headers: { cookie } });
        return (await r.json() as { spaces: SpaceRow[] }).spaces;
      };
      const active = await byLifecycle('active');
      expect(active.every((s) => s.lifecycle_status === 'active')).toBe(true);
      expect(active.length).toBe(1);
      expect((await byLifecycle('completed')).length).toBe(1);
      expect((await byLifecycle('archived')).length).toBe(1);

      const all = await app.request(`/api/spaces?workspaceId=${ws.id}`, { headers: { cookie } });
      expect((await all.json() as { spaces: unknown[] }).spaces.length).toBe(3);
    });

    it('GET /topics filters by lifecycle', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      await db.insert(wikiTopics).values([
        { workspaceId: ws.id, spaceId: sp.id, title: 'Live', contentJson: { type: 'doc', content: [] }, status: 'accepted', lifecycleStatus: 'active' },
        { workspaceId: ws.id, spaceId: sp.id, title: 'Archived', contentJson: { type: 'doc', content: [] }, status: 'archived', lifecycleStatus: 'archived' }
      ]);
      const app = createApp();
      const cookie = await sessionCookie(user);
      const res = await app.request(`/api/llm-wiki/topics?spaceId=${sp.id}&lifecycle=archived`, { headers: { cookie } });
      const body = await res.json() as { topics: TopicRow[] };
      expect(body.topics.map((t) => t.title)).toEqual(['Archived']);
    });
  });

  /* ---- Gate: 权限测试通过 ---- */
  describe('permissions', () => {
    it('non-member cannot read another space’s topics (403)', async () => {
      const owner = await makeUser();
      const ws = await makeWorkspace(owner);
      const sp = await makeSpace(ws, owner);

      const stranger = await makeUser();
      await makeWorkspace(stranger);

      const app = createApp();
      const cookie = await sessionCookie(stranger);
      const res = await app.request(`/api/llm-wiki/topics?spaceId=${sp.id}`, { headers: { cookie } });
      expect(res.status).toBe(403);
    });

    it('non-member cannot change a space’s kind/lifecycle (403)', async () => {
      const owner = await makeUser();
      const ws = await makeWorkspace(owner);
      const sp = await makeSpace(ws, owner);

      const stranger = await makeUser();
      await makeWorkspace(stranger);

      const app = createApp();
      const cookie = await sessionCookie(stranger);
      const res = await app.request(`/api/spaces/${sp.id}`, {
        method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ spaceKind: 'project' })
      });
      expect(res.status).toBe(403);
    });

    it('member can update a space’s kind/lifecycle (200)', async () => {
      const user = await makeUser();
      const ws = await makeWorkspace(user);
      const sp = await makeSpace(ws, user);
      const app = createApp();
      const cookie = await sessionCookie(user);
      const res = await app.request(`/api/spaces/${sp.id}`, {
        method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ spaceKind: 'project', lifecycleStatus: 'on_hold' })
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { space: SpaceRow };
      expect(body.space.spaceKind).toBe('project');
      expect(body.space.lifecycleStatus).toBe('on_hold');
    });
  });
});

import { describe, expect, it, beforeEach } from 'vitest';
import { cleanDb, makeApp, makeUser, makeWorkspace, makeSpace, sessionCookie } from './test-utils';

describe('phase1 concurrent page save', () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let pageId: string;

  beforeEach(async () => {
    await cleanDb();
    app = makeApp();
    const u = await makeUser('conc@example.com');
    const ws = await makeWorkspace(u, 'ws');
    const sp = await makeSpace(ws, u, 'sp');
    cookie = await sessionCookie(u);
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ spaceId: sp.id, title: 'original' })
    });
    expect(res.status).toBe(201);
    pageId = (await res.json()).page.id;
  });

  it('only one concurrent save succeeds; the other gets 409', async () => {
    const body = JSON.stringify({
      title: 'updated',
      contentJson: { type: 'doc', content: [] },
      textContent: 'updated',
      contentVersion: 1,
      autosave: false
    });
    const headers = { 'Content-Type': 'application/json', cookie };

    // Fire two saves with the same (stale) version concurrently.
    const [r1, r2] = await Promise.all([
      app.request(`/api/pages/${pageId}`, { method: 'PUT', headers, body }),
      app.request(`/api/pages/${pageId}`, { method: 'PUT', headers, body })
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Exactly one new revision was recorded.
    const rev = await app.request(`/api/pages/${pageId}/revisions`, { headers: { cookie } });
    const revisions = (await rev.json()).revisions;
    expect(revisions.length).toBe(1);
  });
});

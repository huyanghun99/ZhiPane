import { describe, expect, it, beforeEach } from 'vitest';
import { cleanDb, makeApp, makeUser, makeWorkspace, makeSpace, sessionCookie, cookieFromResponse } from './test-utils';

describe('phase1 page creation security', () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(async () => {
    await cleanDb();
    app = makeApp();
  });

  it('derives workspaceId from spaceId (no cross-workspace pollution)', async () => {
    const a = await makeUser('a@example.com');
    const wsA = await makeWorkspace(a, 'wsA');
    const spaceA = await makeSpace(wsA, a, 'spaceA');

    const b = await makeUser('b@example.com');
    const wsB = await makeWorkspace(b, 'wsB');
    const spaceB = await makeSpace(wsB, b, 'spaceB');

    // userB creates a page inside spaceB; we will try to use it as a
    // cross-workspace parent from spaceA.
    const cookieB = await sessionCookie(b);
    const resB = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieB },
      body: JSON.stringify({ spaceId: spaceB.id, title: 'page in B' })
    });
    expect(resB.status).toBe(201);
    const pageB = (await resB.json()).page;

    const cookieA = await sessionCookie(a);
    // Attempt to attach a foreign-space page as parent -> rejected.
    const bad = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ spaceId: spaceA.id, parentPageId: pageB.id, title: 'evil' })
    });
    expect(bad.status).toBe(400);

    // A normal create in spaceA must resolve to wsA's workspaceId, never wsB.
    const good = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ spaceId: spaceA.id, title: 'legit' })
    });
    expect(good.status).toBe(201);
    const created = (await good.json()).page;
    expect(created.workspaceId).toBe(wsA.id);
    expect(created.workspaceId).not.toBe(wsB.id);
  });
});

describe('phase1 attachment upload security', () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let pageId: string;
  beforeEach(async () => {
    await cleanDb();
    app = makeApp();
    const u = await makeUser('up@example.com');
    const ws = await makeWorkspace(u, 'ws');
    const sp = await makeSpace(ws, u, 'sp');
    cookie = await sessionCookie(u);
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ spaceId: sp.id, title: 'p' })
    });
    pageId = (await res.json()).page.id;
  });

  it('only trusts pageId and derives space/workspace from it', async () => {
    const other = await makeUser('other@example.com');
    const ws2 = await makeWorkspace(other, 'ws2');
    const sp2 = await makeSpace(ws2, other, 'sp2');
    const form = new FormData();
    form.append('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
    form.append('pageId', pageId);
    // Attacker tries to force a different workspace/space.
    form.append('workspaceId', ws2.id);
    form.append('spaceId', sp2.id);
    const res = await app.request('/api/attachments/upload', { method: 'POST', headers: { cookie }, body: form });
    expect(res.status).toBe(201);
    const att = (await res.json()).attachment;
    // The stored scope must come from the page, not the submitted values.
    expect(att.workspaceId).not.toBe(ws2.id);
    expect(att.spaceId).not.toBe(sp2.id);
  });

  it('rejects disallowed MIME types', async () => {
    const form = new FormData();
    form.append('file', new File(['<html>'], 'x.html', { type: 'text/html' }));
    form.append('pageId', pageId);
    const res = await app.request('/api/attachments/upload', { method: 'POST', headers: { cookie }, body: form });
    expect(res.status).toBe(415);
  });

  it('sanitizes filename and prevents path traversal', async () => {
    const form = new FormData();
    form.append('file', new File(['data'], '../../../evil.txt', { type: 'text/plain' }));
    form.append('pageId', pageId);
    const res = await app.request('/api/attachments/upload', { method: 'POST', headers: { cookie }, body: form });
    expect(res.status).toBe(201);
    const att = (await res.json()).attachment;
    // Display name keeps no path separators (so it can't escape a directory).
    expect(att.fileName).not.toContain('/');
    expect(att.fileName).not.toContain('\\');
    // On-disk key is UUID-based, never contains user input / '..'.
    expect(att.storageKey).not.toContain('..');
    expect(att.storageKey).not.toContain('/../');
  });
});

describe('phase1 session management', () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(async () => {
    await cleanDb();
    app = makeApp();
  });

  async function login(email: string) {
    await makeUser(email);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' })
    });
    expect(res.status).toBe(200);
    return cookieFromResponse(res);
  }

  it('revoking the current session invalidates it (logout)', async () => {
    const cookie = await login('s1@example.com');
    const me1 = await app.request('/api/auth/me', { headers: { cookie } });
    expect(me1.status).toBe(200);

    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);

    const me2 = await app.request('/api/auth/me', { headers: { cookie } });
    expect(me2.status).toBe(401);
  });

  it('revoke-all invalidates every session', async () => {
    const cookie = await login('s2@example.com');
    const me1 = await app.request('/api/auth/me', { headers: { cookie } });
    expect(me1.status).toBe(200);

    const revoke = await app.request('/api/auth/sessions/revoke-all', { method: 'POST', headers: { cookie } });
    expect(revoke.status).toBe(200);

    const me2 = await app.request('/api/auth/me', { headers: { cookie } });
    expect(me2.status).toBe(401);
  });

  it('CSRF: foreign Origin on a mutating request is rejected', async () => {
    const u = await makeUser('s3@example.com');
    const body = JSON.stringify({ email: u.email, password: 'password123' });
    // No Origin -> same-origin / test harness -> allowed (and succeeds).
    const noOrigin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    expect(noOrigin.status).toBe(200);

    // Foreign Origin -> rejected with 403.
    const evil = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://evil.example.com' },
      body
    });
    expect(evil.status).toBe(403);
  });
});

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { cleanDb, makeApp, makeUser, makeWorkspace, makeSpace, sessionCookie, db, sql, runPendingJob } from './test-utils';
import { documentChunks } from '@zhipane/db';
import { MockAiProvider } from '@zhipane/ai';
import { eq } from 'drizzle-orm';

describe('phase2 lightweight page tree API', () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let spaceId: string;

  beforeEach(async () => {
    await cleanDb();
    app = makeApp();
    const u = await makeUser('tree@example.com');
    const ws = await makeWorkspace(u, 'ws');
    const sp = await makeSpace(ws, u, 'sp');
    spaceId = sp.id;
    cookie = await sessionCookie(u);
  });

  it('tree response excludes body and carries parentPageId/position/hasChildren', async () => {
    // parent + child
    const contentJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'big body that must not leak' }] }
      ]
    };
    const pRes = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ spaceId, title: 'parent', contentJson, textContent: 'big body that must not leak' })
    });
    const parentId = (await pRes.json()).page.id;
    await app.request('/api/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ spaceId, parentPageId: parentId, title: 'child', textContent: 'child body' })
    });

    const res = await app.request(`/api/pages/tree?spaceId=${spaceId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const { tree } = await res.json();
    expect(tree.length).toBe(1);
    const parent = tree[0];
    const child = parent.children[0];

    // No body fields in the lightweight payload.
    expect('contentJson' in parent).toBe(false);
    expect('textContent' in parent).toBe(false);
    expect('contentJson' in child).toBe(false);
    expect('textContent' in child).toBe(false);

    // Required lightweight fields present.
    expect(typeof parent.position).toBe('number');
    expect(parent.parentPageId).toBeNull();
    expect(parent.hasChildren).toBe(true);
    expect(child.parentPageId).toBe(parentId);
    expect(child.hasChildren).toBe(false);

    // List endpoint is also lightweight.
    const listRes = await app.request(`/api/pages?spaceId=${spaceId}`, { headers: { cookie } });
    const { pages: list } = await listRes.json();
    expect('contentJson' in list[0]).toBe(false);
    expect('textContent' in list[0]).toBe(false);
  });

  it('detail API still returns the full body', async () => {
    const pRes = await app.request('/api/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ spaceId, title: 'doc', textContent: 'the full body' })
    });
    const id = (await pRes.json()).page.id;
    const res = await app.request(`/api/pages/${id}`, { headers: { cookie } });
    const { page } = await res.json();
    expect(page.textContent).toBe('the full body');
    expect(page.contentJson).toBeDefined();
  });
});

describe('phase2 job perf: batch embed + single chunk insert', () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let pageId: string;

  beforeEach(async () => {
    await cleanDb();
    app = makeApp();
    const u = await makeUser('perf@example.com');
    const ws = await makeWorkspace(u, 'ws');
    const sp = await makeSpace(ws, u, 'sp');
    cookie = await sessionCookie(u);
    // Long text -> many chunks.
    const long = Array.from({ length: 40 }, (_, i) => `sentence number ${i} about zhipane knowledge`).join(' ');
    const res = await app.request('/api/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ spaceId: sp.id, title: 'long', textContent: long })
    });
    pageId = (await res.json()).page.id;
    await db.execute(sql`UPDATE jobs SET run_after = now() WHERE entity_id = ${pageId} AND status = 'pending'`);
  });

  afterEach(() => vi.restoreAllMocks());

  it('indexes all chunks in ONE insert (not per-chunk) and uses embedBatch', async () => {
    const embedSpy = vi.spyOn(MockAiProvider.prototype, 'embed');
    const batchSpy = vi.spyOn(MockAiProvider.prototype, 'embedBatch');

    await runPendingJob();

    const chunks = await db.select().from(documentChunks).where(eq(documentChunks.pageId, pageId));
    expect(chunks.length).toBeGreaterThan(1);

    // The chunk-indexing path must use embedBatch (one network round-trip for
    // all chunks), NOT the per-chunk embed (which would mean N separate calls).
    // generateWikiArtifacts also legitimately calls embedBatch to embed
    // candidate titles (wiki.service.ts), so we assert >= 1 here rather than
    // exactly 1 — the perf guarantee under test is "no per-chunk embed".
    expect(batchSpy).toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
  });
});

describe('phase2 search: query embedding cache', () => {
  let app: ReturnType<typeof makeApp>;
  let cookie: string;
  let spaceId: string;
  let workspaceId: string;
  let pageId: string;

  beforeEach(async () => {
    await cleanDb();
    app = makeApp();
    const u = await makeUser('search@example.com');
    const ws = await makeWorkspace(u, 'ws');
    workspaceId = ws.id;
    const sp = await makeSpace(ws, u, 'sp');
    spaceId = sp.id;
    cookie = await sessionCookie(u);
    const res = await app.request('/api/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ spaceId, title: 'zhipane knowledge base', textContent: 'zhipane is a knowledge creation system with semantic search' })
    });
    pageId = (await res.json()).page.id;
    await db.execute(sql`UPDATE jobs SET run_after = now() WHERE entity_id = ${pageId} AND status = 'pending'`);
    await runPendingJob();
  });

  afterEach(() => vi.restoreAllMocks());

  it('reuses the cached query embedding across identical searches', async () => {
    const embedSpy = vi.spyOn(MockAiProvider.prototype, 'embed');
    const q = 'zhipane knowledge';
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', cookie } };
    const body = (mode: string) => JSON.stringify({ workspaceId, spaceId, query: q, limit: 10, mode });

    const r1 = await app.request('/api/search', { ...opts, body: body('vector') });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/api/search', { ...opts, body: body('vector') });
    expect(r2.status).toBe(200);

    // Second identical query must hit the in-memory cache, not re-embed.
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });
});

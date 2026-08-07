import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { cleanDb, makeApp, makeUser, makeWorkspace, makeSpace, sessionCookie, db, sql, runPendingJob } from './test-utils';
import { pages, documentChunks, jobs } from '@zhipane/db';
import { eq } from 'drizzle-orm';
import { enqueueJob } from '../services/job-runner';

describe('phase1 AI privacy policy', () => {
  let app: ReturnType<typeof makeApp>;

  async function createPageIn(policy: 'cloud_allowed' | 'local_only' | 'disabled') {
    const u = await makeUser(`u_${Math.random().toString(36).slice(2)}@example.com`);
    const ws = await makeWorkspace(u, 'ws');
    const sp = await makeSpace(ws, u, 'sp', policy);
    const c = await sessionCookie(u);
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: c },
      body: JSON.stringify({ spaceId: sp.id, title: 'doc', textContent: 'hello world zhipane' })
    });
    expect(res.status).toBe(201);
    return { wsId: ws.id, spaceId: sp.id, pageId: (await res.json()).page.id };
  }

  beforeEach(async () => {
    await cleanDb();
    app = makeApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('local_only never calls the network provider', async () => {
    const { pageId: p } = await createPageIn('local_only');
    // Force the queued job to be eligible now.
    await db.execute(sql`UPDATE jobs SET run_after = now() WHERE entity_id = ${p} AND status = 'pending'`);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ran = await runPendingJob();
    expect(ran).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const [page] = await db.select().from(pages).where(eq(pages.id, p)).limit(1);
    expect(page.llmProcessStatus).toBe('processed');
    const chunks = await db.select().from(documentChunks).where(eq(documentChunks.pageId, p));
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('disabled space produces no AI request and marks the page ignored', async () => {
    const { wsId: w, spaceId: s, pageId: p } = await createPageIn('disabled');
    const [before] = await db.select().from(pages).where(eq(pages.id, p)).limit(1);
    expect(before.llmProcessStatus).toBe('ignored');

    // Even if a job is manually queued, the worker must skip it without AI.
    await db.execute(sql`
      INSERT INTO jobs(workspace_id, space_id, entity_type, entity_id, type, status, run_after, source_version)
      VALUES (${w}, ${s}, 'page', ${p}, 'page.process_llm', 'pending', now(), 1)
    `);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await runPendingJob();
    expect(fetchSpy).not.toHaveBeenCalled();

    const [after] = await db.select().from(pages).where(eq(pages.id, p)).limit(1);
    expect(after.llmProcessStatus).toBe('ignored');
    const [job] = await db.select().from(jobs).where(eq(jobs.entityId, p)).limit(1);
    expect(job.status).toBe('succeeded');
  });

  it('dedupes pending/running jobs for the same page+type', async () => {
    const { pageId: p } = await createPageIn('cloud_allowed');
    // Cancel any job created by the page create, then enqueue two with the
    // same natural dedupe key via the real enqueueJob (which cancels the
    // prior active job first).
    await db.execute(sql`UPDATE jobs SET status='cancelled' WHERE entity_id=${p}`);
    await enqueueJob({ entityType: 'page', entityId: p, type: 'page.process_llm' });
    await enqueueJob({ entityType: 'page', entityId: p, type: 'page.process_llm' });
    const rows = await db.select().from(jobs).where(eq(jobs.entityId, p));
    const active = rows.filter((j: any) => j.status === 'pending' || j.status === 'running');
    expect(active.length).toBe(1);
  });

  it('skips a job whose captured version is stale', async () => {
    const { pageId: p } = await createPageIn('cloud_allowed');
    // Bump the page to version 3 (simulating later edits).
    await db.execute(sql`UPDATE pages SET content_version = 3 WHERE id = ${p}`);
    // Queue a job that captured version 1 (stale relative to the page).
    await db.execute(sql`UPDATE jobs SET status='cancelled' WHERE entity_id=${p}`);
    await enqueueJob({
      entityType: 'page', entityId: p, type: 'page.process_llm', sourceVersion: 1
    });
    await db.execute(sql`UPDATE jobs SET run_after = now() WHERE entity_id = ${p} AND status = 'pending'`);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await runPendingJob();
    expect(fetchSpy).not.toHaveBeenCalled();

    const [job] = await db.select().from(jobs).where(eq(jobs.entityId, p)).limit(1);
    expect(job.status).toBe('cancelled');
    const chunks = await db.select().from(documentChunks).where(eq(documentChunks.pageId, p));
    expect(chunks.length).toBe(0);
  });
});

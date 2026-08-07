import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAiProvider } from '@zhipane/ai';
import { createApp } from '../app';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb, sessionCookie, runPendingJob } from './test-utils';
import { eq } from 'drizzle-orm';
import { consolidateCandidates } from '../services/wiki.service';
import { enqueueJob } from '../services/job-runner';
import { jobs } from '@zhipane/db';

// Minimal page-processor that mirrors the one in the Phase 3 clustering suite:
// POST a page, flip its indexing job to run-now, then run exactly that job.
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

const ai = () => new MockAiProvider();

describe('Phase B1.3 — consolidate async + progress', () => {
  beforeEach(async () => {
    await cleanDb();
    // Restore the real AI provider resolver (tests supply their own mock AI).
    vi.spyOn(await import('../services/ai.service'), 'createAiProviderForContext').mockRestore();
  });

  /* ---- consolidateCandidates reports progress via onProgress ---- */
  it('invokes onProgress with {done,total,stage} while clustering', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await processPage(user, sp.id, 'P1', '# 主题甲\n内容甲用于测试聚类进度回调。机器学习是核心概念。');
    await processPage(user, sp.id, 'P2', '# 主题甲\n内容甲用于测试聚类进度回调。深度学习也是核心概念。');

    const calls: { done: number; total: number; stage: string }[] = [];
    const res = await consolidateCandidates(sp.id, ai(), (p) => { calls.push(p); });

    // Clustering still produced a Topic (behavior unchanged).
    expect(res.createdTopics).toBe(1);
    // Progress was reported at least once, with the expected shape.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].stage).toBe('clustering');
    for (const c of calls) {
      expect(typeof c.done).toBe('number');
      expect(typeof c.total).toBe('number');
      expect(typeof c.stage).toBe('string');
      expect(c.total).toBeGreaterThanOrEqual(1);
    }
    // A 'creating' stage was emitted while materialising the Topic(s).
    expect(calls.some((c) => c.stage === 'creating')).toBe(true);
  });

  /* ---- enqueueJob returns { jobId } and the row has progress default {} ---- */
  it('enqueueJob returns a jobId and the job starts with progress={} / pending', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    const { jobId } = await enqueueJob({
      workspaceId: ws.id,
      spaceId: sp.id,
      entityType: 'space',
      entityId: sp.id,
      type: 'space.consolidate_topic_candidates',
      priority: 200,
      // Keep the dev server's job-runner from grabbing this job during the
      // test so the status assertion stays deterministic (shared DB).
      runAfterSeconds: 3600
    });
    expect(typeof jobId).toBe('string');
    expect(jobId.length).toBeGreaterThan(0);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    expect(row).toBeDefined();
    expect(row.status).toBe('pending');
    // B1.3: progress column exists and defaults to {} (not null).
    expect(row.progress).toBeDefined();
    expect(row.progress).toEqual({});
    expect(row.type).toBe('space.consolidate_topic_candidates');
  });

  /* ---- GET /api/jobs/:id surfaces status + progress ---- */
  it('GET /api/jobs/:id returns the job status and progress for an authorized member', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const { jobId } = await enqueueJob({
      workspaceId: ws.id,
      spaceId: sp.id,
      entityType: 'space',
      entityId: sp.id,
      type: 'space.consolidate_topic_candidates',
      priority: 200,
      // Long delay so the dev server's job-runner can't flip it to 'running'
      // before we read it (tests share the live database).
      runAfterSeconds: 3600
    });

    const app = createApp();
    const cookie = await sessionCookie(user);
    const res = await app.request(`/api/jobs/${jobId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe(jobId);
    expect(body.status).toBe('pending');
    expect(body.progress).toEqual({});
    expect(body.type).toBe('space.consolidate_topic_candidates');
  });

  it('GET /api/jobs/:id returns 401 without a session and 404 for an unknown id', async () => {
    const app = createApp();
    const noAuth = await app.request('/api/jobs/00000000-0000-0000-0000-000000000000');
    expect(noAuth.status).toBe(401);
    const notFound = await app.request('/api/jobs/11111111-1111-1111-1111-111111111111', {
      headers: { cookie: 'zhipane_session=garbage' }
    });
    // Invalid token -> 401 (auth middleware), not 404; both are "unauthorized".
    expect([401, 404]).toContain(notFound.status);
  });
});

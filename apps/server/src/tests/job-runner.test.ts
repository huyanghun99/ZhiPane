import { beforeEach, describe, expect, it } from 'vitest';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb } from './test-utils';
import { jobs } from '@zhipane/db';
import { recoverZombieJobs } from '../services/job-runner';

describe('job-runner — zombie recovery', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  /* ---- Gate: 僵尸 job 回收 (stale running jobs are reset to pending) ---- */
  it('recovers running jobs whose lock expired (>5 min), leaves fresh ones alone', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);

    // A "running" job locked 10 minutes ago -> stale zombie -> reset to pending.
    const [zombie] = await db.insert(jobs).values({
      workspaceId: ws.id, spaceId: sp.id, entityType: 'space', entityId: sp.id,
      type: 'space.consolidate_topic_candidates', status: 'running',
      lockedBy: 'worker-dead', lockedAt: new Date(Date.now() - 10 * 60 * 1000), priority: 100
    }).returning();
    // A recently-locked "running" job -> still in flight -> must stay running.
    const [fresh] = await db.insert(jobs).values({
      workspaceId: ws.id, spaceId: sp.id, entityType: 'space', entityId: sp.id,
      type: 'space.consolidate_topic_candidates', status: 'running',
      lockedBy: 'worker-alive', lockedAt: new Date(), priority: 100
    }).returning();

    const recovered = await recoverZombieJobs();
    expect(recovered).toBe(1);

    const [z] = await db.select().from(jobs).where(sql`id = ${zombie.id}`).limit(1);
    const [f] = await db.select().from(jobs).where(sql`id = ${fresh.id}`).limit(1);
    // Only the stale (10-min-old) job was reset; the fresh one is untouched.
    expect(z.status).toBe('pending');
    expect(z.lockedBy).toBeNull();
    expect(z.lockedAt).toBeNull();
    expect(f.status).toBe('running');
  });

  it('does nothing when there are no stale running jobs', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    await db.insert(jobs).values({
      workspaceId: ws.id, spaceId: sp.id, entityType: 'space', entityId: sp.id,
      type: 'space.consolidate_topic_candidates', status: 'pending', priority: 100
    });
    expect(await recoverZombieJobs()).toBe(0);
  });
});

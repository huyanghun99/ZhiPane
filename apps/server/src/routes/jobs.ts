import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { jobs } from '@zhipane/db';
import { canViewWorkspace } from '../services/permission.service';
import { getJobMetrics } from '../services/job-metrics';

export const jobRoutes = new Hono<AppEnv>();
jobRoutes.use('*', authMiddleware);

// Phase B (B1.3): poll a single job's status + progress so the UI can show a
// progress bar (e.g. for space.consolidate_topic_candidates) instead of
// blocking on a synchronous response.
jobRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) return c.json({ error: 'Not found' }, 404);
  // Scope: only members of the job's workspace may view it. Jobs created
  // without a workspace (shouldn't happen in practice) are not exposed.
  if (job.workspaceId && !(await canViewWorkspace(user.id, job.workspaceId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return c.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress ?? {},
    entityId: job.entityId,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  });
});

// Lightweight ops visibility into the single-process worker. Counters are
// in-memory (see job-metrics.ts); a shared store would slot in behind the
// same interface for multi-worker deployments.
jobRoutes.get('/metrics', async (c) => {
  return c.json({ metrics: getJobMetrics() });
});

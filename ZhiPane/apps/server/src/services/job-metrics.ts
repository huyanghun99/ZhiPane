import { logger } from './logger';

/**
 * In-memory job metrics + structured failure logging.
 *
 * The runner does not depend on Redis / BullMQ (project constraint). These
 * counters live in the current process and are exposed via `GET /api/jobs/metrics`
 * for ops visibility. They reset on restart, which is acceptable for a
 * single-process worker; for multi-worker deployments a shared store would be
 * swapped in behind this same interface.
 */

export interface JobMetrics {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  byType: Record<string, { succeeded: number; failed: number }>;
  lastError?: { jobId: string; type: string; attempts: number; message: string; at: string };
}

const metrics: JobMetrics = {
  processed: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  byType: {}
};

function bump(type: string, key: 'succeeded' | 'failed') {
  if (!metrics.byType[type]) metrics.byType[type] = { succeeded: 0, failed: 0 };
  metrics.byType[type][key]++;
}

export function recordProcessed(): void {
  metrics.processed++;
}

export function recordSuccess(type: string): void {
  metrics.succeeded++;
  bump(type, 'succeeded');
}

export function recordSkipped(reason: string): void {
  metrics.skipped++;
  logger.info('job skipped', { reason });
}

export function recordFailure(
  job: { id: string; type: string; attempts: number },
  error: unknown
): void {
  metrics.failed++;
  bump(job.type, 'failed');
  const message = error instanceof Error ? error.message : String(error);
  metrics.lastError = {
    jobId: job.id,
    type: job.type,
    attempts: job.attempts,
    message,
    at: new Date().toISOString()
  };
  // Structured failure log with enough context to debug without PII.
  logger.error('job failed', { jobId: job.id, type: job.type, attempts: job.attempts, err: message });
}

export function getJobMetrics(): JobMetrics {
  return metrics;
}

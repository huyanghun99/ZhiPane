import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * DB-backed job metrics for ops visibility (Phase H N2).
 *
 * The in-memory counters in `job-metrics.ts` reset on every restart and are
 * invisible in multi-worker deployments. This module aggregates the `jobs`
 * table directly so the numbers are durable, multi-worker safe, and can be
 * sliced by time window. Used by `GET /api/health/metrics`.
 */

export interface DbJobMetrics {
  queueDepth: { pending: number; running: number };
  totals: { succeeded: number; failed: number; cancelled: number };
  byType: Array<{ type: string; succeeded: number; failed: number; pending: number; running: number }>;
  recentFailures: Array<{ id: string; type: string; errorMessage: string; updatedAt: string }>;
  aiUsage: { totalPromptTokens: number; totalCompletionTokens: number };
  // 1-hour rolling success rate (succeeded / (succeeded + failed))
  successRate1h: number;
  // p50 / p95 processing latency in seconds (created_at -> updated_at for succeeded jobs in last 1h)
  latencySeconds1h: { p50: number | null; p95: number | null };
}

export async function getDbJobMetrics(): Promise<DbJobMetrics> {
  const [queueRes, totalsRes, byTypeRes, failuresRes, usageRes, successRateRes, latencyRes] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running
      FROM jobs
    `),
    db.execute<any>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
      FROM jobs
    `),
    db.execute<any>(sql`
      SELECT type,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running
      FROM jobs GROUP BY type ORDER BY type
    `),
    db.execute<any>(sql`
      SELECT id, type, error_message, updated_at
      FROM jobs WHERE status = 'failed' AND error_message IS NOT NULL
      ORDER BY updated_at DESC LIMIT 10
    `),
    db.execute<any>(sql`
      SELECT
        COALESCE(SUM(actual_prompt_tokens), 0)::bigint AS total_prompt_tokens,
        COALESCE(SUM(actual_completion_tokens), 0)::bigint AS total_completion_tokens
      FROM jobs
    `),
    db.execute<any>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM jobs
      WHERE updated_at > now() - interval '1 hour'
        AND status IN ('succeeded', 'failed')
    `),
    db.execute<any>(sql`
      WITH latencies AS (
        SELECT EXTRACT(EPOCH FROM (updated_at - created_at))::float8 AS seconds
        FROM jobs
        WHERE status = 'succeeded'
          AND updated_at > now() - interval '1 hour'
          AND updated_at > created_at
      )
      SELECT
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds), -1)::float8 AS p50,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY seconds), -1)::float8 AS p95
      FROM latencies
    `)
  ]);

  const q = queueRes.rows[0] ?? {};
  const t = totalsRes.rows[0] ?? {};
  const sr = successRateRes.rows[0] ?? { succeeded: 0, failed: 0 };
  const lat = latencyRes.rows[0] ?? { p50: -1, p95: -1 };
  const total = Number(sr.succeeded ?? 0) + Number(sr.failed ?? 0);

  return {
    queueDepth: { pending: Number(q.pending ?? 0), running: Number(q.running ?? 0) },
    totals: {
      succeeded: Number(t.succeeded ?? 0),
      failed: Number(t.failed ?? 0),
      cancelled: Number(t.cancelled ?? 0)
    },
    byType: byTypeRes.rows.map((r: any) => ({
      type: r.type,
      succeeded: Number(r.succeeded ?? 0),
      failed: Number(r.failed ?? 0),
      pending: Number(r.pending ?? 0),
      running: Number(r.running ?? 0)
    })),
    recentFailures: failuresRes.rows.map((r: any) => ({
      id: r.id,
      type: r.type,
      errorMessage: r.error_message,
      updatedAt: r.updated_at
    })),
    aiUsage: {
      totalPromptTokens: Number(usageRes.rows[0]?.total_prompt_tokens ?? 0),
      totalCompletionTokens: Number(usageRes.rows[0]?.total_completion_tokens ?? 0)
    },
    successRate1h: total === 0 ? 1 : Number(sr.succeeded ?? 0) / total,
    latencySeconds1h: {
      p50: lat.p50 === -1 ? null : Number(lat.p50),
      p95: lat.p95 === -1 ? null : Number(lat.p95)
    }
  };
}

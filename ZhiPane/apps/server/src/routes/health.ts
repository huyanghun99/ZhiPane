import { Hono, type Context } from 'hono';
import { sql } from 'drizzle-orm';
import { pool } from '../db/client';
import { db } from '../db/client';
import { getDbJobMetrics } from '../services/job-metrics-db';
import { logger } from '../services/logger';

const startedAt = Date.now();

export async function healthHandler(c: Context) {
  try {
    await pool.query('select 1');
    const { rows } = await db.execute<{ count: string }>(sql`SELECT count(*)::text FROM schema_migrations`);
    const migrationCount = rows[0]?.count ?? '0';
    return c.json({
      ok: true,
      service: 'zhipane-server',
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      db: 'connected',
      migrations: migrationCount
    });
  } catch {
    return c.json({ ok: false, service: 'zhipane-server', db: 'disconnected' }, 503);
  }
}

export async function diagnosticsHandler(c: Context) {
  const logLines: string[] = [];
  logLines.push(`ZhiPane Diagnostics ${new Date().toISOString()}`);
  logLines.push(`Node ${process.version} · PID ${process.pid} · Uptime ${Math.floor((Date.now() - startedAt) / 1000)}s`);
  logLines.push(`Platform ${process.platform} ${process.arch}`);
  logLines.push(`Memory RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
  const envKeys = ['NODE_ENV', 'AI_DRIVER', 'AI_COMPLETION_MODEL', 'AI_EMBEDDING_MODEL', 'EMBEDDING_DIMENSION', 'STORAGE_DRIVER', 'ALLOW_SIGNUP'];
  logLines.push('--- Environment ---');
  for (const key of envKeys) logLines.push(`${key}=${process.env[key] ?? '(default)'}`);
  try {
    await pool.query('select 1');
    logLines.push('--- Database ---');
    logLines.push('status=connected');
    const mig = await db.execute<{ filename: string }>(sql`SELECT filename FROM schema_migrations ORDER BY filename`);
    logLines.push(`migrations=${mig.rows.length}`);
    for (const m of mig.rows) logLines.push(`  ${m.filename}`);
  } catch (err) {
    logLines.push(`Database: disconnected (${err instanceof Error ? err.message : String(err)})`);
  }
  return c.text(logLines.join('\n'));
}

/**
 * Phase H (N2): durable ops metrics aggregated from the `jobs` table.
 *
 * Unlike the in-memory `/api/jobs/metrics` counters (which reset on restart
 * and are per-worker), this endpoint reads from PostgreSQL so numbers survive
 * restarts and are correct under multi-worker deployments. Returns queue
 * depth, totals, per-type breakdown, recent failures, AI token usage and a
 * 1-hour latency / success-rate slice.
 *
 * Unauthenticated by design: it leaks no PII, only operational aggregates.
 * In production front it with a network-level allow-list (or reverse proxy
 * auth) rather than a session cookie — ops dashboards should not need a
 * user session.
 */
export async function metricsHandler(c: Context) {
  try {
    const metrics = await getDbJobMetrics();
    return c.json({
      service: 'zhipane-server',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      ...metrics
    });
  } catch (err) {
    logger.error('metrics endpoint failed', { err: err instanceof Error ? err.message : String(err) });
    return c.json({ error: 'metrics unavailable' }, 503);
  }
}

// Retained for backward compatibility; prefer registering healthHandler directly.
export const healthRoutes = new Hono();
healthRoutes.get('/', healthHandler);
healthRoutes.get('/diagnostics', diagnosticsHandler);

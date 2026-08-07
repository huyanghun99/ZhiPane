import { createMiddleware } from 'hono/factory';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../env';
import { sha256 } from '../utils/crypto';
import type { AppEnv } from './auth';

/**
 * Per-user / per-space sliding window rate limit backed by the
 * `api_rate_limit_events` PostgreSQL table. MVP avoids Redis per
 * the design doc; this table is the source of truth.
 */
export function rateLimitMiddleware(routeKey: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');
    const body = c.req.method === 'POST' ? await c.req.raw.clone().json().catch(() => ({})) : {};
    const workspaceId = (body as { workspaceId?: string }).workspaceId ?? null;
    const spaceId = (body as { spaceId?: string }).spaceId ?? null;
    const ipHash = sha256(c.req.header('x-forwarded-for') ?? c.req.header('cf-connecting-ip') ?? 'local');
    const userId = user?.id ?? null;

    const userLimit = env.RAG_RATE_LIMIT_PER_USER_PER_MINUTE;
    const spaceLimit = env.RAG_RATE_LIMIT_PER_SPACE_PER_MINUTE;

    const counts = await db.execute<{ user_count: string; space_count: string }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE user_id = ${userId}) AS user_count,
        COUNT(*) FILTER (WHERE space_id = ${spaceId}) AS space_count
      FROM api_rate_limit_events
      WHERE route_key = ${routeKey}
        AND created_at > now() - interval '60 seconds'
    `);
    const row = counts.rows[0];
    if (Number(row?.user_count ?? 0) >= userLimit || Number(row?.space_count ?? 0) >= spaceLimit) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    await db.execute(sql`
      INSERT INTO api_rate_limit_events(workspace_id, space_id, user_id, route_key, ip_hash)
      VALUES (${workspaceId}, ${spaceId}, ${userId}, ${routeKey}, ${ipHash})
    `);
    await next();
  });
}

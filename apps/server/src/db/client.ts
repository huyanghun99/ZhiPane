import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@zhipane/db';
import { env } from '../env';

/**
 * The server vitest suite truncates tables in its setup hooks. Connecting it
 * to the development database once wiped real user data, so in test mode we
 * ALWAYS resolve a separate database:
 *   1. TEST_DATABASE_URL when explicitly configured (CI),
 *   2. otherwise a sibling `<dbname>_test` derived from DATABASE_URL.
 * There is no fallback to the dev database.
 */
function resolveDatabaseUrl(): string {
  if (env.NODE_ENV !== 'test') return env.DATABASE_URL;
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  try {
    const u = new URL(env.DATABASE_URL);
    const base = u.pathname.replace(/^\//, '') || 'zhipane';
    u.pathname = `/${base}_test`;
    return u.toString();
  } catch {
    throw new Error('NODE_ENV=test requires TEST_DATABASE_URL or a parseable DATABASE_URL');
  }
}

export const pool = new pg.Pool({ connectionString: resolveDatabaseUrl() });
export const db = drizzle(pool, { schema });

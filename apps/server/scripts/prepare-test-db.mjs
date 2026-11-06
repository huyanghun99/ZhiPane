/**
 * Prepare an isolated database for the server vitest suite.
 *
 * The suite truncates tables in setup hooks; running it against the dev
 * database once destroyed real user data. This script creates a sibling
 * `<dbname>_test` database (or TEST_DATABASE_URL) and applies all migrations
 * there, so `pnpm --filter @zhipane/server test` can never touch dev data.
 */
import pg from 'pg';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function envFileUrl() {
  for (const candidate of [join(here, '../../.env'), join(here, '../../../.env')]) {
    if (!existsSync(candidate)) continue;
    const line = readFileSync(candidate, 'utf8').split('\n').find((l) => /^DATABASE_URL\s*=/.test(l));
    if (line) return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const baseUrl = process.env.DATABASE_URL || envFileUrl();
if (!baseUrl) throw new Error('DATABASE_URL is required to prepare the test database');
const testUrl = process.env.TEST_DATABASE_URL || (() => {
  const u = new URL(baseUrl);
  u.pathname = `/${(u.pathname.slice(1) || 'zhipane')}_test`;
  return u.toString();
})();

const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';
const dbName = decodeURIComponent(new URL(testUrl).pathname.slice(1));

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${dbName}"`);
  console.log(`[test-db] created ${dbName}`);
} catch (err) {
  if (err?.code === '42P04' || err?.code === '42710') console.log(`[test-db] ${dbName} already exists`);
  else throw err;
}
await admin.end();

const client = new pg.Client({ connectionString: testUrl });
await client.connect();
await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
const done = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));
const dir = join(here, '../src/db/migrations');
let applied = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  const sql = readFileSync(join(dir, file), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
    applied++;
  } catch (e) {
    await client.query('ROLLBACK');
    throw new Error(`migration ${file} failed: ${e.message}`);
  }
}
await client.end();
console.log(`[test-db] ready: ${dbName} (${applied} new migrations)`);

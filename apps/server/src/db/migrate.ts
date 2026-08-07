import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './client';
import { logger } from '../services/logger';

const MIGRATIONS_DIR = join(process.cwd(), 'src/db/migrations');

/** Idempotently apply all pending SQL migrations in order, tracked by schema_migrations. */
export async function runMigrations(): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const done = new Set(rows.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        logger.info('applied migration', { file });
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return applied;
  } finally {
    client.release();
  }
}

async function main() {
  const applied = await runMigrations();
  logger.info('migrations complete', { count: applied.length, files: applied });
  await pool.end();
}

// Run when invoked directly, not when imported (e.g. by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (err) => {
    logger.error('migration failed', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    await pool.end();
    process.exit(1);
  });
}

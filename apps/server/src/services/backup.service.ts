import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/client';

const BACKUP_DIR = join(process.cwd(), 'data', 'backups');
const BACKUP_VERSION = 1;

/** Tables exported in a workspace backup, ordered to respect FK dependencies. */
const BACKUP_TABLES = [
  'workspaces',
  'spaces',
  'pages',
  'wiki_topics',
  'page_revisions',
  'document_chunks',
  'attachments'
] as const;

export interface BackupPayload {
  backupVersion: number;
  createdAt: string;
  appVersion: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export function backupFilePath(backupId: string): string {
  return join(BACKUP_DIR, `${backupId}.json`);
}

/** Dump workspace tables into a JSON-serializable payload. */
export async function createBackupDump(workspaceId: string): Promise<{ payload: BackupPayload; sizeBytes: number }> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of BACKUP_TABLES) {
    const rows = await db.execute(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE workspace_id = ${workspaceId}`
    );
    tables[table] = rows.rows as Record<string, unknown>[];
  }
  const payload: BackupPayload = {
    backupVersion: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: process.env.npm_package_version ?? '0.1.0',
    tables
  };
  const sizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  return { payload, sizeBytes };
}

/** Persist a backup payload to disk and return the storage key (file path). */
export function storeBackupPayload(backupId: string, payload: BackupPayload): string {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const filePath = backupFilePath(backupId);
  writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  return filePath;
}

/** Read and validate a backup payload from disk. */
export function readBackupPayload(storageKey: string): BackupPayload {
  if (!existsSync(storageKey)) throw new Error('Backup file not found');
  const payload = JSON.parse(readFileSync(storageKey, 'utf8')) as BackupPayload;
  if (payload.backupVersion !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${payload.backupVersion}`);
  }
  return payload;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** Restore workspace tables from a backup payload via upserts. */
export async function restoreBackup(storageKey: string): Promise<{ restored: Record<string, number> }> {
  const payload = readBackupPayload(storageKey);
  const restored: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of BACKUP_TABLES) {
      const rows = payload.tables[table] ?? [];
      restored[table] = rows.length;
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => IDENT_RE.test(c));
        if (cols.length === 0) continue;
        const values = cols.map((c) => row[c]);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const setClause = cols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
        await client.query(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${setClause}`,
          values
        );
      }
    }
    await client.query('COMMIT');
    return { restored };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

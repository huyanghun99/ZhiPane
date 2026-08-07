import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { createBackupSchema, restoreBackupSchema } from '@zhipane/shared';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { backups } from '@zhipane/db';
import { canManageWorkspace } from '../services/permission.service';
import {
  createBackupDump,
  storeBackupPayload,
  readBackupPayload,
  restoreBackup
} from '../services/backup.service';

export const backupRoutes = new Hono<AppEnv>();
backupRoutes.use('*', authMiddleware);

/** Trigger a manual backup (workspace admin only). */
backupRoutes.post('/', zValidator('json', createBackupSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  const workspaceId = c.req.query('workspaceId');
  if (!workspaceId) return c.json({ error: 'workspaceId is required' }, 400);
  if (!(await canManageWorkspace(user.id, workspaceId))) return c.json({ error: 'Forbidden' }, 403);

  const [backup] = await db.insert(backups).values({
    createdById: user.id,
    backupType: 'manual',
    status: 'running',
    includeSecrets: input.includeSecrets
  }).returning();

  try {
    const { payload, sizeBytes } = await createBackupDump(workspaceId);
    const storageKey = storeBackupPayload(backup.id, payload);
    const [updated] = await db.update(backups).set({
      status: 'succeeded',
      storageKey,
      sizeBytes,
      completedAt: sql`now()`
    }).where(eq(backups.id, backup.id)).returning();
    return c.json({ backup: updated, sizeBytes });
  } catch (err) {
    await db.update(backups).set({
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
      completedAt: sql`now()`
    }).where(eq(backups.id, backup.id));
    return c.json({ error: 'Backup failed', message: err instanceof Error ? err.message : String(err) }, 500);
  }
});

backupRoutes.get('/', async (c) => {
  const user = c.get('user');
  const rows = await db.execute(sql`SELECT * FROM backups WHERE created_by_id = ${user.id} ORDER BY created_at DESC LIMIT 50`);
  return c.json({ backups: rows.rows });
});

backupRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const [backup] = await db.select().from(backups).where(eq(backups.id, c.req.param('id'))).limit(1);
  if (!backup) return c.json({ error: 'Not found' }, 404);
  if (backup.createdById !== user.id) return c.json({ error: 'Forbidden' }, 403);
  return c.json({ backup });
});

/** Download the raw backup payload as JSON. */
backupRoutes.get('/:id/download', async (c) => {
  const user = c.get('user');
  const [backup] = await db.select().from(backups).where(eq(backups.id, c.req.param('id'))).limit(1);
  if (!backup) return c.json({ error: 'Not found' }, 404);
  if (backup.createdById !== user.id) return c.json({ error: 'Forbidden' }, 403);
  if (!backup.storageKey) return c.json({ error: 'Backup payload not stored' }, 409);
  try {
    const payload = readBackupPayload(backup.storageKey);
    return c.body(JSON.stringify(payload, null, 2), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="zhipane-backup-${backup.id}.json"`
    });
  } catch (err) {
    return c.json({ error: 'Backup file unavailable', message: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** Restore workspace tables from a stored backup (workspace admin only). */
backupRoutes.post('/restore', zValidator('json', restoreBackupSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  const [backup] = await db.select().from(backups).where(eq(backups.id, input.backupId)).limit(1);
  if (!backup) return c.json({ error: 'Not found' }, 404);
  if (backup.createdById !== user.id) return c.json({ error: 'Forbidden' }, 403);
  if (!backup.storageKey) return c.json({ error: 'Backup payload not stored' }, 409);
  if (!(await canManageWorkspace(user.id, c.req.query('workspaceId') ?? ''))) {
    return c.json({ error: 'Forbidden — workspace admin required' }, 403);
  }
  try {
    const { restored } = await restoreBackup(backup.storageKey);
    return c.json({ ok: true, backupId: backup.id, restored });
  } catch (err) {
    return c.json({ error: 'Restore failed', message: err instanceof Error ? err.message : String(err) }, 500);
  }
});

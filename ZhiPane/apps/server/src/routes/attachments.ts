import { Hono } from 'hono';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { env } from '../env';
import { db } from '../db/client';
import { attachments, pages } from '@zhipane/db';
import { canEditPage, canViewPage } from '../services/permission.service';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

// Allow-list of accepted MIME types. Anything else is rejected (no executable /
// html / svg uploads that could lead to stored XSS or RCE).
const ALLOWED_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/webm'
]);

export const attachmentRoutes = new Hono<AppEnv>();
attachmentRoutes.use('*', authMiddleware);

attachmentRoutes.post('/upload', async (c) => {
  const user = c.get('user');
  const form = await c.req.formData();
  const file = form.get('file');
  const pageId = String(form.get('pageId') ?? '');

  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  if (!pageId) return c.json({ error: 'pageId is required' }, 400);

  // Only trust pageId. Derive space + workspace from the page so a client
  // cannot attach a file to a workspace/space it does not control.
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page) return c.json({ error: 'Page not found' }, 404);
  if (!(await canEditPage(user.id, pageId))) return c.json({ error: 'Forbidden' }, 403);

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) return c.json({ error: 'empty file' }, 400);
  if (buffer.length > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large' }, 413);

  const mime = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME.has(mime)) return c.json({ error: 'unsupported file type' }, 415);

  // Sanitize the display name: strip path separators and non-printable /
  // control characters. This is for presentation only - the on-disk key is
  // generated below and never contains user input, so path traversal is
  // impossible regardless.
  const rawName = (file.name || 'upload').replace(/[/\\]/g, '_');
  const safeName = rawName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'upload';

  const ext = safeName.includes('.') ? '.' + safeName.split('.').pop()!.slice(0, 12) : '';
  const storageKey = join(page.workspaceId, page.spaceId, `${randomUUID()}${ext}`);
  const diskPath = join(env.UPLOAD_DIR, storageKey);
  await mkdir(join(env.UPLOAD_DIR, page.workspaceId, page.spaceId), { recursive: true });
  await writeFile(diskPath, buffer);

  const [row] = await db.insert(attachments).values({
    workspaceId: page.workspaceId,
    spaceId: page.spaceId,
    pageId,
    uploaderId: user.id,
    fileName: safeName,
    mimeType: mime,
    sizeBytes: buffer.length,
    storageDriver: 'local',
    storageKey
  }).returning();
  return c.json({ attachment: row }, 201);
});

attachmentRoutes.get('/', async (c) => {
  const user = c.get('user');
  const pageId = c.req.query('pageId');
  if (!pageId) return c.json({ error: 'pageId is required' }, 400);
  if (!(await canViewPage(user.id, pageId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.select().from(attachments).where(eq(attachments.pageId, pageId));
  return c.json({ attachments: rows });
});

attachmentRoutes.get('/:id/download', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (!row.pageId || !(await canViewPage(user.id, row.pageId))) return c.json({ error: 'Forbidden' }, 403);
  // storageKey is generated server-side (UUID), never user input -> safe join.
  const buffer = await readFile(join(env.UPLOAD_DIR, row.storageKey));
  const inlineable = /^image\//.test(row.mimeType) || row.mimeType === 'application/pdf';
  const disposition = inlineable ? 'inline' : 'attachment';
  return new Response(buffer, {
    headers: {
      'Content-Type': row.mimeType,
      'Content-Disposition': `${disposition}; filename="${encodeURIComponent(row.fileName)}"`
    }
  });
});

attachmentRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (!row.pageId || !(await canEditPage(user.id, row.pageId))) return c.json({ error: 'Forbidden' }, 403);
  await db.delete(attachments).where(eq(attachments.id, id));
  await unlink(join(env.UPLOAD_DIR, row.storageKey)).catch(() => {});
  return c.json({ ok: true });
});

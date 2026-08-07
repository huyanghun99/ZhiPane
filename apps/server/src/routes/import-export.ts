import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { importMarkdownSchema } from '@zhipane/shared';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { pages } from '@zhipane/db';
import { canViewPage, canViewSpace, canEditSpace } from '../services/permission.service';
import { enqueueJob } from '../services/job-runner';
import { tokenizeChineseFriendly } from '../utils/text';

export const importExportRoutes = new Hono<AppEnv>();
importExportRoutes.use('*', authMiddleware);

function docToMarkdown(title: string, contentJson: unknown, textContent: string): string {
  const lines: string[] = [`# ${title}`, ''];
  if (contentJson && typeof contentJson === 'object' && 'content' in (contentJson as Record<string, unknown>)) {
    const doc = contentJson as { content?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
    for (const block of doc.content ?? []) {
      if (block.type === 'heading') {
        lines.push(`## ${(block.content ?? []).map((n) => n.text ?? '').join('')}`, '');
      } else if (block.type === 'codeBlock') {
        lines.push('```', (block.content ?? []).map((n) => n.text ?? '').join(''), '```', '');
      } else {
        const text = (block.content ?? []).map((n) => n.text ?? '').join('');
        if (text) lines.push(text, '');
      }
    }
  } else if (textContent) {
    lines.push(textContent);
  }
  return lines.join('\n');
}

importExportRoutes.post('/export/page/:pageId', async (c) => {
  const user = c.get('user');
  const pageId = c.req.param('pageId');
  if (!(await canViewPage(user.id, pageId))) return c.json({ error: 'Forbidden' }, 403);
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page) return c.json({ error: 'Not found' }, 404);
  return c.json({ format: 'markdown', title: page.title, markdown: docToMarkdown(page.title, page.contentJson, page.textContent), pageId: page.id });
});

importExportRoutes.post('/export/space/:spaceId', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  if (!(await canViewSpace(user.id, spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const rows = await db.execute(sql`SELECT id, title, content_json, text_content FROM pages WHERE space_id = ${spaceId} AND status = 'normal' ORDER BY created_at ASC`);
  const sections: string[] = [];
  for (const row of rows.rows as Array<{ id: string; title: string; content_json: unknown; text_content: string }>) {
    sections.push(docToMarkdown(row.title, row.content_json, row.text_content));
    sections.push('---', '');
  }
  return c.json({ format: 'markdown', spaceId, markdown: sections.join('\n') });
});

importExportRoutes.post('/import/markdown', zValidator('json', importMarkdownSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  if (!(await canEditSpace(user.id, input.spaceId))) return c.json({ error: 'Forbidden' }, 403);
  const [page] = await db.insert(pages).values({
    workspaceId: input.workspaceId, spaceId: input.spaceId, title: input.title,
    contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: input.content }] }] },
    textContent: input.content, ftsTokens: tokenizeChineseFriendly(`${input.title}\n${input.content}`),
    createdById: user.id, updatedById: user.id, llmDirtyReason: 'import'
  }).returning();
  await enqueueJob({ workspaceId: page.workspaceId, spaceId: page.spaceId, entityType: 'page', entityId: page.id, type: 'page.process_llm', runAfterSeconds: 30 });
  return c.json({ page }, 201);
});

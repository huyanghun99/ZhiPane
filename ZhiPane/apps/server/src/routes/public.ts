import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { pages, wikiTopics } from '@zhipane/db';

export const publicRoutes = new Hono();

publicRoutes.get('/shares/:shareToken', async (c) => {
  const token = c.req.param('shareToken');
  const result = await db.execute(sql`SELECT * FROM shares WHERE share_token = ${token} AND is_enabled = TRUE LIMIT 1`);
  const share = result.rows[0] as Record<string, unknown> | undefined;
  if (!share) return c.json({ error: 'Not found' }, 404);
  if (share.share_mode === 'snapshot') {
    return c.json({ share: { targetType: share.target_type, shareMode: share.share_mode, title: share.snapshot_title, contentJson: share.snapshot_content_json, textContent: share.snapshot_text_content } });
  }
  const targetType = share.target_type as string;
  const targetId = share.target_id as string;
  if (targetType === 'page') {
    const [page] = await db.select().from(pages).where(eq(pages.id, targetId)).limit(1);
    if (!page || page.status === 'deleted') return c.json({ error: 'Not found' }, 404);
    return c.json({ share: { targetType: 'page', shareMode: 'live', title: page.title, contentJson: page.contentJson, textContent: page.textContent } });
  }
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, targetId)).limit(1);
  if (!topic) return c.json({ error: 'Not found' }, 404);
  return c.json({ share: { targetType: 'topic', shareMode: 'live', title: topic.title, contentJson: topic.contentJson, textContent: topic.textContent } });
});

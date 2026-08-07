import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { navGroups, navLinks, navSearchEngines, workspaceMembers, workspaces } from '@zhipane/db';

export const navRoutes = new Hono<AppEnv>();
navRoutes.use('*', authMiddleware);

/** Resolve the caller's primary workspace (personal workbench scope). */
async function getUserWorkspaceId(userId: string): Promise<string> {
  const [wm] = await db
    .select({ workspaceId: workspaces.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaces.createdAt)
    .limit(1);
  if (!wm) throw new Error('No workspace found for user');
  return wm.workspaceId;
}

const DEFAULT_ENGINE = { name: 'Bing', urlTemplate: 'https://cn.bing.com/search?q=%s' };

// ---------------------------------------------------------------- read
navRoutes.get('/', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const [groups, links] = await Promise.all([
    db.select().from(navGroups).where(eq(navGroups.workspaceId, workspaceId)).orderBy(asc(navGroups.position), asc(navGroups.title)),
    db
      .select({ link: navLinks, groupId: navLinks.groupId })
      .from(navLinks)
      .innerJoin(navGroups, eq(navGroups.id, navLinks.groupId))
      .where(eq(navGroups.workspaceId, workspaceId))
      .orderBy(asc(navLinks.position))
  ]);
  const byGroup = new Map<string, typeof links>();
  for (const row of links) {
    if (!byGroup.has(row.groupId)) byGroup.set(row.groupId, []);
    byGroup.get(row.groupId)!.push(row);
  }
  const result = groups.map((g) => ({
    ...g,
    links: (byGroup.get(g.id) ?? []).map((r) => r.link)
  }));
  return c.json({ groups: result });
});

// ---------------------------------------------------------------- groups
const groupInput = z.object({ title: z.string().min(1).max(120), position: z.number().int().optional() });

navRoutes.post('/groups', zValidator('json', groupInput), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const body = c.req.valid('json');
  const [row] = await db
    .insert(navGroups)
    .values({ workspaceId, title: body.title, position: body.position ?? 0 })
    .returning();
  return c.json({ group: row }, 201);
});

navRoutes.patch('/groups/:id', zValidator('json', groupInput.partial()), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(navGroups)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(navGroups.id, id), eq(navGroups.workspaceId, workspaceId)))
    .returning();
  if (!row) return c.json({ error: 'group not found' }, 404);
  return c.json({ group: row });
});

navRoutes.delete('/groups/:id', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const id = c.req.param('id');
  const [row] = await db
    .delete(navGroups)
    .where(and(eq(navGroups.id, id), eq(navGroups.workspaceId, workspaceId)))
    .returning();
  if (!row) return c.json({ error: 'group not found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- links
const linkInput = z.object({
  name: z.string().min(1).max(200),
  url: z.string().min(1).max(2000),
  iconChar: z.string().max(4).optional().nullable(),
  position: z.number().int().optional()
});

navRoutes.post('/groups/:id/links', zValidator('json', linkInput), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const groupId = c.req.param('id');
  const body = c.req.valid('json');
  const [group] = await db.select().from(navGroups).where(and(eq(navGroups.id, groupId), eq(navGroups.workspaceId, workspaceId))).limit(1);
  if (!group) return c.json({ error: 'group not found' }, 404);
  const [row] = await db
    .insert(navLinks)
    .values({
      groupId,
      name: body.name,
      url: body.url,
      iconChar: body.iconChar ?? null,
      position: body.position ?? 0
    })
    .returning();
  return c.json({ link: row }, 201);
});

navRoutes.patch('/links/:id', zValidator('json', linkInput.partial()), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(navLinks)
    .set({ ...body, iconChar: body.iconChar === undefined ? undefined : body.iconChar ?? null, updatedAt: new Date() })
    .where(eq(navLinks.id, id))
    .returning();
  if (!row) return c.json({ error: 'link not found' }, 404);
  return c.json({ link: row });
});

navRoutes.delete('/links/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .delete(navLinks)
    .where(eq(navLinks.id, id))
    .returning();
  if (!row) return c.json({ error: 'link not found' }, 404);
  return c.json({ ok: true });
});

// Record a click (open count + last opened).
navRoutes.post('/links/:id/open', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .update(navLinks)
    .set({ openCount: sql`${navLinks.openCount} + 1`, lastOpenedAt: new Date() })
    .where(eq(navLinks.id, id))
    .returning();
  if (!row) return c.json({ error: 'link not found' }, 404);
  return c.json({ link: row });
});

// ---------------------------------------------------------------- reorder (drag & drop persistence)
const reorderSchema = z.object({
  groups: z.array(z.object({ id: z.string().uuid(), position: z.number().int() })).optional(),
  links: z.array(z.object({ id: z.string().uuid(), groupId: z.string().uuid(), position: z.number().int() })).optional()
});

navRoutes.post('/reorder', zValidator('json', reorderSchema), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const body = c.req.valid('json');
  await db.transaction(async (tx) => {
    if (body.groups) {
      for (const g of body.groups) {
        await tx.update(navGroups).set({ position: g.position, updatedAt: new Date() })
          .where(and(eq(navGroups.id, g.id), eq(navGroups.workspaceId, workspaceId)));
      }
    }
    if (body.links) {
      for (const l of body.links) {
        await tx.update(navLinks).set({ position: l.position, groupId: l.groupId, updatedAt: new Date() })
          .where(eq(navLinks.id, l.id));
      }
    }
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- search engine
navRoutes.get('/search-engine', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const rows = await db.select().from(navSearchEngines).where(eq(navSearchEngines.workspaceId, workspaceId)).orderBy(asc(navSearchEngines.isDefault));
  if (rows.length === 0) {
    const [created] = await db.insert(navSearchEngines).values({ workspaceId, ...DEFAULT_ENGINE, isDefault: true }).returning();
    return c.json({ engines: [created] });
  }
  return c.json({ engines: rows });
});

const engineInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(60),
  urlTemplate: z.string().min(1).max(500),
  isDefault: z.boolean().optional()
});

navRoutes.put('/search-engine', zValidator('json', engineInput), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const body = c.req.valid('json');
  if (!/^https?:\/\//.test(body.urlTemplate) || !body.urlTemplate.includes('%s')) {
    return c.json({ error: 'urlTemplate must be an http(s) URL containing %s' }, 400);
  }
  let row;
  if (body.id) {
    [row] = await db
      .update(navSearchEngines)
      .set({ name: body.name, urlTemplate: body.urlTemplate, isDefault: body.isDefault ?? false })
      .where(and(eq(navSearchEngines.id, body.id), eq(navSearchEngines.workspaceId, workspaceId)))
      .returning();
  } else {
    [row] = await db
      .insert(navSearchEngines)
      .values({ workspaceId, name: body.name, urlTemplate: body.urlTemplate, isDefault: body.isDefault ?? false })
      .returning();
  }
  if (body.isDefault) {
    await db.update(navSearchEngines).set({ isDefault: false })
      .where(and(eq(navSearchEngines.workspaceId, workspaceId), sql`${navSearchEngines.id} <> ${row.id}`));
    row = { ...row, isDefault: true };
  }
  return c.json({ engine: row });
});

// ---------------------------------------------------------------- export / import
navRoutes.get('/export', async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const groups = await db.select().from(navGroups).where(eq(navGroups.workspaceId, workspaceId)).orderBy(asc(navGroups.position));
  const links = await db.select().from(navLinks).innerJoin(navGroups, eq(navGroups.id, navLinks.groupId))
    .where(eq(navGroups.workspaceId, workspaceId)).orderBy(asc(navLinks.position));
  const data = groups.map((g) => ({
    id: g.id,
    title: g.title,
    links: links.filter((l) => l.nav_links.groupId === g.id).map((l) => ({
      id: l.nav_links.id, name: l.nav_links.name, url: l.nav_links.url, iconChar: l.nav_links.iconChar
    }))
  }));
  return c.json({ groups: data });
});

const importSchema = z.object({
  groups: z.array(z.object({
    title: z.string().min(1),
    links: z.array(z.object({ name: z.string().min(1), url: z.string().min(1), iconChar: z.string().optional() }))
  }))
});

navRoutes.post('/import', zValidator('json', importSchema), async (c) => {
  const user = c.get('user');
  const workspaceId = await getUserWorkspaceId(user.id);
  const body = c.req.valid('json');
  const created = [];
  await db.transaction(async (tx) => {
    for (let gi = 0; gi < body.groups.length; gi++) {
      const g = body.groups[gi];
      const [group] = await tx.insert(navGroups).values({ workspaceId, title: g.title, position: gi }).returning();
      for (let li = 0; li < g.links.length; li++) {
        const l = g.links[li];
        const [link] = await tx.insert(navLinks).values({
          groupId: group.id, name: l.name, url: l.url, iconChar: l.iconChar ?? null, position: li
        }).returning();
        created.push(link);
      }
    }
  });
  return c.json({ imported: created.length }, 201);
});

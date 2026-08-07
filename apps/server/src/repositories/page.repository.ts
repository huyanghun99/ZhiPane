import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { pageRevisions, pages, spaces } from '@zhipane/db';

/**
 * Repository layer for pages.
 *
 * Per AGENTS.md the backend is split into route -> service -> repository.
 * This module owns ALL direct database access for the `pages` entity.
 * Routes never write SQL for pages; services call these functions.
 *
 * IMPORTANT: list / tree queries intentionally select a *lightweight* column
 * subset that EXCLUDES `content_json` and `text_content`. Full page bodies
 * are only returned by `getPageDetail` (the Page Detail API). This keeps the
 * page tree and sidebar cheap even with 10k+ nodes.
 */

type Executor = any;

export interface LightPageRow {
  id: string;
  workspaceId: string;
  spaceId: string;
  parentPageId: string | null;
  position: number;
  title: string;
  icon: string | null;
  status: string;
  llmProcessStatus: string;
  createdAt: string;
  updatedAt: string;
  hasChildren: boolean;
}

const LIGHT_COLUMNS = {
  id: pages.id,
  workspaceId: pages.workspaceId,
  spaceId: pages.spaceId,
  parentPageId: pages.parentPageId,
  position: pages.position,
  title: pages.title,
  icon: pages.icon,
  status: pages.status,
  llmProcessStatus: pages.llmProcessStatus,
  createdAt: pages.createdAt,
  updatedAt: pages.updatedAt
} as const;

export async function getSpaceById(spaceId: string, exec: Executor = db) {
  const [sp] = await exec.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  return sp ?? null;
}

export async function getPageById(id: string, exec: Executor = db) {
  const [p] = await exec.select().from(pages).where(eq(pages.id, id)).limit(1);
  return p ?? null;
}

export async function getPageDetail(id: string, exec: Executor = db) {
  const [p] = await exec.select().from(pages).where(eq(pages.id, id)).limit(1);
  return p ?? null;
}

/** Lightweight list (NO contentJson / textContent) for a space, with `hasChildren`. */
export async function listPagesLight(spaceId: string, exec: Executor = db): Promise<LightPageRow[]> {
  const rows = await exec
    .select(LIGHT_COLUMNS)
    .from(pages)
    .where(and(eq(pages.spaceId, spaceId), eq(pages.status, 'normal')))
    .orderBy(pages.position, pages.updatedAt);
  if (rows.length === 0) return rows;
  const parents = new Set<string>();
  for (const r of rows) if (r.parentPageId) parents.add(r.parentPageId);
  return rows.map((r: LightPageRow) => ({ ...r, hasChildren: parents.has(r.id) }));
}

export async function insertPage(
  values: any,
  exec: Executor = db
): Promise<any> {
  const [p] = await exec.insert(pages).values(values).returning();
  return p;
}

export async function updatePageCAS(
  id: string,
  contentVersion: number,
  set: any,
  exec: Executor = db
) {
  const [u] = await exec
    .update(pages)
    .set(set)
    .where(and(eq(pages.id, id), eq(pages.contentVersion, contentVersion)))
    .returning();
  return u ?? null;
}

export async function insertRevision(values: any, exec: Executor = db) {
  await exec.insert(pageRevisions).values(values);
}

export async function setLlmStatus(id: string, status: string, exec: Executor = db) {
  await exec.update(pages).set({ llmProcessStatus: status, updatedAt: sql`now()` }).where(eq(pages.id, id));
}

export async function softDelete(id: string, exec: Executor = db) {
  await exec.update(pages).set({ status: 'deleted', updatedAt: sql`now()` }).where(eq(pages.id, id));
}

export async function listRevisions(pageId: string, exec: Executor = db) {
  return exec
    .select()
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, pageId))
    .orderBy(desc(pageRevisions.contentVersion));
}

export async function getRevisionById(id: string, exec: Executor = db) {
  const [r] = await exec.select().from(pageRevisions).where(eq(pageRevisions.id, id)).limit(1);
  return r ?? null;
}

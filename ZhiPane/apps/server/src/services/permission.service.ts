import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { pages, spaces, spaceMembers, workspaceMembers } from '@zhipane/db';

export async function canManageWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const rows = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.userId, userId),
    eq(workspaceMembers.workspaceId, workspaceId),
    or(eq(workspaceMembers.role, 'owner'), eq(workspaceMembers.role, 'admin'))
  )).limit(1);
  return rows.length > 0;
}

export async function canViewWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const rows = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.userId, userId),
    eq(workspaceMembers.workspaceId, workspaceId)
  )).limit(1);
  return rows.length > 0;
}

export async function canViewSpace(userId: string, spaceId: string): Promise<boolean> {
  const rows = await db.select().from(spaceMembers).where(and(
    eq(spaceMembers.spaceId, spaceId),
    eq(spaceMembers.userId, userId)
  )).limit(1);
  return rows.length > 0;
}

export async function canManageSpace(userId: string, spaceId: string): Promise<boolean> {
  const rows = await db.select().from(spaceMembers).where(and(
    eq(spaceMembers.spaceId, spaceId),
    eq(spaceMembers.userId, userId),
    eq(spaceMembers.role, 'admin')
  )).limit(1);
  return rows.length > 0;
}

export async function canEditSpace(userId: string, spaceId: string): Promise<boolean> {
  const rows = await db.select().from(spaceMembers).where(and(
    eq(spaceMembers.spaceId, spaceId),
    eq(spaceMembers.userId, userId),
    or(eq(spaceMembers.role, 'admin'), eq(spaceMembers.role, 'writer'))
  )).limit(1);
  return rows.length > 0;
}

export async function canViewPage(userId: string, pageId: string): Promise<boolean> {
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page) return false;
  return canViewSpace(userId, page.spaceId);
}

export async function canEditPage(userId: string, pageId: string): Promise<boolean> {
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page) return false;
  return canEditSpace(userId, page.spaceId);
}

// Phase J (S10): short-TTL cache for getReadableSpaceIds. This function is
// called on every search and page-list request; without caching each call
// costs one SQL round-trip. A 60s TTL keeps results fresh enough for normal
// use (a member change is visible within 60s) while cutting DB load under
// burst traffic. For multi-worker deployments, swap this for a shared cache.
const READABLE_SPACES_TTL_MS = 60 * 1000;
interface CachedSpaces { ids: string[]; ts: number; }
const readableSpacesCache = new Map<string, CachedSpaces>();

export async function getReadableSpaceIds(userId: string, workspaceId: string): Promise<string[]> {
  const key = `${userId}|${workspaceId}`;
  const hit = readableSpacesCache.get(key);
  if (hit && Date.now() - hit.ts < READABLE_SPACES_TTL_MS) return hit.ids;
  const rows = await db.execute<{ space_id: string }>(sql`
    SELECT sm.space_id
    FROM space_members sm
    JOIN spaces s ON s.id = sm.space_id
    WHERE sm.user_id = ${userId} AND s.workspace_id = ${workspaceId}
  `);
  const ids = rows.rows.map((r) => r.space_id);
  readableSpacesCache.set(key, { ids, ts: Date.now() });
  return ids;
}

/** Invalidate cached space memberships for a user (call after member changes). */
export function invalidateReadableSpacesCache(userId?: string, workspaceId?: string): void {
  if (!userId) { readableSpacesCache.clear(); return; }
  const prefix = workspaceId ? `${userId}|${workspaceId}` : `${userId}|`;
  for (const key of readableSpacesCache.keys()) {
    if (key.startsWith(prefix)) readableSpacesCache.delete(key);
  }
}

export async function getSpaceWorkspaceId(spaceId: string): Promise<string | null> {
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  return space?.workspaceId ?? null;
}

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { pages } from '@zhipane/db';
import { extractTextFromProseMirrorJson, tokenizeChineseFriendly } from '../utils/text';
import { enqueueJob } from './job-runner';
import { getSpacePolicy } from './ai.service';
import * as repo from '../repositories/page.repository';

export type { LightPageRow } from '../repositories/page.repository';
export { listPagesLight } from '../repositories/page.repository';

export interface PageTreeNode {
  id: string;
  workspaceId: string;
  spaceId: string;
  parentPageId: string | null;
  position: number;
  title: string;
  status: string;
  llmProcessStatus: string;
  createdAt: string;
  updatedAt: string;
  hasChildren: boolean;
  children: PageTreeNode[];
}

export interface CreatePageInput {
  spaceId: string;
  parentPageId?: string | null;
  title: string;
  icon?: string | null;
  contentJson?: unknown;
  textContent?: string;
}

export type UpdateResult =
  | { ok: true; page: Record<string, unknown> }
  | { ok: false; reason: 'forbidden' | 'notfound' | 'conflict' };

class CASConflict extends Error {}

export async function getSpaceOrNull(spaceId: string) {
  return repo.getSpaceById(spaceId);
}

export async function getParentPageOrNull(id: string) {
  return repo.getPageById(id);
}

export async function createPage(
  user: { id: string },
  input: CreatePageInput
): Promise<{ page: Record<string, unknown> }> {
  const space = await repo.getSpaceById(input.spaceId);
  if (!space) throw new Error('Space not found');

  // parentPageId, if provided, must belong to the SAME space.
  if (input.parentPageId) {
    const parent = await repo.getPageById(input.parentPageId);
    if (!parent || parent.spaceId !== space.id) {
      throw new Error('parentPageId does not belong to this space');
    }
  }

  const contentJson = input.contentJson ?? { type: 'doc', content: [] };
  const textContent = input.textContent || extractTextFromProseMirrorJson(contentJson as object);
  const page = await repo.insertPage({
    workspaceId: space.workspaceId,
    spaceId: space.id,
    parentPageId: input.parentPageId ?? null,
    title: input.title,
    icon: input.icon ?? null,
    contentJson,
    textContent,
    ftsTokens: tokenizeChineseFriendly(`${input.title}\n${textContent}`),
    createdById: user.id,
    updatedById: user.id,
    llmProcessStatus: 'pending',
    llmDirtyReason: 'page_created'
  });

  const policy = await getSpacePolicy(space.id);
  if (policy !== 'disabled') {
    await enqueueJob({
      workspaceId: page.workspaceId,
      spaceId: page.spaceId,
      entityType: 'page',
      entityId: page.id,
      type: 'page.process_llm',
      runAfterSeconds: 30
    });
  } else {
    await repo.setLlmStatus(page.id, 'ignored');
  }

  return { page };
}

export async function updatePage(
  user: { id: string },
  pageId: string,
  input: {
    title?: string;
    contentJson?: unknown;
    textContent?: string;
    contentVersion?: number;
    autosave?: boolean;
    parentPageId?: string | null;
    position?: number;
    icon?: string | null;
  }
): Promise<UpdateResult> {
  const current = await repo.getPageDetail(pageId);
  if (!current) return { ok: false, reason: 'notfound' };

  // --- Icon-only edit -----------------------------------------------------
  // Changing a page icon must NOT bump contentVersion / reset the LLM state /
  // touch updatedAt: the page tree is ordered by (position, updatedAt), so a
  // full content update would reorder the tree and make the note "jump" in the
  // sidebar. Persist just the icon column and leave every other field alone.
  const iconOnly =
    input.icon !== undefined &&
    input.title === undefined &&
    input.contentJson === undefined &&
    input.textContent === undefined &&
    input.contentVersion === undefined &&
    input.parentPageId === undefined &&
    input.position === undefined;
  if (iconOnly) {
    const [updated] = await db
      .update(pages)
      .set({ icon: input.icon })
      .where(eq(pages.id, pageId))
      .returning();
    if (!updated) return { ok: false, reason: 'notfound' };
    return { ok: true, page: { ...current, icon: updated.icon } };
  }

  // --- Move / reorder (Phase 6) -------------------------------------------
  // Lightweight: never bumps contentVersion and never re-enqueues an LLM job,
  // so dragging a page around the tree is instant and side-effect free.
  const wantsMove = input.parentPageId !== undefined || input.position !== undefined;
  if (wantsMove) {
    const newParent = input.parentPageId !== undefined ? input.parentPageId : current.parentPageId;
    await db
      .update(pages)
      .set({ parentPageId: newParent, updatedAt: sql`now()` })
      .where(eq(pages.id, pageId));
    if (input.position !== undefined) {
      // Make room: shift every sibling at/after the target slot up by one.
      await db
        .update(pages)
        .set({ position: sql`${pages.position} + 1` })
        .where(
          and(
            eq(pages.spaceId, current.spaceId),
            sql`parent_page_id IS NOT DISTINCT FROM ${newParent}`,
            eq(pages.status, 'normal'),
            sql`position >= ${input.position}`,
            sql`id != ${pageId}`
          )
        );
      await db.update(pages).set({ position: input.position }).where(eq(pages.id, pageId));
    }
    const updated = await repo.getPageDetail(pageId);
    return { ok: true, page: updated };
  }

  const policy = await getSpacePolicy(current.spaceId);
  const nextContentJson = input.contentJson ?? current.contentJson;
  const nextText = input.textContent ?? extractTextFromProseMirrorJson(nextContentJson as object);
  const nextVersion = current.contentVersion + 1;

  try {
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(pages)
        .set({
          title: input.title ?? current.title,
          icon: input.icon !== undefined ? input.icon : current.icon,
          contentJson: nextContentJson,
          textContent: nextText,
          ftsTokens: tokenizeChineseFriendly(`${input.title ?? current.title}\n${nextText}`),
          contentVersion: nextVersion,
          llmProcessStatus: policy === 'disabled' ? 'ignored' : 'pending',
          llmDirtyReason: 'page_updated',
          updatedById: user.id,
          updatedAt: sql`now()`
        })
        .where(and(eq(pages.id, pageId), eq(pages.contentVersion, input.contentVersion ?? current.contentVersion)))
        .returning();
      if (!u) throw new CASConflict();

      if (!input.autosave) {
        await repo.insertRevision(
          {
            pageId: current.id,
            contentVersion: current.contentVersion,
            title: current.title,
            contentJson: current.contentJson,
            textContent: current.textContent,
            createdById: user.id
          },
          tx
        );
      }

      if (policy !== 'disabled') {
        await enqueueJob(
          {
            workspaceId: current.workspaceId,
            spaceId: current.spaceId,
            entityType: 'page',
            entityId: current.id,
            type: 'page.process_llm',
            runAfterSeconds: 45,
            sourceVersion: nextVersion
          },
          tx
        );
      }

      return u;
    });
    return { ok: true, page: updated };
  } catch (err) {
    if (err instanceof CASConflict) return { ok: false, reason: 'conflict' };
    throw err;
  }
}

export async function getPageTree(spaceId: string): Promise<PageTreeNode[]> {
  const flat = await repo.listPagesLight(spaceId);
  const byParent = new Map<string, PageTreeNode[]>();
  for (const p of flat) {
    const node = { ...p, children: [] } as PageTreeNode;
    const key = p.parentPageId ?? 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(node);
  }
  // Sibling order must be stable: `updatedAt` changes on every edit (title,
  // content, icon...), so using it as a tiebreaker made notes jump around in
  // the tree after any change. Only an explicit drag (position) may reorder.
  const stable = (a: PageTreeNode, b: PageTreeNode) =>
    a.position - b.position ||
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) ||
    a.id.localeCompare(b.id);
  const build = (parentId: string): PageTreeNode[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort(stable)
      .map((n) => ({ ...n, children: build(n.id) }));
  return build('root');
}

export async function getPageDetail(pageId: string) {
  return repo.getPageDetail(pageId);
}

export async function deletePage(pageId: string): Promise<void> {
  await repo.softDelete(pageId);
}

export async function listRevisions(pageId: string) {
  return repo.listRevisions(pageId);
}

export async function restoreRevision(
  user: { id: string },
  pageId: string,
  revisionId: string
): Promise<{ page: Record<string, unknown> } | { ok: false; reason: string }> {
  const rev = await repo.getRevisionById(revisionId);
  if (!rev || rev.pageId !== pageId) return { ok: false, reason: 'notfound' };
  const current = await repo.getPageDetail(pageId);
  if (!current) return { ok: false, reason: 'notfound' };

  await repo.insertRevision({
    pageId: current.id,
    contentVersion: current.contentVersion,
    title: current.title,
    contentJson: current.contentJson,
    textContent: current.textContent,
    createdById: user.id
  });
  await db
    .update(pages)
    .set({
      title: rev.title,
      contentJson: rev.contentJson,
      textContent: rev.textContent,
      ftsTokens: tokenizeChineseFriendly(`${rev.title}\n${rev.textContent}`),
      contentVersion: current.contentVersion + 1,
      llmProcessStatus: 'pending',
      llmDirtyReason: 'revision_restored',
      updatedById: user.id,
      updatedAt: sql`now()`
    })
    .where(eq(pages.id, pageId));
  await enqueueJob({
    workspaceId: current.workspaceId,
    spaceId: current.spaceId,
    entityType: 'page',
    entityId: current.id,
    type: 'page.process_llm',
    runAfterSeconds: 30
  });
  return { page: current };
}

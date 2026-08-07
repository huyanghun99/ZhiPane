import { beforeEach, describe, expect, it, vi } from 'vitest';

// Force generateWikiArtifacts to throw so we can verify the failure is
// persisted on the page (Phase 0 task 6) and does not masquerade as success.
vi.mock('../services/wiki.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/wiki.service')>();
  return { ...actual, generateWikiArtifacts: vi.fn().mockRejectedValue(new Error('wiki boom')) };
});

import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb } from './test-utils';
import { pages } from '@zhipane/db';
import { enqueueJob, runOneJob } from '../services/job-runner';

describe('Phase 0 — wiki generation failure persistence', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  it('persists the wiki error on the page and still completes indexing', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const sp = await makeSpace(ws, user);
    const [page] = await db.insert(pages).values({
      workspaceId: ws.id, spaceId: sp.id, title: 'Note',
      contentJson: { type: 'doc', content: [] }, textContent: 'some content', status: 'normal',
      llmProcessStatus: 'pending', createdById: user.id, updatedById: user.id
    }).returning();

    await enqueueJob({
      workspaceId: ws.id, spaceId: sp.id, entityType: 'page', entityId: page.id,
      type: 'page.process_llm', runAfterSeconds: 0
    });
    const ran = await runOneJob();
    expect(ran).toBe(true);

    const [p] = await db.select().from(pages).where(sql`id = ${page.id}`).limit(1);
    // Indexing (chunks/embeddings) still completes.
    expect(p?.llmProcessStatus).toBe('processed');
    // The wiki failure is persisted, not swallowed.
    expect(p?.wikiErrorMessage).toBeTruthy();
    expect(p?.wikiErrorMessage).toContain('wiki boom');
  });
});

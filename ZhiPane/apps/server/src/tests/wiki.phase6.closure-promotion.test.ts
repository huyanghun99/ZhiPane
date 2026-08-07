import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { MockAiProvider } from '@zhipane/ai';
import { db, sql, makeUser, makeWorkspace, makeSpace, cleanDb, sessionCookie } from './test-utils';
import { createApp } from '../app';
import { wikiTopics, spaces, topicSources, topicOperations, pages, documentChunks } from '@zhipane/db';
import { generateClosurePackage, deriveTopicToSpace } from '../services/closure.service';
import { undoTopicOperation } from '../services/wiki.service';
import { closurePackageSchema } from '@zhipane/shared';

vi.mock('../services/ai.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createAiProviderForContext: vi.fn(async () => new MockAiProvider()) };
});

const SYNC = 'topic-synthesis-v1' as const;

async function makePage(sp: { id: string; workspaceId: string }, user: { id: string }, title: string) {
  const [p] = await db
    .insert(pages)
    .values({
      workspaceId: sp.workspaceId,
      spaceId: sp.id,
      title,
      contentJson: { type: 'doc', content: [] },
      textContent: `${title} body`,
      status: 'normal',
      llmProcessStatus: 'ignored',
      createdById: user.id,
      updatedById: user.id
    })
    .returning();
  return p;
}

// Create a Topic whose keyPoint cites a REAL chunk (chunkId exists in
// document_chunks). Optionally back it with N distinct source pages so it
// qualifies as reusable knowledge.
async function makeCitedTopic(
  sp: { id: string; workspaceId: string },
  user: { id: string },
  opts: { title: string; kp: string; content: string; pages?: number; openQuestion?: string; decisions?: { decision: string; rationale: string }[] }
) {
  const pageCount = opts.pages ?? 1;
  const pageIds: string[] = [];
  for (let i = 0; i < pageCount; i++) pageIds.push((await makePage(sp, user, `${opts.title}-page-${i}`)).id);

  const chunkIds: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    const [chunk] = await db
      .execute<any>(sql`
        INSERT INTO document_chunks(workspace_id, space_id, page_id, chunk_index, title, content, fts_tokens)
        VALUES (${sp.workspaceId}, ${sp.id}, ${pageIds[i]}::uuid, ${i}, ${opts.title}, ${opts.content}, '')
        RETURNING id
      `)
      .then((r) => [r.rows[0]]);
    chunkIds.push(chunk.id);
  }

  const synth = {
    schemaVersion: SYNC,
    definition: opts.title,
    overview: `${opts.title} overview`,
    keyPoints: [
      { id: 'kp-1', title: opts.kp, content: opts.content, citations: [{ chunkId: chunkIds[0], pageId: pageIds[0], excerpt: opts.content.slice(0, 40) }] }
    ],
    subtopics: [],
    conflicts: [],
    decisions: opts.decisions ?? [],
    openQuestions: opts.openQuestion ? [opts.openQuestion] : [],
    relatedTopicIds: [],
    generatedFromContentVersions: []
  };
  const [t] = await db
    .insert(wikiTopics)
    .values({
      workspaceId: sp.workspaceId,
      spaceId: sp.id,
      title: opts.title,
      contentJson: synth,
      textContent: opts.content,
      status: 'accepted',
      source: 'ai_generated',
      publicationStatus: 'accepted',
      freshnessStatus: 'fresh',
      lifecycleStatus: 'active',
      createdById: user.id
    })
    .returning();
  for (let i = 0; i < pageCount; i++) {
    await db.insert(topicSources).values({ topicId: t.id, pageId: pageIds[i], chunkId: chunkIds[i], addedBy: 'ai', contributionType: 'key_point' }).onConflictDoNothing();
  }
  return { topic: t, chunkIds, pageIds };
}

describe('Phase 6 — project closure & promotion', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  /* ---- Gate 1: 结论都有 citation (every conclusion cites a real chunk) ---- */
  it('closure package conclusions all carry real chunk citations', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const project = await makeSpace(ws, user, 'proj', 'cloud_allowed');
    await db.update(spaces).set({ spaceKind: 'project', lifecycleStatus: 'completed' }).where(sql`id = ${project.id}`);

    await makeCitedTopic(project, user, { title: 'DecisionTopic', kp: 'Alpha', content: 'We chose approach A because of cost.', decisions: [{ decision: 'Use approach A', rationale: 'Lower cost' }] });
    await makeCitedTopic(project, user, { title: 'ReusableTopic', kp: 'Beta', content: 'Reusable insight spanning pages.', pages: 2 });

    const pkg = await generateClosurePackage(project.id);
    expect(closurePackageSchema.safeParse(pkg).success).toBe(true);

    // Every cited chunkId must exist in document_chunks.
    const allCited: string[] = [];
    for (const d of pkg.keyDecisions) for (const c of d.citations as { chunkId: string }[]) allCited.push(c.chunkId);
    for (const l of pkg.lessons) for (const c of l.citations as { chunkId: string }[]) allCited.push(c.chunkId);
    for (const r of pkg.reusableKnowledgeCandidates) for (const c of r.citations as { chunkId: string }[]) allCited.push(c.chunkId);
    for (const c of pkg.goalsAndResults.citations as { chunkId: string }[]) allCited.push(c.chunkId);

    expect(allCited.length).toBeGreaterThan(0);
    const realRows = await db.select({ id: documentChunks.id }).from(documentChunks).where(inArray(documentChunks.id, allCited));
    const realIds = new Set(realRows.map((r: { id: string }) => r.id));
    for (const id of allCited) expect(realIds.has(id)).toBe(true);

    // Each key decision / reusable candidate has at least one citation.
    expect(pkg.keyDecisions.every((d) => (d.citations as unknown[]).length > 0)).toBe(true);
    expect(pkg.reusableKnowledgeCandidates.length).toBeGreaterThan(0);
    expect(pkg.reusableKnowledgeCandidates.every((r) => (r.citations as unknown[]).length > 0)).toBe(true);
  });

  /* ---- Gate 2: AI 不自动移动 (closure only suggests, never moves) ---- */
  it('generating a closure package does not move or derive any topic', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const project = await makeSpace(ws, user, 'proj', 'cloud_allowed');
    await db.update(spaces).set({ spaceKind: 'project', lifecycleStatus: 'completed' }).where(sql`id = ${project.id}`);
    const area = await makeSpace(ws, user, 'area', 'cloud_allowed');
    await db.update(spaces).set({ spaceKind: 'area' }).where(sql`id = ${area.id}`);

    await makeCitedTopic(project, user, { title: 'TopicA', kp: 'Alpha', content: 'content A', pages: 2 });
    await makeCitedTopic(project, user, { title: 'TopicB', kp: 'Beta', content: 'content B', pages: 2 });

    // Run the closure generation (what the job does).
    const pkg = await generateClosurePackage(project.id);
    await db.execute(sql`INSERT INTO project_closure_packages(workspace_id, space_id, generated_by_id, payload) VALUES (${ws.id}, ${project.id}, ${user.id}::uuid, ${JSON.stringify(pkg)}::jsonb)`);

    // Gate: no Topic was moved/derived into the area space.
    const areaTopics = await db.select().from(wikiTopics).where(sql`space_id = ${area.id}`);
    expect(areaTopics).toHaveLength(0);
    // No derive audit records were created.
    const deriveOps = await db.execute<any>(sql`SELECT * FROM topic_operations WHERE operation_type = 'derive'`);
    expect(deriveOps.rows).toHaveLength(0);
    // The package only *suggests* promotions (does not apply them).
    expect(pkg.recommendedPromotions.length).toBeGreaterThan(0);
    // Stored package present.
    const stored = await db.execute<any>(sql`SELECT * FROM project_closure_packages WHERE space_id = ${project.id}`);
    expect(stored.rows).toHaveLength(1);
  });

  /* ---- Gate 3: 原项目历史完整 (original preserved on derive) ---- */
  it('deriving a topic copies provenance and preserves the original', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const project = await makeSpace(ws, user, 'proj', 'cloud_allowed');
    await db.update(spaces).set({ spaceKind: 'project', lifecycleStatus: 'completed' }).where(sql`id = ${project.id}`);
    const area = await makeSpace(ws, user, 'area', 'cloud_allowed');
    await db.update(spaces).set({ spaceKind: 'area' }).where(sql`id = ${area.id}`);

    const { topic: orig } = await makeCitedTopic(project, user, { title: 'Reusable', kp: 'Gamma', content: 'cross-project knowledge', pages: 2 });

    const { topicId: newId, operationId } = await deriveTopicToSpace(orig.id, area.id, user.id, 'Promoted Reusable');

    // Original is untouched: same space, same content, same sources.
    const [origAfter] = await db.select().from(wikiTopics).where(sql`id = ${orig.id}`).limit(1);
    expect(origAfter.spaceId).toBe(project.id);
    expect(origAfter.contentJson).toEqual(orig.contentJson);
    const origSources = await db.execute<any>(sql`SELECT * FROM topic_sources WHERE topic_id = ${orig.id}`);
    expect(origSources.rows).toHaveLength(2);

    // Derived copy carries provenance + origin back-references.
    const [derived] = await db.select().from(wikiTopics).where(sql`id = ${newId}`).limit(1);
    expect(derived.spaceId).toBe(area.id);
    expect(derived.title).toBe('Promoted Reusable');
    expect(derived.promotedFromTopicId).toBe(orig.id);
    expect(derived.originSpaceId).toBe(project.id);
    const derivedSources = await db.execute<any>(sql`SELECT * FROM topic_sources WHERE topic_id = ${newId}`);
    expect(derivedSources.rows).toHaveLength(2);

    // Audit record exists and is reversible.
    const [op] = await db.select().from(topicOperations).where(sql`id = ${operationId}`).limit(1);
    expect(op.operationType).toBe('derive');

    // Undo removes only the derived copy; original stays.
    await undoTopicOperation(operationId, user.id);
    const derivedAfter = await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${newId}`);
    expect(derivedAfter.rows).toHaveLength(0);
    const origStill = await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${orig.id}`);
    expect(origStill.rows).toHaveLength(1);
  });

  /* ---- Gate 4: 目标 Space 权限正确 (target permission + same workspace) ---- */
  it('rejects derive to a space the user cannot edit or across workspaces', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const project = await makeSpace(ws, user, 'proj', 'cloud_allowed');
    const area = await makeSpace(ws, user, 'area', 'cloud_allowed');
    await db.update(spaces).set({ spaceKind: 'area' }).where(sql`id = ${area.id}`);

    // A second user who is NOT a member of the area space.
    const other = await makeUser();
    const { topic: orig } = await makeCitedTopic(project, user, { title: 'Secret', kp: 'Delta', content: 'sensitive', pages: 2 });

    // API: other user cannot edit the area target -> 403.
    const app = createApp();
    const cookie = await sessionCookie(other);
    const res = await app.request(`/api/llm-wiki/topics/${orig.id}/derive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ targetSpaceId: area.id })
    });
    expect(res.status).toBe(403);

    // Service: cross-workspace derive is rejected (no id mixing).
    const ws2 = await makeWorkspace(user);
    const otherSpace = await makeSpace(ws2, user);
    await expect(deriveTopicToSpace(orig.id, otherSpace.id, user.id)).rejects.toThrow(/across workspaces/);
  });

  /* ---- Archive wizard flow: complete -> closure -> archive (not delete) ---- */
  it('archive wizard archives the project space and down-weights topics without deleting', async () => {
    const user = await makeUser();
    const ws = await makeWorkspace(user);
    const project = await makeSpace(ws, user, 'proj', 'cloud_allowed');
    await db.update(spaces).set({ spaceKind: 'project' }).where(sql`id = ${project.id}`);
    await makeCitedTopic(project, user, { title: 'TopicA', kp: 'Alpha', content: 'content A', pages: 2 });

    // Mark completed (does NOT auto-archive — Phase 1 gate).
    const app = createApp();
    const cookie = await sessionCookie(user);
    const completeRes = await app.request(`/api/spaces/${project.id}/complete`, { method: 'POST', headers: { cookie } });
    expect((await completeRes.json()).space.lifecycleStatus).toBe('completed');

    // Generate + store closure.
    const closureRes = await app.request(`/api/llm-wiki/projects/${project.id}/closure`, { method: 'POST', headers: { cookie } });
    expect((await closureRes.json()).ok).toBe(true);

    // Archive the project.
    const archiveRes = await app.request(`/api/llm-wiki/projects/${project.id}/archive`, { method: 'POST', headers: { cookie } });
    expect((await archiveRes.json()).space.lifecycleStatus).toBe('archived');

    // Topics are down-weighted (archived lifecycle) but NOT deleted.
    const topics = await db.select().from(wikiTopics).where(sql`space_id = ${project.id}`);
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.every((t) => t.lifecycleStatus === 'archived')).toBe(true);
  });
});

import { and, eq, sql } from 'drizzle-orm';
import { claimEvidence, documentChunks, knowledgeClaims, pageKnowledgeMaps, pages } from '@zhipane/db';
import { db } from '../db/client';
import { recordKnowledgeStage } from './knowledge-metrics';

export type PageSection = { anchor: string; heading: string; level: number; chunkIds: string[]; characterCount: number };
export type PageFacet = { id: string; label: string; sectionAnchor: string; chunkIds: string[]; confidence: number };
export type PageKnowledgeMap = { schemaVersion: 'page-knowledge-map-v1'; documentType: 'single_topic_essay' | 'multi_topic_notes' | 'note'; primaryTopic: string; sectionTree: PageSection[]; facets: PageFacet[]; processedCharacterCount: number; inputCharacterCount: number; coverageRatio: number };

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[\p{P}\p{S}]/gu, '').toLocaleLowerCase().trim();
}

function sentence(value: string): string {
  return value.replace(/^#{1,6}\s+.*$/gm, '').split(/(?<=[。！？.!?])\s*/)[0]?.trim() || value.trim();
}

export function buildPageKnowledgeMap(text: string, title: string, chunks: Array<{ id: string; content: string }>): PageKnowledgeMap {
  const inputCharacterCount = text.length;
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)];
  const sections: PageSection[] = headings.map((match, index) => {
    const anchor = `section-${String(index + 1).padStart(2, '0')}`;
    const heading = match[2].replace(/[*_`]/g, '').trim();
    const start = match.index ?? 0;
    const end = headings[index + 1]?.index ?? text.length;
    const body = text.slice(start, end);
    // P0-7: bidirectional overlap so a chunk spanning multiple sections
    // associates with EVERY section it covers (not just the one containing
    // its first 48 chars). This ensures every facet has chunkIds, which in
    // turn lets generatePageKnowledgeArtifacts create a knowledge_claim for
    // every section (acceptance gate: >=95% section coverage, no orphan facets).
    const bodyText = body.replace(/^#{1,6}\s+.+$/gm, '').replace(/\s+/g, '');
    const chunkIds = chunks
      .filter((chunk) => {
        const chunkText = chunk.content.replace(/\s+/g, '');
        if (chunkText.length === 0) return false;
        // chunk starts inside this section
        if (body.includes(chunk.content.slice(0, Math.min(48, chunk.content.length)))) return true;
        // section body appears inside this chunk (chunk spans this section)
        const probe = bodyText.slice(0, Math.min(48, bodyText.length));
        return probe.length >= 12 && chunkText.includes(probe);
      })
      .map((chunk) => chunk.id);
    return { anchor, heading, level: match[1].length, chunkIds, characterCount: body.length };
  });
  if (sections.length === 0) sections.push({ anchor: 'section-01', heading: title || '未命名页面', level: 1, chunkIds: chunks.map((chunk) => chunk.id), characterCount: text.length });
  const facets = sections.slice(0, 10).map((section, index) => ({ id: `facet-${index + 1}`, label: section.heading, sectionAnchor: section.anchor, chunkIds: section.chunkIds, confidence: 0.8 }));
  const documentType = sections.length >= 6 ? 'single_topic_essay' : sections.length >= 3 ? 'multi_topic_notes' : 'note';
  const primaryTopic = title || sections[0].heading;
  const covered = new Set(sections.flatMap((section) => section.chunkIds)).size;
  return { schemaVersion: 'page-knowledge-map-v1', documentType, primaryTopic, sectionTree: sections, facets, processedCharacterCount: inputCharacterCount, inputCharacterCount, coverageRatio: chunks.length ? covered / chunks.length : 0 };
}

const mapCache = new Map<string, { expiresAt: number; map: PageKnowledgeMap }>();
const MAP_CACHE_TTL_MS = 60_000;
export function clearPageKnowledgeCache(): void { mapCache.clear(); }

export async function generatePageKnowledgeArtifacts(pageId: string): Promise<PageKnowledgeMap | null> {
  const startedAt = Date.now();
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page) return null;
  const cacheKey = `${page.id}:${page.contentVersion}`;
  const cached = mapCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    recordKnowledgeStage({ stage: 'page_map', pageId, contentVersion: page.contentVersion, durationMs: Date.now() - startedAt, inputCharacters: page.textContent?.length ?? 0, outputItems: cached.map.sectionTree.length, cacheHit: true });
    return cached.map;
  }
  const chunks = await db.select({ id: documentChunks.id, content: documentChunks.content }).from(documentChunks).where(eq(documentChunks.pageId, pageId)).orderBy(documentChunks.chunkIndex);
  const map = buildPageKnowledgeMap(page.textContent || '', page.title, chunks);
  const [stored] = await db.insert(pageKnowledgeMaps).values({ workspaceId: page.workspaceId, spaceId: page.spaceId, pageId: page.id, contentVersion: page.contentVersion, status: 'ready', mapJson: map, summary: map.primaryTopic, sourceChunkCount: chunks.length, diagnostics: { inputCharacterCount: map.inputCharacterCount, processedCharacterCount: map.processedCharacterCount, coverageRatio: map.coverageRatio } }).onConflictDoUpdate({ target: [pageKnowledgeMaps.pageId, pageKnowledgeMaps.contentVersion], set: { mapJson: map, summary: map.primaryTopic, sourceChunkCount: chunks.length, diagnostics: { inputCharacterCount: map.inputCharacterCount, processedCharacterCount: map.processedCharacterCount, coverageRatio: map.coverageRatio }, updatedAt: sql`now()` } }).returning();
  await db.delete(knowledgeClaims).where(and(eq(knowledgeClaims.pageId, page.id), eq(knowledgeClaims.contentVersion, page.contentVersion)));
  // P0-7: generate one knowledge_claim per facet. Previously every facet
  // sharing the same chunk produced the identical claimText (sentence() of the
  // same chunk), and onConflictDoNothing collapsed them to one claim per chunk —
  // leaving 6 of 9 facets without a claim (orphan sections). Now we prefix the
  // facet heading so each facet's claimText is unique and anchored to its
  // section, while still grounded in the chunk's first sentence.
  for (const facet of map.facets) {
    const source = chunks.find((chunk) => facet.chunkIds.includes(chunk.id));
    if (!source) continue;
    const baseSentence = sentence(source.content).slice(0, 460);
    const claimText = `${facet.label}：${baseSentence}`.slice(0, 500);
    if (claimText.length < 10) continue;
    const [claim] = await db.insert(knowledgeClaims).values({ workspaceId: page.workspaceId, spaceId: page.spaceId, pageId: page.id, knowledgeMapId: stored.id, sectionAnchor: facet.sectionAnchor, text: claimText, normalizedText: normalize(claimText), kind: 'claim', confidence: 80, status: 'generated', contentVersion: page.contentVersion }).onConflictDoNothing().returning();
    if (claim) await db.insert(claimEvidence).values({ claimId: claim.id, chunkId: source.id, excerpt: source.content.slice(0, 240), relevanceScore: 100 }).onConflictDoNothing();
  }
  mapCache.set(cacheKey, { expiresAt: Date.now() + MAP_CACHE_TTL_MS, map });
  recordKnowledgeStage({ stage: 'page_map', pageId, contentVersion: page.contentVersion, durationMs: Date.now() - startedAt, inputCharacters: map.inputCharacterCount, outputItems: map.sectionTree.length + map.facets.length, cacheHit: false });
  return map;
}

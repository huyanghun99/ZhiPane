import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { llmSuggestions, topicCandidates, wikiTopics, topicSources, documentChunks, topicOperations, topicSynonyms, knowledgeClaims, claimEvidence, topicClaims } from '@zhipane/db';
import { generatePageKnowledgeArtifacts } from './page-knowledge.service';
import { logger } from './logger';
import { createAiProviderForContext, vectorToSqlLiteral, isAiDisabledError } from './ai.service';
import { recordActivity } from './activity.service';
import { env } from '../env';
import { tokenizeChineseFriendly } from '../utils/text';
import { topicSynthesisSchema, topicRefreshDiffSchema, type TopicSynthesis, type CitationRef, type TopicRefreshDiff, type TopicRefreshDiffItem } from '@zhipane/shared';
import type { AiProvider } from '@zhipane/ai';
import { TOPIC_SYNTHESIS_PROMPT, TOPIC_REPAIR_PROMPT, TOPIC_EXTRACTION_PROMPT, TOPIC_ROUTING_PROMPT, CLAIM_RELATION_PROMPT, type TopicExtractionContext, type TopicSynthesisContext, type TopicRepairContext, type TopicRoutingContext, type TopicRoutingDecision, type RoutingAction } from '@zhipane/ai';

/**
 * M5 — LLM Wiki artifact generation.
 *
 * After a page is indexed (chunked + embedded), we derive candidate Topics and
 * Suggestions from its content. Everything here is *best-effort*: a failure must
 * never break the page indexing pipeline, so callers wrap `generateWikiArtifacts`
 * in try/catch.
 *
 * Generation strategy:
 *   1. Try the LLM for high-quality topic proposals.
 *   2. Fall back to a deterministic heuristic (headings / frequent terms) when
 *      the LLM is unavailable or returns unparseable output — so the feature
 *      still produces useful artifacts in offline / mock environments.
 */

interface CandidateTopic {
  title: string;
  summary: string;
}

/* ----------------------------------------------- term / topic helpers ----- */

function termSet(text: string): Set<string> {
  const s = new Set<string>();
  // Chinese: emit character bigrams + trigrams so partial phrase overlap is
  // detectable. A greedy [一-鿿]{2,} token could never match a chunk fragment
  // (e.g. title "机器学习核心范式" vs chunk "...机器学习..."), which made every
  // candidate fall back to chunks[0] and collapse into one thin Topic.
  for (const seg of text.match(/[一-鿿]+/g) ?? []) {
    const chars = [...seg];
    for (let i = 0; i < chars.length; i++) {
      if (i + 1 < chars.length) s.add(chars[i] + chars[i + 1]);
      if (i + 2 < chars.length) s.add(chars[i] + chars[i + 1] + chars[i + 2]);
    }
  }
  for (const w of text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) s.add(w);
  return s;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Raw intersection count — used by pickSupportingChunk where the candidate's
// term set is tiny and a Jaccard score against a large chunk set is always
// near-zero, making every chunk look equally (un)related.
function hitCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

// Deterministic fallback: pull markdown H1/H2 headings, else the most frequent
// terms. Guarantees the Topic Center is never empty even without an LLM.
function heuristicTopics(text: string): CandidateTopic[] {
  const headings: CandidateTopic[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (m) {
      const title = m[1].trim().replace(/[*_`#]/g, '').slice(0, 80);
      if (title.length >= 2) headings.push({ title, summary: '' });
    }
  }
  if (headings.length) {
    const seen = new Set<string>();
    const out: CandidateTopic[] = [];
    for (const h of headings) {
      const key = h.title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(h);
      }
    }
    return out.slice(0, 5);
  }
  const counts = new Map<string, number>();
  for (const t of termSet(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => ({ title: t, summary: '' }));
}

function extractJson(s: string): unknown {
  const objStart = s.indexOf('{');
  const objEnd = s.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    return JSON.parse(s.slice(objStart, objEnd + 1));
  }
  const arrStart = s.indexOf('[');
  const arrEnd = s.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    return JSON.parse(s.slice(arrStart, arrEnd + 1));
  }
  throw new Error('no JSON object found in LLM output');
}

/**
 * P0-3 (LLM wiki优化.md): 从 Page Map 的 Facets/Claims 派生 Topic 候选。
 *
 * Facet 是文章内部结构（章节标签），不能默认升级为全局 Topic。只有当 Facet
 * 代表一个边界清晰、具有长期复用价值的知识概念时，才应作为候选。
 *
 * 替换旧的 aiTopics(text) —— 不再 text.slice(0, 4000) 截取原文。
 */
async function aiTopicsFromFacets(
  facets: Array<{ label: string; sectionAnchor: string }>,
  claims: Array<{ text: string; sectionAnchor: string }>,
  pageTitle: string,
  ai: AiProvider
): Promise<CandidateTopic[] | null> {
  if (facets.length === 0 && claims.length === 0) return null;
  try {
    // P0-7: use the dedicated TOPIC_EXTRACTION_PROMPT (facet aggregation).
    // Previously this call reused TOPIC_ROUTING_PROMPT's version marker, which
    // made MockAiProvider return a {decisions} payload instead of {topics},
    // silently falling back to heuristicTopics and producing one candidate per
    // heading — each backed by a single chunk, failing the decideTopicCreation
    // evidence gate. The dedicated prompt returns {topics} and instructs the
    // LLM to aggregate facets into 1-3 core candidates.
    const extractionCtx: TopicExtractionContext = { pageTitle, facets, claims };
    const out = await ai.generateText([
      {
        role: 'system',
        content: `${PROMPT_VERSION_MARKER}${TOPIC_EXTRACTION_PROMPT.version}] ${TOPIC_EXTRACTION_PROMPT.system}`
      },
      { role: 'user', content: TOPIC_EXTRACTION_PROMPT.buildUser(extractionCtx) }
    ]);
    const parsed = extractJson(out) as { topics?: unknown };
    if (!parsed || !Array.isArray(parsed.topics)) return null;
    return (parsed.topics as unknown[])
      .map((t) => {
        const o = t as { title?: unknown; summary?: unknown };
        const title = typeof o.title === 'string' ? o.title.trim().slice(0, 80) : '';
        const summary = typeof o.summary === 'string' ? o.summary.slice(0, 500) : '';
        return title.length >= 2 ? { title, summary } : null;
      })
      .filter((x): x is CandidateTopic => x !== null)
      .slice(0, 5);
  } catch {
    return null;
  }
}

// P0-6: prompt version marker. Prefixed to every system message so
// MockAiProvider can route by prompt version (replacing the fragile
// system.includes('xxx') pattern) and downstream tooling can audit which
// prompt version produced a given output.
const PROMPT_VERSION_MARKER = '[PROMPT_VERSION:';

/* --------------------------------------------------------- topic helpers --- */

// M6: materialise a knowledge edge (idempotent — the partial unique index on
// active edges dedupes reprocessing runs). AI-authored, status 'suggested'.
async function upsertEdge(edge: {
  workspaceId: string; spaceId: string;
  sourceType: string; sourceId: string; targetType: string; targetId: string;
  relationType: string; confidence: number; evidence: Record<string, unknown>;
}) {
  await db.execute(sql`
    INSERT INTO knowledge_edges(
      workspace_id, space_id, source_type, source_id, target_type, target_id,
      relation_type, confidence, evidence, status, created_by
    )
    VALUES (
      ${edge.workspaceId}, ${edge.spaceId}, ${edge.sourceType}, ${edge.sourceId},
      ${edge.targetType}, ${edge.targetId}, ${edge.relationType}, ${edge.confidence},
      ${JSON.stringify(edge.evidence)}::jsonb, 'suggested', 'ai'
    )
    ON CONFLICT (workspace_id, space_id, source_type, source_id, target_type, target_id, relation_type)
      WHERE status <> 'deleted'
    DO UPDATE SET updated_at = now(), confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence
  `);
}

async function hasPendingSuggestion(
  spaceId: string,
  type: string,
  extra: { topicId?: string; targetPageId?: string; candidateId?: string }
): Promise<boolean> {
  const conditions = [
    eq(llmSuggestions.spaceId, spaceId),
    eq(llmSuggestions.type, type),
    eq(llmSuggestions.status, 'pending')
  ];
  if (extra.topicId) conditions.push(eq(llmSuggestions.topicId, extra.topicId));
  if (extra.targetPageId) conditions.push(eq(llmSuggestions.pageId, extra.targetPageId));
  if (extra.candidateId) {
    conditions.push(sql`${llmSuggestions.payload} ->> 'candidateId' = ${extra.candidateId}::text`);
  }
  const rows = await db
    .select({ one: sql`1` })
    .from(llmSuggestions)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

/* ----------------------------------------- structured Page Profile ----- */

/**
 * Phase 2 (D3): derive a *structured* Page Profile from the page text without
 * an extra AI round-trip (deterministic, cheap, testable). The profile backs
 * both `page_ai_profiles` and each generated candidate's `profile` snapshot.
 */
export function buildPageProfile(text: string, title: string): {
  summary: string;
  tags: string[];
  keywords: string[];
  entities: string[];
} {
  const clean = (text || '').trim();
  const summary = clean ? clean.slice(0, 240) : title;
  const terms = [...termSet(clean)];
  const freq = new Map<string, number>();
  for (const t of terms) freq.set(t, (freq.get(t) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  // Headings / quoted / Title-Cased fragments are treated as entities.
  const entities = new Set<string>();
  for (const line of clean.split(/\r?\n/)) {
    const m = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (m) entities.add(m[1].trim().replace(/[*_`#]/g, '').slice(0, 80));
  }
  for (const q of clean.match(/[“"『「]([^”"』」]{2,40})[”"』」]/g) ?? []) {
    entities.add(q.slice(1, -1).trim());
  }
  return {
    summary,
    tags: top,
    keywords: terms.slice(0, 12),
    entities: [...entities].slice(0, 10)
  };
}

// Pick the chunk whose content best overlaps the candidate title/summary.
// Falls back to the first chunk (or null when the page has no chunks yet).
// Pick the chunk whose content best matches the candidate. Uses semantic
// (embedding) similarity when available so a leading "overview" chunk that
// mentions every topic does NOT hijack every candidate — embeddings capture
// *which section* a candidate belongs to. Falls back to keyword hit count,
// then to the first chunk.
async function pickSupportingChunk(
  chunks: { id: string; content: string; embedding?: number[] | null }[],
  cand: { title: string; summary: string },
  candEmb?: number[] | null
): Promise<string | null> {
  if (chunks.length === 0) return null;
  if (chunks.length === 1) return chunks[0].id;
  if (candEmb && candEmb.length > 0) {
    let bestId = chunks[0].id;
    let bestSim = -Infinity;
    for (const c of chunks) {
      if (!c.embedding || c.embedding.length === 0) continue;
      const sim = cosineSimilarity(candEmb, c.embedding);
      if (sim > bestSim) { bestSim = sim; bestId = c.id; }
    }
    if (bestSim > -Infinity) return bestId;
  }
  const needle = termSet(`${cand.title} ${cand.summary}`);
  if (needle.size === 0) return chunks[0].id;
  let bestId = chunks[0].id;
  let bestScore = -1;
  for (const c of chunks) {
    const score = hitCount(needle, termSet(c.content || ''));
    if (score > bestScore) {
      bestScore = score;
      bestId = c.id;
    }
  }
  return bestId;
}

/* ----------------------------------------- Phase 3: clustering ------------- */

/**
 * Normalize a topic title for alias / synonym matching (spec E2 step 1).
 * Lowercases, strips punctuation (keeps letters/digits/spaces), collapses
 * whitespace. "机器学习！" and "Machine Learning" → different strings here, but
 * "机器学习" and " 机器学习 " collapse to the same key (synonyms aggregate).
 */
export function normalizeTitle(t: string): string {
  return (t || '')
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phase B (B1.1): synonym-aware normalization. Maps an alias to its canonical
 * term (e.g. "ML" / "机器学习" -> "machinelearning") so semantically-equivalent
 * titles cluster together. The map is cached per workspace (global synonyms
 * have a NULL workspace_id and apply everywhere).
 */
const synonymCache = new Map<string, Map<string, string>>();
export async function getSynonymMap(workspaceId: string): Promise<Map<string, string>> {
  const cached = synonymCache.get(workspaceId);
  if (cached) return cached;
  const rows = await db
    .select()
    .from(topicSynonyms)
    .where(sql`workspace_id = ${workspaceId}::uuid OR workspace_id IS NULL`);
  const m = new Map<string, string>();
  for (const r of rows) m.set(normalizeTitle(r.normalizedTerm), r.canonicalTerm);
  synonymCache.set(workspaceId, m);
  return m;
}
export function applySynonyms(term: string, syn: Map<string, string>): string {
  const n = normalizeTitle(term);
  return syn.get(n) ?? n;
}
/** Test/utility hook to clear the per-workspace synonym cache. */
export function clearSynonymCache(): void {
  synonymCache.clear();
}

export type TopicCreationDecision = 'single_source' | 'normal' | 'none';

/**
 * Phase 3 (E3) — `TopicCreationPolicy`. Decides whether a cluster of candidates
 * may become a formal Topic:
 *   - 2+ related pages OR enough valid chunks  -> a normal Draft
 *   - a single high-quality long page (>=2 chunks) -> a single_source Draft
 *   - insufficient evidence                    -> none (keep as Candidate)
 * This is a *domain policy*, never delegated to the LLM.
 */
export function decideTopicCreation(opts: {
  candidateCount: number;
  distinctPageCount: number;
  validChunkCount: number;
  claimCount?: number;
}): TopicCreationDecision {
  if (opts.distinctPageCount >= 2 || opts.validChunkCount >= 3) return 'normal';
  // P0-4/P0-7: Claim-Evidence model. A single-page candidate backed by >=2
  // Claim bundles (each with its own Evidence chunk) has enough independent
  // evidence to become a Topic, even if pickSupportingChunk bound the
  // candidate row to a single chunk. Without this, the Claim-Evidence model
  // (P0-4) would never produce a Topic from a single-page import — the
  // regression suite's Article 1 case.
  const claimCount = opts.claimCount ?? 0;
  if (opts.distinctPageCount === 1 && (opts.validChunkCount >= 2 || claimCount >= 2)) return 'single_source';
  return 'none';
}

function cosineSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Parse a stored pgvector value (number[] or JSON-string) into number[] | null. */
function parseVector(v: unknown): number[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? (p as number[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface SupportChunk {
  chunkId: string;
  pageId: string;
  content: string;
  contentVersion: number;
}

// Pairwise term-overlap over the supporting chunks of a candidate group. Used
// as the deterministic "same meaning?" signal so we never merge same-name /
// different-meaning clusters (spec gate: 同名异义不误合并).
function groupSemanticOverlap(chunks: SupportChunk[]): number {
  if (chunks.length < 2) return 1;
  let best = 0;
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j < chunks.length; j++) {
      best = Math.max(best, overlap(termSet(chunks[i].content), termSet(chunks[j].content)));
    }
  }
  return best;
}

export type SynthesisDiagnostics = {
  inputCharacterCount: number;
  processedCharacterCount: number;
  evidenceCount: number;
  usedFallback: boolean;
  qualityScore: number;
  qualityIssues: string[];
};

export type SynthesisResult =
  | { status: 'ready'; synthesis: TopicSynthesis; diagnostics: SynthesisDiagnostics }
  | { status: 'failed'; error: string; evidencePreview: Array<{ chunkId: string; pageId: string; excerpt: string }>; diagnostics: SynthesisDiagnostics };

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizedForQuality(value: string): string {
  return compactText(value).replace(/[\p{P}\p{S}]/gu, '').toLocaleLowerCase();
}

function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (value: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < value.length - 1; i++) {
      const gram = value.slice(i, i + 2);
      out.set(gram, (out.get(gram) ?? 0) + 1);
    }
    return out;
  };
  const left = grams(a);
  const right = grams(b);
  let overlap = 0;
  for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) ?? 0);
  return (2 * overlap) / Math.max(1, a.length - 1 + b.length - 1);
}

function longestSharedRun(value: string, source: string): number {
  const limit = Math.min(value.length, 800);
  for (let size = limit; size >= 24; size--) {
    for (let i = 0; i <= value.length - size; i++) {
      if (source.includes(value.slice(i, i + size))) return size;
    }
  }
  return 0;
}

export function evaluateSynthesisQuality(synthesis: TopicSynthesis, chunks: SupportChunk[]): { score: number; issues: string[] } {
  const issues: string[] = [];
  const definition = normalizedForQuality(synthesis.definition);
  const overview = normalizedForQuality(synthesis.overview);
  if (definition.length < 12) issues.push('definition_too_short');
  if (overview.length < 24) issues.push('overview_too_short');
  if (diceSimilarity(definition, overview) >= 0.65) issues.push('definition_overview_redundant');
  const fields = [synthesis.definition, synthesis.overview, ...synthesis.keyPoints.flatMap((point) => [point.title, point.content])];
  if (fields.some((value) => /^[，。；、：）】]|^(起来|需要|以及|但是|因此|同时|并且)/.test(compactText(value)))) issues.push('sentence_fragment');
  const source = chunks.map((chunk) => compactText(chunk.content)).join('\n');
  if (fields.some((value) => longestSharedRun(compactText(value), source) >= 120)) issues.push('source_copy_too_long');
  for (let i = 0; i < synthesis.keyPoints.length; i++) {
    for (let j = i + 1; j < synthesis.keyPoints.length; j++) {
      const a = normalizedForQuality(`${synthesis.keyPoints[i].title} ${synthesis.keyPoints[i].content}`);
      const b = normalizedForQuality(`${synthesis.keyPoints[j].title} ${synthesis.keyPoints[j].content}`);
      if (diceSimilarity(a, b) >= 0.8) issues.push('key_points_redundant');
    }
  }
  if (synthesis.keyPoints.some((point) => point.citations.length === 0)) issues.push('citation_missing');
  // P0-5: HTML fragment detection. Reject obvious tag leakage from the
  // editor (ProseMirror JSON should never serialize as raw HTML here).
  const htmlPattern = /<(?:div|span|p|ul|ol|li|h[1-6]|img|a|br|table|tr|td|th|strong|em|code|pre|blockquote)\b/i;
  if (fields.some((value) => htmlPattern.test(value))) issues.push('html_fragment');
  // P0-5: citation must actually support the keyPoint. A citation whose
  // excerpt shares no bigram with the keyPoint text is treated as
  // non-supporting (semantic drift / hallucinated reference).
  for (const point of synthesis.keyPoints) {
    const pointNorm = normalizedForQuality(`${point.title} ${point.content}`);
    const supported = point.citations.some((citation) => {
      const excerpt = normalizedForQuality(citation.excerpt || '');
      if (!excerpt) return true; // no excerpt to disprove; trust the LLM
      return diceSimilarity(pointNorm, excerpt) >= 0.12;
    });
    if (!supported) issues.push('citation_not_supporting');
  }
  // P0-5: off-topic drift. Every keyPoint must relate to at least one
  // supplied evidence chunk; otherwise the synthesis has introduced
  // content not grounded in the source (a Topic mixing in unrelated themes).
  if (chunks.length > 0) {
    const chunkNorms = chunks.map((chunk) => normalizedForQuality(chunk.content));
    for (const point of synthesis.keyPoints) {
      const pointNorm = normalizedForQuality(`${point.title} ${point.content}`);
      const grounded = chunkNorms.some((chunkNorm) => diceSimilarity(pointNorm, chunkNorm) >= 0.18);
      if (!grounded) issues.push('off_topic_drift');
    }
  }
  return { score: Math.max(0, 100 - issues.length * 20), issues: [...new Set(issues)] };
}

/**
 * P0-5 (LLM wiki优化.md): user-locked fields must NOT be overwritten by AI
 * synthesis. `lockedFields` is a text array on wiki_topics (migration 0024)
 * with values like 'definition' | 'overview' | 'keyPoints'. This helper is
 * evaluated at the persistence boundary, not inside evaluateSynthesisQuality,
 * because it depends on the existing Topic row, not the synthesis alone.
 */
export type LockableField = 'definition' | 'overview' | 'keyPoints';
export function evaluateLockedFieldViolations(
  synthesis: TopicSynthesis,
  lockedFields: string[] | null | undefined
): { violations: string[] } {
  if (!lockedFields || lockedFields.length === 0) return { violations: [] };
  const set = new Set(lockedFields as string[]);
  const violations: string[] = [];
  if (set.has('definition') && synthesis.definition) violations.push('definition_locked');
  if (set.has('overview') && synthesis.overview) violations.push('overview_locked');
  if (set.has('keyPoints') && synthesis.keyPoints.length > 0) violations.push('keyPoints_locked');
  return { violations };
}

/**
 * P0-5: returns a copy of `synthesis` with the locked fields restored from
 * the previous synthesis. Used at the persistence boundary so AI refresh
 * never overwrites fields the user has explicitly pinned.
 */
export function applySynthesisRespectingLocks(
  next: TopicSynthesis,
  previous: TopicSynthesis | null | undefined,
  lockedFields: string[] | null | undefined
): TopicSynthesis {
  if (!previous || !lockedFields || lockedFields.length === 0) return next;
  const set = new Set(lockedFields as string[]);
  return {
    ...next,
    definition: set.has('definition') ? previous.definition : next.definition,
    overview: set.has('overview') ? previous.overview : next.overview,
    keyPoints: set.has('keyPoints') ? previous.keyPoints : next.keyPoints
  };
}

function synthesisDiagnostics(chunks: SupportChunk[], processedCharacterCount: number, qualityScore = 0, qualityIssues: string[] = [], usedFallback = false): SynthesisDiagnostics {
  const inputCharacterCount = chunks.reduce((total, chunk) => total + chunk.content.length, 0);
  return { inputCharacterCount, processedCharacterCount, evidenceCount: chunks.length, usedFallback, qualityScore, qualityIssues };
}

/**
 * Deterministic synthesis from raw chunk slices.
 *
 * P0-1 (LLM wiki优化.md): this function is NOT used to produce formal Topic
 * content anymore — promoteCandidate now goes through generateTopicSynthesis
 * (LLM + quality gate) like consolidateCandidates. Kept exported for evidence
 * snapshots / fallback tests; do NOT route its output into wiki_topics.
 */
export function buildDeterministicSynthesis(chunks: SupportChunk[]): TopicSynthesis {
  const keyPoints = chunks.map((c, i) => {
    const headingMatch = c.content.match(/^#{1,3}\s+(.+?)\s*$/m);
    const title = headingMatch ? headingMatch[1].replace(/[*_`#]/g, '').slice(0, 80) : `要点 ${i + 1}`;
    const content = c.content.replace(/^#{1,3}\s+.+$/m, '').replace(/\s+/g, ' ').trim().slice(0, 400) || c.content.slice(0, 400);
    const citation: CitationRef = { chunkId: c.chunkId, pageId: c.pageId, excerpt: c.content.slice(0, 200) };
    return { id: `kp-${i + 1}`, title, content, citations: [citation] };
  });
  const overview = chunks.map((c) => c.content.replace(/^#{1,3}\s+.+$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 120)).join(' ').slice(0, 600);
  return { schemaVersion: 'topic-synthesis-v1', definition: overview.slice(0, 160), overview, keyPoints, subtopics: [], conflicts: [], decisions: [], openQuestions: [], relatedTopicIds: [], generatedFromContentVersions: chunks.map((c) => ({ pageId: c.pageId, contentVersion: c.contentVersion })) };
}

function failedSynthesis(chunks: SupportChunk[], error: string, processedCharacterCount = 0, qualityScore = 0, qualityIssues: string[] = []): SynthesisResult {
  return {
    status: 'failed',
    error,
    evidencePreview: chunks.slice(0, 5).map((chunk) => ({ chunkId: chunk.chunkId, pageId: chunk.pageId, excerpt: compactText(chunk.content).slice(0, 240) })),
    diagnostics: synthesisDiagnostics(chunks, processedCharacterCount, qualityScore, qualityIssues)
  };
}

function sanitizeSynthesis(raw: unknown, validChunkIds: Set<string>): TopicSynthesis | null {
  const parsed = topicSynthesisSchema.safeParse(raw);
  if (!parsed.success) return null;
  const synth = parsed.data;
  const fixed: TopicSynthesis = { ...synth, keyPoints: synth.keyPoints.map((point) => ({ ...point, citations: point.citations.filter((citation) => validChunkIds.has(citation.chunkId)) })) };
  return topicSynthesisSchema.safeParse(fixed).success ? fixed : null;
}

/**
 * P0-5 (LLM wiki优化.md): maximum automatic repair rounds before a synthesis
 * is routed to the anomaly queue (synthesis_failed). Two rounds is the cap
 * mandated by the optimization doc.
 */
const MAX_REPAIR_ROUNDS = 2;

/**
 * P0-5: build the topic-repair prompt for the chunk-only synthesis path. The
 * LLM receives the failed synthesis, the specific quality issues, and the
 * source chunks, and is asked to return a corrected JSON.
 */
function buildChunkRepairPrompt(synthesis: TopicSynthesis, issues: string[], chunks: SupportChunk[]): { system: string; user: string } {
  // P0-6: use the centralized TOPIC_REPAIR_PROMPT spec (chunk-only path:
  // wrap each chunk as a single-evidence Claim so the prompt template works).
  const repairCtx: TopicRepairContext = {
    synthesis,
    issues,
    claims: chunks.map((c) => ({
      claimId: c.chunkId,
      text: c.content.replace(/\s+/g, ' ').trim().slice(0, 200),
      sectionAnchor: '-',
      evidence: [{ chunkId: c.chunkId, content: c.content }]
    }))
  };
  return {
    system: `${PROMPT_VERSION_MARKER}${TOPIC_REPAIR_PROMPT.version}] ${TOPIC_REPAIR_PROMPT.system}`,
    user: TOPIC_REPAIR_PROMPT.buildUser(repairCtx)
  };
}

/**
 * P0-5: build the topic-repair prompt for the Claim-Evidence synthesis path.
 * Same contract as buildChunkRepairPrompt, but keeps the CLID/CID grouping so
 * repaired citations can still reference both Claim and chunk.
 */
function buildClaimRepairPrompt(synthesis: TopicSynthesis, issues: string[], claims: ClaimBundle[]): { system: string; user: string } {
  // P0-6: use the centralized TOPIC_REPAIR_PROMPT spec (Claim-Evidence path).
  const repairCtx: TopicRepairContext = {
    synthesis,
    issues,
    claims: claims.map((c) => ({
      claimId: c.claimId,
      text: c.text,
      sectionAnchor: c.sectionAnchor,
      evidence: c.evidence.map((ev) => ({ chunkId: ev.chunkId, content: ev.content }))
    }))
  };
  return {
    system: `${PROMPT_VERSION_MARKER}${TOPIC_REPAIR_PROMPT.version}] ${TOPIC_REPAIR_PROMPT.system}`,
    user: TOPIC_REPAIR_PROMPT.buildUser(repairCtx)
  };
}

/**
 * P0-5: automatic repair loop. Up to MAX_REPAIR_ROUNDS (2) rounds of LLM
 * repair are attempted before the synthesis is routed to the anomaly queue.
 * Each round re-validates with evaluateSynthesisQuality; on success the loop
 * returns a ready SynthesisResult, on failure (after exhausting rounds) it
 * returns a failed SynthesisResult with the remaining issues.
 */
async function applyRepairLoop(
  initial: TopicSynthesis,
  chunks: SupportChunk[],
  ai: AiProvider,
  validChunkIds: Set<string>,
  processedCharacterCount: number,
  buildRepairPrompt: (synthesis: TopicSynthesis, issues: string[]) => { system: string; user: string }
): Promise<SynthesisResult> {
  let synthesis = initial;
  let quality = evaluateSynthesisQuality(synthesis, chunks);
  let rounds = 0;
  while (quality.issues.length > 0 && rounds < MAX_REPAIR_ROUNDS) {
    let repaired: TopicSynthesis | null = null;
    try {
      const { system, user } = buildRepairPrompt(synthesis, quality.issues);
      const output = await ai.generateText([
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]);
      repaired = sanitizeSynthesis(extractJson(output), validChunkIds);
    } catch {
      repaired = null;
    }
    if (!repaired) break;
    synthesis = repaired;
    quality = evaluateSynthesisQuality(synthesis, chunks);
    rounds++;
  }
  if (quality.issues.length > 0) {
    return failedSynthesis(
      chunks,
      `综合质量未通过（${rounds} 轮自动修复后仍失败）：${quality.issues.join('、')}`,
      processedCharacterCount,
      quality.score,
      quality.issues
    );
  }
  return { status: 'ready', synthesis, diagnostics: synthesisDiagnostics(chunks, processedCharacterCount, quality.score, quality.issues) };
}

export async function generateTopicSynthesis(chunks: SupportChunk[], ai: AiProvider): Promise<SynthesisResult> {
  if (chunks.length === 0) return failedSynthesis(chunks, '没有可用于综合的证据');
  const validIds = new Set(chunks.map((chunk) => chunk.chunkId));
  const context = chunks.map((chunk) => `[CID:${chunk.chunkId}] (page ${chunk.pageId})\n${chunk.content}`).join('\n\n');
  const processedCharacterCount = Math.min(context.length, 6000);
  try {
    // P0-6: use the centralized TOPIC_SYNTHESIS_PROMPT spec. The chunk-only
    // path synthesizes directly from SupportChunks (no Claim grouping), so we
    // adapt the context shape: each chunk becomes a single-evidence Claim.
    const synthCtx: TopicSynthesisContext = {
      claims: chunks.map((c) => ({
        claimId: c.chunkId,
        text: c.content.replace(/\s+/g, ' ').trim().slice(0, 200),
        sectionAnchor: '-',
        evidence: [{ chunkId: c.chunkId, pageId: c.pageId, content: c.content }]
      }))
    };
    const output = await ai.generateText([
      { role: 'system', content: `${PROMPT_VERSION_MARKER}${TOPIC_SYNTHESIS_PROMPT.version}] ${TOPIC_SYNTHESIS_PROMPT.system}` },
      { role: 'user', content: TOPIC_SYNTHESIS_PROMPT.buildUser(synthCtx).slice(0, processedCharacterCount) }
    ]);
    const initial = sanitizeSynthesis(extractJson(output), validIds);
    if (!initial) return failedSynthesis(chunks, '模型输出无法解析为带有效引用的综合结果', processedCharacterCount);
    // P0-5: route through the 2-round automatic repair loop before declaring
    // the synthesis ready or failed.
    return applyRepairLoop(initial, chunks, ai, validIds, processedCharacterCount, (s, issues) => buildChunkRepairPrompt(s, issues, chunks));
  } catch (error) {
    return failedSynthesis(chunks, error instanceof Error ? error.message : '综合请求失败', processedCharacterCount);
  }
}

/* ------------------------------------------- P0-4: Claim-Evidence model ---- */

/**
 * P0-4 (LLM wiki优化.md): a Claim bundle is the unit of synthesis. Each bundle
 * carries one Claim and its supporting Evidence Blocks (chunks). The LLM
 * synthesizes a Topic from multiple bundles, and every keyPoint citation may
 * reference both the Claim (claimId) and the Evidence chunk (chunkId) it came
 * from — so each Key Point traces to a specific Claim rather than a single
 * "best chunk" picked at candidate time.
 */
export interface ClaimBundle {
  claimId: string;
  text: string;
  sectionAnchor: string;
  evidence: SupportChunk[];
}

/**
 * Load Claim bundles (Claim + their Evidence chunks) for a set of pages.
 * Returns bundles whose Claims have at least one usable Evidence Block; a
 * Claim with no evidence is dropped because every keyPoint citation requires
 * a valid chunkId (per citationRefSchema).
 */
export async function getClaimBundlesForPages(pageIds: string[]): Promise<ClaimBundle[]> {
  const ids = pageIds.filter((x): x is string => !!x);
  if (ids.length === 0) return [];
  const claimRows = await db
    .select({
      id: knowledgeClaims.id,
      text: knowledgeClaims.text,
      sectionAnchor: knowledgeClaims.sectionAnchor,
      pageId: knowledgeClaims.pageId
    })
    .from(knowledgeClaims)
    .where(sql`${knowledgeClaims.pageId} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])`)
    .orderBy(sql`created_at DESC`)
    .limit(60);
  if (claimRows.length === 0) return [];
  const claimIds = claimRows.map((c) => c.id);
  const evidenceRows = await db
    .select({ claimId: claimEvidence.claimId, chunkId: claimEvidence.chunkId, excerpt: claimEvidence.excerpt })
    .from(claimEvidence)
    .where(sql`${claimEvidence.claimId} = ANY(ARRAY[${sql.join(claimIds.map((id) => sql`${id}::uuid`), sql`, `)}])`);
  const evidenceByClaim = new Map<string, { chunkId: string; excerpt: string }[]>();
  for (const e of evidenceRows) {
    if (!evidenceByClaim.has(e.claimId)) evidenceByClaim.set(e.claimId, []);
    evidenceByClaim.get(e.claimId)!.push({ chunkId: e.chunkId, excerpt: e.excerpt });
  }
  const distinctChunkIds = [...new Set(evidenceRows.map((e) => e.chunkId))];
  if (distinctChunkIds.length === 0) return [];
  const chunkRows = await db.execute<any>(sql`
    SELECT dc.id, dc.content, dc.page_id AS page_id, p.content_version AS content_version
    FROM document_chunks dc
    JOIN pages p ON p.id = dc.page_id
    WHERE dc.id = ANY(ARRAY[${sql.join(distinctChunkIds.map((id) => sql`${id}::uuid`), sql`, `)}])
  `);
  const chunkById = new Map<string, SupportChunk>();
  for (const r of chunkRows.rows ?? []) {
    chunkById.set(r.id, { chunkId: r.id, content: r.content, pageId: r.page_id, contentVersion: r.content_version });
  }
  const bundles: ClaimBundle[] = [];
  for (const c of claimRows) {
    const evidenceMeta = evidenceByClaim.get(c.id) ?? [];
    const evidence: SupportChunk[] = [];
    for (const meta of evidenceMeta) {
      const sc = chunkById.get(meta.chunkId);
      if (sc) evidence.push(sc);
    }
    if (evidence.length === 0) continue; // claim with no usable evidence cannot be cited
    bundles.push({ claimId: c.id, text: c.text, sectionAnchor: c.sectionAnchor, evidence });
  }
  return bundles;
}

/**
 * Persist topic_claims rows binding each Claim to a Topic. routing_action is
 * set based on whether the Topic is being updated or newly created.
 * 'attach_as_example' is reserved for the explicit "attach as example" route;
 * the other 4 routing actions don't write to topic_claims (they describe a
 * Claim NOT being bound to a Topic).
 */
async function persistTopicClaims(
  topicId: string,
  workspaceId: string,
  spaceId: string,
  claimIds: string[],
  routingAction: 'update_existing' | 'create_emerging'
): Promise<void> {
  if (claimIds.length === 0) return;
  await db
    .insert(topicClaims)
    .values(
      claimIds.map((claimId) => ({
        workspaceId,
        spaceId,
        topicId,
        claimId,
        routingAction,
        contributionType: 'key_point',
        addedBy: 'ai'
      }))
    )
    .onConflictDoNothing();
}

/**
 * P0-4: synthesis from Claim-Evidence bundles. Replaces the legacy
 * "one candidate -> one best Chunk" path so a Topic's body is synthesized
 * from many independently-cited Claims (each carrying its own Evidence).
 *
 * The LLM receives evidence grouped by Claim and is instructed to cite both
 * claimId (CLID) and chunkId (CID) per keyPoint, so each Key Point traces to
 * a specific Claim. Quality gate is the same as the chunk-only path.
 */
export async function generateTopicSynthesisFromClaims(claims: ClaimBundle[], ai: AiProvider): Promise<SynthesisResult> {
  if (claims.length === 0) return failedSynthesis([], '没有可用于综合的 Claim-Evidence 捆绑包');
  const sections = claims.map((claim) => {
    const evBlocks = claim.evidence
      .map((ev) => `  [CID:${ev.chunkId}] (page ${ev.pageId})\n  ${ev.content.replace(/\s+/g, ' ').trim().slice(0, 600)}`)
      .join('\n');
    return `[CLID:${claim.claimId}] (section ${claim.sectionAnchor || '-'})\n${claim.text}\nEvidence:\n${evBlocks}`;
  });
  const context = sections.join('\n\n');
  const processedCharacterCount = Math.min(context.length, 8000);
  const validChunkIds = new Set<string>();
  const allChunks: SupportChunk[] = [];
  const seenChunk = new Set<string>();
  for (const c of claims) {
    for (const ev of c.evidence) {
      validChunkIds.add(ev.chunkId);
      if (!seenChunk.has(ev.chunkId)) {
        seenChunk.add(ev.chunkId);
        allChunks.push(ev);
      }
    }
  }
  try {
    // P0-6: use the centralized TOPIC_SYNTHESIS_PROMPT spec (Claim-Evidence path).
    const synthCtx: TopicSynthesisContext = {
      claims: claims.map((c) => ({
        claimId: c.claimId,
        text: c.text,
        sectionAnchor: c.sectionAnchor,
        evidence: c.evidence.map((ev) => ({ chunkId: ev.chunkId, pageId: ev.pageId, content: ev.content }))
      }))
    };
    const output = await ai.generateText([
      { role: 'system', content: `${PROMPT_VERSION_MARKER}${TOPIC_SYNTHESIS_PROMPT.version}] ${TOPIC_SYNTHESIS_PROMPT.system}` },
      { role: 'user', content: TOPIC_SYNTHESIS_PROMPT.buildUser(synthCtx).slice(0, processedCharacterCount) }
    ]);
    const initial = sanitizeSynthesis(extractJson(output), validChunkIds);
    if (!initial) return failedSynthesis(allChunks, '模型输出无法解析为带有效引用的综合结果', processedCharacterCount);
    // P0-5: route through the 2-round automatic repair loop before declaring
    // the synthesis ready or failed. Claim-Evidence path uses the claim-aware
    // repair prompt so CLID/CID citations survive the repair round.
    return applyRepairLoop(initial, allChunks, ai, validChunkIds, processedCharacterCount, (s, issues) => buildClaimRepairPrompt(s, issues, claims));
  } catch (error) {
    return failedSynthesis(allChunks, error instanceof Error ? error.message : '综合请求失败', processedCharacterCount);
  }
}

/* ----------------------------------------- P0-6: topic-routing ---- */

/**
 * P0-6 (LLM wiki优化.md §四): full 7-action topic-routing decision.
 *
 * For each incoming Claim, decide one of:
 *   update_existing | create_emerging | keep_as_facet |
 *   attach_as_example | keep_as_reference | ignore_duplicate | request_review
 *
 * Default priority is update_existing over create_emerging (per the doc:
 * "默认优先更新已有 Topic，而不是创建近义 Topic"). Only Claims with clear
 * boundaries, long-term reuse value, and no fitting existing Topic may
 * create a new Topic.
 *
 * Returns an array of decisions aligned 1:1 with `incomingClaims`. On LLM
 * failure or unparseable output, every Claim is routed to `request_review`
 * so a human can decide — we never silently drop a Claim.
 */
export async function routeClaims(
  incomingClaims: Array<{ id: string; text: string; sectionAnchor: string }>,
  existingTopics: Array<{ id: string; title: string; aliases: string[]; normalizedTitle: string }>,
  pageTitle: string,
  ai: AiProvider
): Promise<TopicRoutingDecision[]> {
  if (incomingClaims.length === 0) return [];
  // Default fallback: route every Claim to request_review (safe default).
  const fallback: TopicRoutingDecision[] = incomingClaims.map((c) => ({
    claimId: c.id,
    routingAction: 'request_review' as const,
    reason: 'LLM 路由失败，转人工复核'
  }));
  try {
    const ctx: TopicRoutingContext = { incomingClaims, existingTopics, pageTitle };
    const out = await ai.generateText([
      { role: 'system', content: `${PROMPT_VERSION_MARKER}${TOPIC_ROUTING_PROMPT.version}] ${TOPIC_ROUTING_PROMPT.system}` },
      { role: 'user', content: TOPIC_ROUTING_PROMPT.buildUser(ctx) }
    ]);
    const parsed = extractJson(out) as { decisions?: unknown };
    if (!parsed || !Array.isArray(parsed.decisions)) return fallback;
    const validActions = new Set([
      'update_existing', 'create_emerging', 'keep_as_facet',
      'attach_as_example', 'keep_as_reference', 'ignore_duplicate', 'request_review'
    ]);
    const existingIds = new Set(existingTopics.map((t) => t.id));
    const incomingIds = new Set(incomingClaims.map((c) => c.id));
    const decisions: TopicRoutingDecision[] = [];
    for (const raw of parsed.decisions as unknown[]) {
      const d = raw as { claimId?: unknown; routingAction?: unknown; targetTopicId?: unknown; newTopicTitle?: unknown; reason?: unknown };
      const claimId = typeof d.claimId === 'string' ? d.claimId : '';
      const action = typeof d.routingAction === 'string' ? d.routingAction : '';
      if (!incomingIds.has(claimId) || !validActions.has(action)) continue;
      const decision: TopicRoutingDecision = {
        claimId,
        routingAction: action as RoutingAction,
        reason: typeof d.reason === 'string' ? d.reason.slice(0, 240) : ''
      };
      // Validate targetTopicId for actions that require it.
      if ((action === 'update_existing' || action === 'attach_as_example') && typeof d.targetTopicId === 'string' && existingIds.has(d.targetTopicId)) {
        decision.targetTopicId = d.targetTopicId;
      } else if (action === 'update_existing' || action === 'attach_as_example') {
        // LLM referenced a non-existent Topic — downgrade to request_review.
        decision.routingAction = 'request_review';
        decision.reason = `LLM 指定的 targetTopicId 不存在，转人工复核。原动作：${action}`;
      }
      // Validate newTopicTitle for create_emerging.
      if (action === 'create_emerging') {
        decision.newTopicTitle = typeof d.newTopicTitle === 'string' ? d.newTopicTitle.slice(0, 80) : '';
        if (!decision.newTopicTitle) {
          decision.routingAction = 'request_review';
          decision.reason = 'LLM 未提供 newTopicTitle，转人工复核。原动作：create_emerging';
        }
      }
      decisions.push(decision);
    }
    // Ensure every incoming Claim has a decision (fill missing with request_review).
    const decided = new Set(decisions.map((d) => d.claimId));
    for (const c of incomingClaims) {
      if (!decided.has(c.id)) {
        decisions.push({ claimId: c.id, routingAction: 'request_review', reason: 'LLM 未返回该 Claim 的决策，转人工复核' });
      }
    }
    return decisions;
  } catch {
    return fallback;
  }
}

/**
 * P0-6 (LLM wiki优化.md §五 claim-relation): analyze semantic relations
 * between Claims. Returns relations with one of:
 *   supports | contradicts | refines | unrelated
 *
 * Used to surface conflicts (contradicts) and refinement chains (refines)
 * in the Topic synthesis step. On LLM failure, returns an empty array —
 * relation analysis is enhancement, not a gate.
 */
export async function analyzeClaimRelations(
  claims: Array<{ id: string; text: string; sectionAnchor: string }>,
  ai: AiProvider
): Promise<Array<{ claimAId: string; claimBId: string; relation: 'supports' | 'contradicts' | 'refines' | 'unrelated'; note: string }>> {
  if (claims.length < 2) return [];
  try {
    const ctx = { claims };
    const out = await ai.generateText([
      { role: 'system', content: `${PROMPT_VERSION_MARKER}${CLAIM_RELATION_PROMPT.version}] ${CLAIM_RELATION_PROMPT.system}` },
      { role: 'user', content: CLAIM_RELATION_PROMPT.buildUser(ctx) }
    ]);
    const parsed = extractJson(out) as { relations?: unknown };
    if (!parsed || !Array.isArray(parsed.relations)) return [];
    const validRelations = new Set(['supports', 'contradicts', 'refines', 'unrelated']);
    const claimIds = new Set(claims.map((c) => c.id));
    const result: Array<{ claimAId: string; claimBId: string; relation: 'supports' | 'contradicts' | 'refines' | 'unrelated'; note: string }> = [];
    for (const raw of parsed.relations as unknown[]) {
      const r = raw as { claimAId?: unknown; claimBId?: unknown; relation?: unknown; note?: unknown };
      const a = typeof r.claimAId === 'string' ? r.claimAId : '';
      const b = typeof r.claimBId === 'string' ? r.claimBId : '';
      const rel = typeof r.relation === 'string' ? r.relation : '';
      if (!claimIds.has(a) || !claimIds.has(b) || !validRelations.has(rel) || a === b) continue;
      result.push({
        claimAId: a,
        claimBId: b,
        relation: rel as 'supports' | 'contradicts' | 'refines' | 'unrelated',
        note: typeof r.note === 'string' ? r.note.slice(0, 240) : ''
      });
    }
    return result;
  } catch {
    return [];
  }
}

function extractTextFromSynthesis(synth: TopicSynthesis): string {
  return [synth.definition, synth.overview, ...synth.keyPoints.map((k) => `${k.title}\n${k.content}`)].join('\n\n');
}

async function getSupportChunks(chunkIds: (string | null)[]): Promise<SupportChunk[]> {
  const ids = chunkIds.filter((x): x is string => !!x);
  if (ids.length === 0) return [];
  const rows = await db.execute<any>(sql`
    SELECT dc.id, dc.content, dc.page_id AS page_id, p.content_version AS content_version
    FROM document_chunks dc
    JOIN pages p ON p.id = dc.page_id
    WHERE dc.id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
  `);
  return rows.rows.map((r: { id: string; content: string; page_id: string; content_version: number }) => ({
    chunkId: r.id,
    pageId: r.page_id,
    content: r.content,
    contentVersion: r.content_version
  }));
}

async function refreshTopicEvidenceCentroid(topicId: string): Promise<void> {
  const rows = await db.execute<any>(sql`SELECT dc.embedding FROM topic_sources ts JOIN document_chunks dc ON dc.id = ts.chunk_id WHERE ts.topic_id = ${topicId}::uuid AND dc.embedding IS NOT NULL`);
  const vectors = rows.rows.map((row: { embedding: unknown }) => parseVector(row.embedding)).filter((value): value is number[] => !!value);
  if (vectors.length === 0) return;
  const centroid = vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length);
  await db.update(wikiTopics).set({ evidenceCentroid: sql`${vectorToSqlLiteral(centroid)}::vector`, evidenceCount: vectors.length, updatedAt: sql`now()` }).where(eq(wikiTopics.id, topicId));
}

async function getChunkEmbedding(chunkId: string | null): Promise<number[] | null> {
  if (!chunkId) return null;
  const rows = await db.execute<any>(sql`SELECT embedding FROM document_chunks WHERE id = ${chunkId}::uuid LIMIT 1`);
  const emb = rows.rows[0]?.embedding;
  return Array.isArray(emb) ? (emb as number[]) : null;
}

/**
 * Phase 3 (E4 "保存成功后将 Topic 写入全文和向量索引") — materialise the Topic as
 * `document_chunks` (topic_id set, page_id null) so `hybridSearch` / RAG can
 * retrieve it. Idempotent: old topic chunks are cleared first.
 */
export async function indexTopicForSearch(
  topic: { id: string; workspaceId: string; spaceId: string; title: string },
  synth: TopicSynthesis,
  ai: AiProvider
): Promise<void> {
  const embModel = env.AI_EMBEDDING_MODEL;
  const dim = env.EMBEDDING_DIMENSION;
  const items: any[] = [];
  // Compute embeddings FIRST. If embedding fails we bail out and keep the
  // existing index untouched, so the Topic never vanishes from search / RAG
  // (gate: 索引更新失败不丢旧数据 — 老 chunk 仍可搜到).
  for (let i = 0; i < synth.keyPoints.length; i++) {
    const kp = synth.keyPoints[i];
    const text = `${kp.title}\n${kp.content}`;
    const emb = await ai.embed(text);
    items.push({
      workspaceId: topic.workspaceId,
      spaceId: topic.spaceId,
      pageId: null,
      topicId: topic.id,
      chunkIndex: i,
      title: topic.title,
      content: text.slice(0, 2000),
      ftsTokens: tokenizeChineseFriendly(text),
      embedding: emb ? sql`${vectorToSqlLiteral(emb)}::vector` : null,
      embeddingModel: embModel,
      embeddingDimension: dim
    });
  }
  // Atomically swap old chunks for new ones inside a transaction: on insert
  // failure the whole thing rolls back and the old chunks remain retrievable.
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM document_chunks WHERE topic_id = ${topic.id}::uuid`);
    if (items.length > 0) await tx.insert(documentChunks).values(items);
  });
}

// LLM fuzzy judgment for the "ambiguous band" of embedding similarity. Returns
// 'separate' by default — including when the (mock) provider yields no parseable
// JSON — so we err on the side of NOT merging (gate: 同名异义不误合并).
async function fuzzyMergeDecision(a: { title: string; summary: string }, b: { title: string; summary: string }, ai: AiProvider): Promise<'merge' | 'separate'> {
  try {
    const out = await ai.generateText([
      {
        role: 'system',
        content: '判断两个主题是否指同一概念。只输出 JSON：{"decision":"merge"|"separate"}。'
      },
      {
        role: 'user',
        content: `A 标题：${a.title}\nA 摘要：${a.summary}\n\nB 标题：${b.title}\nB 摘要：${b.summary}`
      }
    ]);
    const parsed = extractJson(out) as { decision?: unknown };
    if (parsed && (parsed.decision === 'merge' || parsed.decision === 'separate')) return parsed.decision;
  } catch {
    /* default to separate */
  }
  return 'separate';
}

async function createMergeSuggestion(spaceId: string, a: { id: string; title: string }, b: { id: string; title: string }) {
  if (await hasPendingSuggestion(spaceId, 'topic_merge', { candidateId: a.id })) return;
  await db.execute(sql`
    INSERT INTO llm_suggestions(workspace_id, space_id, page_id, topic_id, type, risk, status, payload, evidence)
    VALUES (
      (SELECT workspace_id FROM spaces WHERE id = ${spaceId}::uuid),
      ${spaceId}, NULL, NULL, 'topic_merge', 'medium', 'pending',
      ${JSON.stringify({
        candidateId: a.id, otherCandidateId: b.id,
        titleA: a.title, titleB: b.title,
        changes: `建议合并「${a.title}」与「${b.title}」`,
        reason: '两候选语义高度相似，建议合并为同一主题。',
        evidence: { titleA: a.title, titleB: b.title }
      })}::jsonb,
      ${JSON.stringify({ titleA: a.title, titleB: b.title })}::jsonb
    )
  `);
}

/**
 * Phase 3 (E2) — the Space clustering job. Aggregates `topic_candidates` into
 * formal Topics without ever asking the LLM to compare every pair:
 *   1. normalize titles (alias / synonym grouping)  -> 同义可聚合
 *   2. within a group, same-name / different-meaning (low overlap) is NOT merged
 *   3. cross-title embedding similarity -> merge suggestion (LLM only in band)
 *   4. TopicCreationPolicy decides if a cluster may become a Draft
 *   5. synthesis is generated + validated, then the Topic is indexed
 * Candidates that lack sufficient evidence stay as candidates (no Topic).
 */
export async function consolidateCandidates(
  spaceId: string,
  ai: AiProvider,
  onProgress?: (p: { done: number; total: number; stage: string }) => void | Promise<void>
): Promise<{ createdTopics: number; mergeSuggestions: number }> {
  const candidates = await db
    .select()
    .from(topicCandidates)
    .where(and(eq(topicCandidates.spaceId, spaceId), eq(topicCandidates.status, 'candidate')));
  if (candidates.length === 0) return { createdTopics: 0, mergeSuggestions: 0 };

  // Phase B (B1.2): bound the O(n^2) clustering cost so a large Space cannot
  // hang the worker. Extra candidates stay as candidates for the next run.
  const MAX_CANDIDATES = 500;
  if (candidates.length > MAX_CANDIDATES) {
    logger.warn('consolidate candidates exceeds cap, clustering head only', {
      spaceId,
      count: candidates.length,
      cap: MAX_CANDIDATES
    });
    candidates.length = MAX_CANDIDATES;
  }

  // Phase B (B1.1): load synonym map so "ML" / "机器学习" group together.
  const synMap = await getSynonymMap(spaceId);
  const norm = (t: string) => applySynonyms(t, synMap);

  // Existing accepted topics keyed by normalized title -> link candidates to them.
  const existing = await db.select().from(wikiTopics).where(eq(wikiTopics.spaceId, spaceId));
  const existingByNorm = new Map<string, (typeof existing)[number]>();
  for (const t of existing) {
    const key = norm(t.title);
    if (!existingByNorm.has(key)) existingByNorm.set(key, t);
    for (const al of t.aliases ?? []) {
      const ak = norm(al);
      if (!existingByNorm.has(ak)) existingByNorm.set(ak, t);
    }
  }

  // Group candidates by normalized title (alias / synonym aggregation).
  const titleGroups = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const key = norm(c.title);
    if (!titleGroups.has(key)) titleGroups.set(key, []);
    titleGroups.get(key)!.push(c);
  }

  // Phase B (B1.2): embedding-dominated clustering.
  //  - Hard group by normalized (synonym-aware) title: identical / synonym
  //    titles are always one cluster (cheap, deterministic).
  //  - Merge ACROSS title groups using the candidates' title embeddings:
  //    cosine >= EMBED_MERGE (0.78) merges directly; the ambiguous band
  //    [EMBED_LLM_BAND, 0.78) is resolved by the LLM fuzzy judge; below the
  //    band they stay separate. This lets "机器学习" and "机器智能" (no synonym
  //    entry) consolidate into ONE Topic — the core fix for "一篇出很多 topic".
  //  - "Same source page" remains the strongest deterministic merge signal.
  const EMBED_MERGE = 0.78;
  const EMBED_LLM_BAND = 0.6;

  const groupList = [...titleGroups.values()];
  const parent = groupList.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (x: number, y: number) => { const rx = find(x); const ry = find(y); if (rx !== ry) parent[ry] = rx; };

  // Representative embedding for a group: first member with a stored title
  // embedding, else best-effort fallback to a member's chunk embedding.
  const groupRepEmbedding = async (g: typeof candidates): Promise<number[] | null> => {
    for (const c of g) {
      const e = parseVector(c.titleEmbedding);
      if (e) return e;
    }
    for (const c of g) {
      const e = await getChunkEmbedding(c.chunkId);
      if (e) return e;
    }
    return null;
  };

  for (let i = 0; i < groupList.length; i++) {
    for (let j = i + 1; j < groupList.length; j++) {
      const a = groupList[i];
      const b = groupList[j];
      // Plan 04-C: page co-location is not semantic equivalence. Facets from the same page stay separate unless title/evidence similarity passes a real gate.
      const ea = await groupRepEmbedding(a);
      const eb = await groupRepEmbedding(b);
      if (!ea || !eb) continue; // no embedding signal -> keep title groups only
      const sim = cosineSimilarity(ea, eb);
      if (sim >= EMBED_MERGE) { union(i, j); continue; }
      if (sim >= EMBED_LLM_BAND) {
        const d = await fuzzyMergeDecision(
          { title: a[0].title, summary: a[0].summary },
          { title: b[0].title, summary: b[0].summary },
          ai
        );
        if (d === 'merge') union(i, j);
      }
    }
  }
  const merged = new Map<number, typeof candidates>();
  groupList.forEach((g, i) => {
    const r = find(i);
    if (!merged.has(r)) merged.set(r, []);
    merged.get(r)!.push(...g);
  });
  // Key the consolidated groups by the normalized (synonym-aware) title of their first member.
  const groups = new Map<string, typeof candidates>();
  for (const g of merged.values()) {
    const key = norm(g[0].title);
    if (!groups.has(key)) groups.set(key, g);
    else groups.get(key)!.push(...g);
  }

  // Phase B (B1.3): report clustering progress so an async worker can surface
  // it on the job (the UI polls /api/jobs/:id). Total = number of clusters.
  const totalGroups = groups.size;
  await onProgress?.({ done: 0, total: totalGroups, stage: 'clustering' });

  let createdTopics = 0;
  let mergeSuggestions = 0;

  const groupEntries = [...groups.entries()];
  for (let gi = 0; gi < groupEntries.length; gi++) {
    const [normKey, group] = groupEntries[gi];
    await onProgress?.({ done: gi, total: totalGroups, stage: 'creating' });
    // Already have a Topic for this concept -> link candidates to it.
    // F14: check ALL normalized titles in the group (not just the first),
    // because merged groups may contain multiple distinct titles that all
    // map to the same existing Topic via synonym normalization.
    let existingTopic = existingByNorm.get(normKey);
    if (!existingTopic) {
      for (const c of group) {
        const altKey = norm(c.title);
        const found = existingByNorm.get(altKey);
        if (found) { existingTopic = found; break; }
      }
    }
    if (existingTopic) {
      for (const c of group) {
        await db
          .insert(topicSources)
          .values({ topicId: existingTopic.id, pageId: c.pageId, chunkId: c.chunkId, addedBy: 'ai', contributionType: 'key_point', sourceContentVersion: null })
          .onConflictDoNothing();
        await db.update(topicCandidates).set({ status: 'promoted', promotedTopicId: existingTopic.id, updatedAt: sql`now()` }).where(eq(topicCandidates.id, c.id));
      }
      // P0-4: bind this group's Claims to the existing Topic (update_existing).
      const existingGroupPageIds = [...new Set(group.map((c) => c.pageId))];
      const existingGroupBundles = await getClaimBundlesForPages(existingGroupPageIds);
      if (existingGroupBundles.length > 0) {
        try {
          await persistTopicClaims(existingTopic.id, existingTopic.workspaceId, existingTopic.spaceId, existingGroupBundles.map((b) => b.claimId), 'update_existing');
        } catch (err) {
          logger.warn('persistTopicClaims failed (consolidateCandidates existing)', { topicId: existingTopic.id, err: err instanceof Error ? err.message : String(err) });
        }
      }
      await refreshTopicEvidenceCentroid(existingTopic.id);
      continue;
    }

    const distinctPages = new Set(group.map((c) => c.pageId));
    // Count *distinct* supporting chunks, not candidate count. A cluster whose
    // candidates all cite the same chunk is single-chunk evidence and must not
    // be promoted to a Topic (that produced the "one article -> many thin
    // Topics" symptom).
    const validChunks = new Set(group.map((c) => c.chunkId).filter(Boolean)).size;
    // P0-4/P0-7: fetch Claim bundles early so decideTopicCreation can use the
    // Claim-Evidence count as an alternate evidence-strength signal (a single
    // page may legitimately produce a Topic when backed by >=2 Claim bundles,
    // each carrying its own Evidence chunk).
    const groupPageIds = [...new Set(group.map((c) => c.pageId))];
    const claimBundles = await getClaimBundlesForPages(groupPageIds);
    const decision = decideTopicCreation({
      candidateCount: group.length,
      distinctPageCount: distinctPages.size,
      validChunkCount: validChunks,
      claimCount: claimBundles.length
    });
    if (decision === 'none') continue; // insufficient evidence -> keep candidate

    // Gate: same-name / different-meaning must NOT be merged into one Topic.
    // Only enforce this for a *single shared title* spanning multiple distinct
    // pages (the homonym risk). A group merged from one page's facets, or one
    // with several distinct titles, is a legitimate multi-facet synthesis, not
    // a homonym collision — so we don't reject it for low overlap.
    const support = await getSupportChunks(group.map((c) => c.chunkId));
    const distinctTitles = new Set(group.map((c) => normalizeTitle(c.title)));
    if (distinctTitles.size === 1 && distinctPages.size > 1 && support.length >= 2) {
      const ov = groupSemanticOverlap(support);
      if (ov < 0.15) continue; // same name, different meaning -> keep separate
    }
    if (support.length === 0) continue;

    // P0-4: prefer Claim-Evidence synthesis; fall back to chunk-only.
    const synthesisResult = claimBundles.length > 0
      ? await generateTopicSynthesisFromClaims(claimBundles, ai)
      : await generateTopicSynthesis(support, ai);
    const isReady = synthesisResult.status === 'ready';
    const topicPayload = isReady
      ? {
          contentJson: synthesisResult.synthesis as unknown,
          textContent: extractTextFromSynthesis(synthesisResult.synthesis),
          status: 'suggested' as const,
          aiSummary: synthesisResult.synthesis.definition || synthesisResult.synthesis.overview.slice(0, 200),
          synthesisVersion: 'topic-synthesis-v1',
          synthesisStatus: 'ready' as const,
          qualityIssues: synthesisResult.diagnostics.qualityIssues,
          synthesisDiagnostics: synthesisResult.diagnostics
        }
      : {
          contentJson: { schemaVersion: 'topic-synthesis-failed-v1', error: synthesisResult.error, evidencePreview: synthesisResult.evidencePreview } as unknown,
          textContent: '',
          status: 'synthesis_failed' as const,
          aiSummary: synthesisResult.error,
          synthesisVersion: 'topic-synthesis-failed-v1',
          synthesisStatus: 'failed' as const,
          qualityIssues: synthesisResult.diagnostics.qualityIssues,
          synthesisDiagnostics: synthesisResult.diagnostics
        };

    const [topic] = await db
      .insert(wikiTopics)
      .values({
        workspaceId: group[0].workspaceId,
        spaceId: group[0].spaceId,
        title: group[0].title,
        source: 'ai_generated',
        aliases: [normKey],
        normalizedTitle: normKey,
        ...topicPayload,
        publicationStatus: 'draft',
        freshnessStatus: 'fresh',
        lifecycleStatus: 'active'
      })
      .returning();

    for (const c of group) {
      await db
        .insert(topicSources)
        .values({
          topicId: topic.id,
          pageId: c.pageId,
          chunkId: c.chunkId,
          addedBy: 'ai',
          contributionType: 'key_point',
          evidenceExcerpt: (c.summary || '').slice(0, 200),
          sourceContentVersion: null
        })
        .onConflictDoNothing();
      await db.update(topicCandidates).set({ status: 'promoted', promotedTopicId: topic.id, updatedAt: sql`now()` }).where(eq(topicCandidates.id, c.id));
    }

    // P0-4: persist Topic <-> Claim bindings (newly created -> create_emerging).
    if (claimBundles.length > 0) {
      try {
        await persistTopicClaims(topic.id, group[0].workspaceId, group[0].spaceId, claimBundles.map((b) => b.claimId), 'create_emerging');
      } catch (err) {
        logger.warn('persistTopicClaims failed (consolidateCandidates new)', { topicId: topic.id, err: err instanceof Error ? err.message : String(err) });
      }
    }

    await refreshTopicEvidenceCentroid(topic.id);
    if (isReady) await indexTopicForSearch(topic, synthesisResult.synthesis, ai);

    // Surface a draft suggestion (medium risk) so the user reviews / accepts it.
    if (!(await hasPendingSuggestion(spaceId, 'topic_draft', { candidateId: group[0].id }))) {
      await db.execute(sql`
        INSERT INTO llm_suggestions(workspace_id, space_id, page_id, topic_id, type, risk, status, payload, evidence)
        VALUES (
          ${topic.workspaceId}, ${topic.spaceId}, NULL, ${topic.id}, 'topic_draft', 'medium', 'pending',
          ${JSON.stringify({
            topicId: topic.id, topicTitle: topic.title,
            changes: `综合候选生成主题「${topic.title}」`,
            reason: '多个候选聚合为该主题，请审阅综合内容。',
            evidence: { candidateCount: group.length }
          })}::jsonb,
          ${JSON.stringify({ candidateCount: group.length })}::jsonb
        )
      `);
    }
    createdTopics++;
  }

  // Cross-title embedding similarity -> merge suggestions (LLM only in band).
  const distinct = [...groups.values()].map((g) => g[0]);
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      const a = distinct[i];
      const b = distinct[j];
      const ea = await getChunkEmbedding(a.chunkId);
      const eb = await getChunkEmbedding(b.chunkId);
      const sim = cosineSimilarity(ea, eb);
      if (sim >= 0.8) {
        await createMergeSuggestion(spaceId, { id: a.id, title: a.title }, { id: b.id, title: b.title });
        mergeSuggestions++;
      } else if (sim >= 0.5) {
        const d = await fuzzyMergeDecision(
          { title: a.title, summary: a.summary },
          { title: b.title, summary: b.summary },
          ai
        );
        if (d === 'merge') {
          await createMergeSuggestion(spaceId, { id: a.id, title: a.title }, { id: b.id, title: b.title });
          mergeSuggestions++;
        }
      }
    }
  }

  return { createdTopics, mergeSuggestions };
}

/* ----------------------------------------------------- main entry point ---- */

export async function generateWikiArtifacts(
  page: { id: string; workspace_id: string; space_id: string; title: string; text_content: string; updated_by_id: string },
  ai: AiProvider
): Promise<void> {
  const text = page.text_content || '';
  if (text.trim().length < 10) return; // nothing meaningful to derive

  // P0-3 (LLM wiki优化.md): Page Map 是唯一上游。Topic 候选从 Facets/Claims
  // 派生，不再直接读取原文 text.slice(0, 4000)。
  const knowledgeMap = await generatePageKnowledgeArtifacts(page.id);
  const facets = knowledgeMap?.facets ?? [];
  const claimRows = await db
    .select({ text: knowledgeClaims.text, sectionAnchor: knowledgeClaims.sectionAnchor })
    .from(knowledgeClaims)
    .where(eq(knowledgeClaims.pageId, page.id))
    .orderBy(sql`created_at DESC`)
    .limit(30);
  const claims = claimRows.map((r) => ({ text: r.text, sectionAnchor: r.sectionAnchor }));

  const candidates = (await aiTopicsFromFacets(facets, claims, page.title, ai))
    ?? heuristicTopics(text);
  if (candidates.length === 0) return;

  // Phase 2 (D3): structured Page Profile (deterministic, no extra AI call).
  const profile = buildPageProfile(text, page.title);

  // Supporting chunks for this page — each candidate references its best-match
  // chunk so the Candidate UI can show provenance (gate: "Candidate 有 Chunk 引用").
  const chunkRows = await db.execute<any>(sql`
    SELECT id, content, embedding FROM document_chunks WHERE page_id = ${page.id} ORDER BY chunk_index
  `);
  const chunks = chunkRows.rows.map((r: { id: string; content: string; embedding?: unknown }) => ({
    id: r.id,
    content: r.content,
    embedding:
      typeof r.embedding === 'string'
        ? (() => { try { return JSON.parse(r.embedding); } catch { return null; } })()
        : (r.embedding as number[] | null) ?? null
  }));

  // Embed candidate titles once (batched) so we can match each to its real
  // section chunk semantically, instead of all collapsing onto the overview.
  let candEmbs: (number[] | null)[] | null = null;
  try {
    candEmbs = await ai.embedBatch(candidates.map((c) => `${c.title} ${c.summary}`));
  } catch {
    candEmbs = null;
  }

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    // Phase 2 (D2): a page only produces *candidates*, never formal Topics.
    // Formal Topics are created later by promotion / Phase 3 clustering, so a
    // single short page never spawns multiple published Topics.
    const chunkId = await pickSupportingChunk(chunks, cand, candEmbs?.[i] ?? null);
    const emb = candEmbs?.[i] ?? null;
    const [candidate] = await db.insert(topicCandidates).values({
      workspaceId: page.workspace_id,
      spaceId: page.space_id,
      pageId: page.id,
      chunkId,
      title: cand.title,
      summary: cand.summary,
      profile: { ...profile, summary: cand.summary || profile.summary },
      status: 'candidate',
      // Phase B (B1.2): persist the title embedding so clustering can be
      // embedding-dominated without recomputing it here.
      titleEmbedding: emb ? sql`${vectorToSqlLiteral(emb)}::vector` : null
    }).returning();

    // Surface a candidate suggestion (medium risk) so the user can review /
    // promote it in the UI. candidateId lives in the payload (no schema change).
    if (!(await hasPendingSuggestion(page.space_id, 'topic_candidate', { candidateId: candidate.id }))) {
      await db.execute(sql`
        INSERT INTO llm_suggestions(workspace_id, space_id, page_id, topic_id, type, risk, status, payload, evidence)
        VALUES (
          ${page.workspace_id}, ${page.space_id}, ${page.id}, NULL, 'topic_candidate', 'medium', 'pending',
          ${JSON.stringify({
            candidateId: candidate.id, candidateTitle: cand.title, candidateSummary: cand.summary,
            sourcePageId: page.id, chunkId,
            changes: `候选主题「${cand.title}」`,
            reason: cand.summary || 'AI 从笔记中提炼出的候选主题，审阅后可晋升为正式知识主题。',
            evidence: { sourcePageId: page.id, chunkId }
          })}::jsonb,
          ${JSON.stringify({ sourcePageId: page.id })}::jsonb
        )
      `);
    }
  }

  // Cross-link suggestions: propose linking this page to other pages in the
  // same space that share a meaningful term overlap.
  const others = await db.execute<any>(sql`
    SELECT id, title, text_content FROM pages
    WHERE space_id = ${page.space_id} AND id <> ${page.id} AND status = 'normal'
    ORDER BY updated_at DESC LIMIT 30
  `);
  const baseTerms = termSet(text);
  if (baseTerms.size === 0) return;

  let linksCreated = 0;
  for (const other of others.rows) {
    if (linksCreated >= 3) break;
    const ov = overlap(baseTerms, termSet(other.text_content || ''));
    if (ov < 0.12) continue;
    if (await hasPendingSuggestion(page.space_id, 'cross_link', { targetPageId: other.id })) continue;
    await db.execute(sql`
      INSERT INTO llm_suggestions(workspace_id, space_id, page_id, topic_id, type, risk, status, payload, evidence)
      VALUES (
        ${page.workspace_id}, ${page.space_id}, ${page.id}, NULL, 'cross_link', 'low', 'pending',
        ${JSON.stringify({
          sourcePageId: page.id, targetPageId: other.id, targetPageTitle: other.title,
          reason: '内容主题高度相关', sharedTerms: [],
          changes: `在本页与「${other.title}」之间建立双向链接`,
          evidence: { overlap: Number(ov.toFixed(2)) }
        })}::jsonb,
        ${JSON.stringify({ overlap: Number(ov.toFixed(2)) })}::jsonb
      )
    `);
    // M6: page <-> page related edge, weighted by term overlap.
    await upsertEdge({
      workspaceId: page.workspace_id, spaceId: page.space_id,
      sourceType: 'page', sourceId: page.id, targetType: 'page', targetId: other.id,
      relationType: 'related', confidence: Math.round(ov * 100), evidence: { overlap: Number(ov.toFixed(2)), reason: '内容主题高度相关' }
    });
    linksCreated++;
  }
}

/* ------------------------------------------- candidate promotion ----- */

/**
 * Phase 2 (D2): promote a reviewed Candidate into a formal Topic. This is the
 * only path that creates a `wiki_topics` row from a page — and it is an explicit
 * user action, never an automatic side-effect of page processing. The candidate
 * keeps a `promotedTopicId` back-reference for audit/traceability, and its
 * supporting chunk is recorded in `topic_sources`.
 */
export async function promoteCandidate(candidateId: string, userId: string): Promise<{ topicId: string }> {
  const [cand] = await db.select().from(topicCandidates).where(eq(topicCandidates.id, candidateId)).limit(1);
  if (!cand) throw new Error('candidate not found');
  if (cand.status === 'promoted' && cand.promotedTopicId) return { topicId: cand.promotedTopicId };

  // Phase 3 consolidation for promotion: a page often produces multiple facet
  // candidates. Promoting one should synthesize ONE rich Topic from the whole
  // page's evidence, not a single-chunk thin Topic.
  // Phase B (B1.4): only promote the selected candidate + its *synonym-cluster*
  // mates (candidates that resolve to the same normalized concept), NOT every
  // candidate on the page. The remaining candidates stay as candidates for
  // later clustering instead of being force-merged into one Topic.
  const synMap = await getSynonymMap(cand.workspaceId);
  const selectedNorm = applySynonyms(cand.title, synMap);
  const pageCands = await db
    .select()
    .from(topicCandidates)
    .where(and(eq(topicCandidates.pageId, cand.pageId), eq(topicCandidates.status, 'candidate')));
  const siblings = pageCands.filter((c) => applySynonyms(c.title, synMap) === selectedNorm);

  const siblingIds = siblings.map((c) => c.id);
  const chunkIds = siblings.map((c) => c.chunkId).filter((x): x is string => !!x);
  const support = chunkIds.length > 0 ? await getSupportChunks(chunkIds) : [];

  // P0-1 (LLM wiki优化.md): unified adoption path — promoteCandidate MUST go
  // through the same LLM synthesis + quality gate as consolidateCandidates.
  // The original-text concatenation fallback (buildDeterministicSynthesis) is
  // no longer used for formal Topic content. When LLM synthesis fails, we
  // persist the evidence preview and mark the Topic synthesis_failed instead
  // of filling Definition/Overview/KeyPoints with raw chunk slices.
  const ai = await createAiProviderForContext({ workspaceId: cand.workspaceId, spaceId: cand.spaceId });
  // P0-4 (LLM wiki优化.md): prefer Claim-Evidence synthesis. Collect Claims
  // from sibling pages, each carrying its own Evidence. Falls back to chunk-
  // only synthesis when the page has not yet produced a Page Knowledge Map.
  const siblingPageIds = [...new Set(siblings.map((s) => s.pageId))];
  const claimBundles = await getClaimBundlesForPages(siblingPageIds);
  const synthesisResult = claimBundles.length > 0
    ? await generateTopicSynthesisFromClaims(claimBundles, ai)
    : support.length > 0
      ? await generateTopicSynthesis(support, ai)
      : { status: 'failed' as const, error: '没有可用于综合的证据', evidencePreview: [], diagnostics: synthesisDiagnostics([], 0) };

  const isReady = synthesisResult.status === 'ready';
  const [topic] = await db.insert(wikiTopics).values({
    workspaceId: cand.workspaceId,
    spaceId: cand.spaceId,
    title: cand.title,
    contentJson: (isReady ? synthesisResult.synthesis : { schemaVersion: 'topic-synthesis-failed-v1', error: synthesisResult.error, evidencePreview: synthesisResult.evidencePreview }) as unknown,
    textContent: isReady ? extractTextFromSynthesis(synthesisResult.synthesis) : '',
    status: isReady ? 'accepted' : 'synthesis_failed',
    source: 'ai_generated',
    aiSummary: isReady ? (synthesisResult.synthesis.definition || cand.summary) : synthesisResult.error,
    aliases: [normalizeTitle(cand.title)],
    normalizedTitle: normalizeTitle(cand.title),
    synthesisVersion: isReady ? 'topic-synthesis-v1' : 'topic-synthesis-failed-v1',
    synthesisStatus: isReady ? 'ready' : 'failed',
    qualityIssues: synthesisResult.diagnostics.qualityIssues,
    synthesisDiagnostics: synthesisResult.diagnostics,
    createdById: userId,
    // Phase 1 (D4): a user-promoted topic is published, fresh and active.
    // P0-1: when synthesis fails the topic stays as draft until retry.
    publicationStatus: isReady ? 'accepted' : 'draft',
    freshnessStatus: 'fresh',
    lifecycleStatus: 'active'
  }).returning();

  // Record every sibling chunk as a source of the consolidated Topic.
  for (const c of siblings) {
    if (c.chunkId) {
      await db.insert(topicSources).values({
        topicId: topic.id, pageId: c.pageId, chunkId: c.chunkId, addedBy: 'ai', contributionType: 'key_point'
      }).onConflictDoNothing();
    }
  }

  // M6: the topic "covers" the page it was derived from -> a graph edge.
  await upsertEdge({
    workspaceId: cand.workspaceId, spaceId: cand.spaceId,
    sourceType: 'topic', sourceId: topic.id, targetType: 'page', targetId: cand.pageId,
    relationType: 'covers', confidence: 70, evidence: { generatedFrom: cand.title, fromCandidate: cand.id }
  });

  // Mark all sibling candidates as promoted into this single Topic.
  if (siblingIds.length > 0) {
    await db.execute(sql`
      UPDATE topic_candidates
      SET status = 'promoted', promoted_topic_id = ${topic.id}, updated_at = now()
      WHERE id = ANY(ARRAY[${sql.join(siblingIds.map((id) => sql`${id}::uuid`), sql`, `)}])
    `);
  }

  // Resolve pending candidate suggestions for all siblings.
  if (siblingIds.length > 0) {
    await db.execute(sql`
      UPDATE llm_suggestions SET status = 'ignored', updated_at = now()
      WHERE type = 'topic_candidate' AND status = 'pending'
        AND payload ->> 'candidateId' = ANY(ARRAY[${sql.join(siblingIds.map((id) => sql`${id}::text`), sql`, `)}])
    `);
  }

  // Index the consolidated Topic for RAG / full-text retrieval.
  // P0-1: only index when synthesis succeeded — a failed synthesis has no
  // keyPoints to embed, and indexing raw chunk slices would pollute search.
  if (isReady) {
    try {
      await indexTopicForSearch(topic, synthesisResult.synthesis, ai);
    } catch {
      /* indexing is best-effort; the Topic already exists */
    }
  }

  // P0-4: persist Topic <-> Claim bindings (newly created Topic -> create_emerging).
  if (claimBundles.length > 0) {
    try {
      await persistTopicClaims(topic.id, cand.workspaceId, cand.spaceId, claimBundles.map((b) => b.claimId), 'create_emerging');
    } catch (err) {
      logger.warn('persistTopicClaims failed (promoteCandidate)', { topicId: topic.id, err: err instanceof Error ? err.message : String(err) });
    }
  }

  return { topicId: topic.id };
}

/** Dismiss a candidate (user rejects it) and resolve its pending suggestion. */
export async function dismissCandidate(candidateId: string): Promise<void> {
  await db.update(topicCandidates)
    .set({ status: 'dismissed', updatedAt: sql`now()` })
    .where(eq(topicCandidates.id, candidateId));
  await db.execute(sql`
    UPDATE llm_suggestions SET status = 'ignored', updated_at = now()
    WHERE payload ->> 'candidateId' = ${candidateId}::text AND type = 'topic_candidate' AND status = 'pending'
  `);
}

/* ------------------------------------------- stale / refresh / undo ----- */

/**
 * M5 — when a source page is re-processed, any AI-derived *accepted* topic
 * that depends on it becomes potentially outdated. Per the "trustworthy AI"
 * rule we must NOT silently overwrite the topic: instead we flag it `stale`
 * and surface a `stale_topic` suggestion so the user can refresh on purpose.
 *
 * Topics with `update_policy = 'auto_update'` are excluded — those are
 * regenerated by the refresh job rather than flagged.
 */
export async function markTopicsStaleForPage(pageId: string): Promise<void> {
  const rows = await db.execute<any>(sql`
    SELECT t.id, t.title, t.space_id, t.workspace_id
    FROM wiki_topics t
    JOIN topic_sources ts ON ts.topic_id = t.id
    WHERE ts.page_id = ${pageId}
      AND t.source = 'ai_generated'
      AND t.status IN ('accepted', 'user_edited')
      AND t.update_policy <> 'auto_update'
  `);
  for (const t of rows.rows) {
    // Phase 1 (D4): stale is a *freshness* axis, orthogonal to lifecycle.
    await db.execute(sql`UPDATE wiki_topics SET status = 'stale', freshness_status = 'stale', updated_at = now() WHERE id = ${t.id}`);

    const existing = await db.execute<any>(sql`
      SELECT 1 FROM llm_suggestions
      WHERE space_id = ${t.space_id} AND type = 'stale_topic' AND status = 'pending'
        AND payload ->> 'topicId' = ${t.id}::text
      LIMIT 1
    `);
    if (existing.rows.length > 0) continue;

    const pageRes = await db.execute<any>(sql`SELECT title FROM pages WHERE id = ${pageId} LIMIT 1`);
    const page = pageRes.rows[0];
    await db.execute(sql`
      INSERT INTO llm_suggestions(workspace_id, space_id, page_id, topic_id, type, risk, status, payload, evidence)
      VALUES (
        ${t.workspace_id}, ${t.space_id}, ${pageId}, ${t.id}, 'stale_topic', 'low', 'pending',
        ${JSON.stringify({
          topicId: t.id, topicTitle: t.title, sourcePageId: pageId, sourcePageTitle: page?.title ?? '',
          changes: `主题「${t.title}」的源笔记已更新，内容可能过时`,
          reason: `源笔记「${page?.title ?? ''}」已重新整理，建议重新生成该主题`,
          evidence: { sourcePageId: pageId, sourcePageTitle: page?.title ?? '' }
        })}::jsonb,
        ${JSON.stringify({ sourcePageId: pageId, sourcePageTitle: page?.title ?? '' })}::jsonb
      )
    `);
  }
}

/**
 * Revert an accepted suggestion. Restores the suggestion to `pending` and
 * undoes the side-effect it caused when accepted:
 *   - topic_proposal -> topic back to `suggested` (unless another accepted
 *     proposal still references it)
 *   - cross_link      -> the confirmed related edge back to `suggested`
 * This is what powers the per-suggestion "撤销" (undo) action so that every
 * AI-driven modification stays reversible.
 */
export async function undoSuggestion(id: string): Promise<void> {
  const [s] = await db.select().from(llmSuggestions).where(eq(llmSuggestions.id, id)).limit(1);
  if (!s || s.status !== 'accepted') return;
  await db.execute(sql`UPDATE llm_suggestions SET status = 'pending', updated_at = now() WHERE id = ${id}`);

  const p = (s.payload ?? {}) as { topicId?: string; sourcePageId?: string; targetPageId?: string };
  if (s.type === 'topic_proposal' && p.topicId) {
    const others = await db.execute<any>(sql`
      SELECT 1 FROM llm_suggestions
      WHERE topic_id = ${p.topicId} AND type = 'topic_proposal' AND status = 'accepted' AND id <> ${id}
      LIMIT 1
    `);
    if (others.rows.length === 0) {
      await db.execute(sql`UPDATE wiki_topics SET status = 'suggested', updated_at = now() WHERE id = ${p.topicId}`);
    }
  } else if (s.type === 'cross_link' && p.sourcePageId && p.targetPageId) {
    await db.execute(sql`
      UPDATE knowledge_edges SET status = 'suggested', updated_at = now()
      WHERE source_type = 'page' AND source_id = ${p.sourcePageId}
        AND target_type = 'page' AND target_id = ${p.targetPageId}
        AND relation_type = 'related' AND status = 'confirmed'
    `);
  }
}

/* ------------------------------------------- Phase 4: refresh diff ---------- */

// Load the current source pages that back a topic (used to (re)generate a
// synthesis / diff from the *live* corpus rather than stale snapshot text).
async function getTopicSourcePages(topicId: string): Promise<{ id: string; title: string; textContent: string; contentVersion: number }[]> {
  const rows = await db.execute<any>(sql`
    SELECT p.id, p.title, p.text_content AS text_content, p.content_version AS content_version
    FROM topic_sources ts
    JOIN pages p ON p.id = ts.page_id
    WHERE ts.topic_id = ${topicId}
    ORDER BY p.updated_at DESC
  `);
  return rows.rows.map((r: { id: string; title: string; text_content: string; content_version: number }) => ({
    id: r.id, title: r.title, textContent: r.text_content, contentVersion: r.content_version
  }));
}

// Build the supporting chunks for a topic from its *current* source pages, so a
// refresh diff is grounded in the real, up-to-date corpus (spec E5).
async function getTopicSupportChunks(topicId: string): Promise<{ support: SupportChunk[]; pages: { id: string; title: string }[] }> {
  const pages = await getTopicSourcePages(topicId);
  if (pages.length === 0) return { support: [], pages };
  const ids = pages.map((p) => p.id);
  const rows = await db.execute<any>(sql`
    SELECT dc.id, dc.content, dc.page_id AS page_id, p.content_version AS content_version
    FROM document_chunks dc
    JOIN pages p ON p.id = dc.page_id
    WHERE dc.page_id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
  `);
  const support: SupportChunk[] = rows.rows.map((r: { id: string; content: string; page_id: string; content_version: number }) => ({
    chunkId: r.id, pageId: r.page_id, content: r.content, contentVersion: r.content_version
  }));
  return { support, pages };
}

/**
 * Generate a structured, itemised refresh diff for a stale Topic (spec E5
 * "生成 refresh diff → 用户逐项应用"). Compares the Topic's *existing* synthesis
 * against a freshly-generated one from its current source pages.
 *
 * Deterministic (no LLM-in-the-loop for the diff itself — the LLM only produces
 * the fresh synthesis, which is Zod-validated). Every `add`/`modify` item carries
 * REAL chunk citations (from the validated fresh synthesis), so applying the diff
 * never invents citations. Returns `null` when a fresh synthesis cannot be built
 * (AI failure / no sources) so the caller keeps the topic stale.
 */
export async function generateRefreshDiff(topicId: string, ai: AiProvider): Promise<TopicRefreshDiff | null> {
  const topicRes = await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${topicId} LIMIT 1`);
  const topic = topicRes.rows[0];
  if (!topic) return null;
  const existing = (topic.content_json ?? {}) as TopicSynthesis;
  if (existing?.schemaVersion !== 'topic-synthesis-v1') return null; // legacy doc -> no diff path

  const { support, pages } = await getTopicSupportChunks(topicId);
  if (support.length === 0) return null; // nothing to refresh from -> keep stale

  const freshResult = await generateTopicSynthesis(support, ai);
  if (freshResult.status === 'failed') return null;
  const fresh = freshResult.synthesis;

  const norm = (s: string) => normalizeTitle(s);
  const existingByTitle = new Map(existing.keyPoints.map((k) => [norm(k.title), k]));
  const freshByTitle = new Map(fresh.keyPoints.map((k) => [norm(k.title), k]));
  const items: TopicRefreshDiffItem[] = [];

  // Added key points: present in fresh, absent in existing.
  for (const fkp of fresh.keyPoints) {
    if (!existingByTitle.has(norm(fkp.title))) {
      items.push({ kind: 'add_key_point', keyPoint: { id: fkp.id, title: fkp.title, content: fkp.content, citations: fkp.citations } });
    }
  }
  // Removed key points: present in existing, absent in fresh.
  for (const ekp of existing.keyPoints) {
    if (!freshByTitle.has(norm(ekp.title))) {
      items.push({ kind: 'remove_key_point', keyPointId: ekp.id, title: ekp.title });
    }
  }
  // Modified key points: same title, different content.
  for (const ekp of existing.keyPoints) {
    const fkp = freshByTitle.get(norm(ekp.title));
    if (fkp && fkp.content !== ekp.content) {
      items.push({
        kind: 'modify_key_point',
        keyPointId: ekp.id,
        title: ekp.title,
        oldContent: ekp.content,
        newContent: fkp.content,
        newCitations: fkp.citations
      });
    }
  }

  // Source-level changes: compare current source pages vs recorded topic_sources.
  const existingSourcePages = new Set((await db.execute<any>(sql`SELECT page_id FROM topic_sources WHERE topic_id = ${topicId}`)).rows.map((r: { page_id: string }) => r.page_id));
  const currentPages = new Map(pages.map((p) => [p.id, p.title]));
  for (const [pid, ptitle] of currentPages) {
    if (!existingSourcePages.has(pid)) items.push({ kind: 'add_source', pageId: pid, pageTitle: ptitle });
  }
  for (const pid of existingSourcePages) {
    if (!currentPages.has(pid)) items.push({ kind: 'stale_source', pageId: pid, reason: '源页面已不再作为该主题来源' });
  }

  // New conflicts surfaced by the fresh synthesis.
  const existingConflictKeys = new Set((existing.conflicts ?? []).map((c) => norm(c.description)));
  for (const c of fresh.conflicts ?? []) {
    if (!existingConflictKeys.has(norm(c.description))) {
      items.push({ kind: 'conflict', description: c.description, sides: c.sides });
    }
  }

  const diff: TopicRefreshDiff = {
    schemaVersion: 'topic-refresh-diff-v1',
    topicId,
    generatedFromContentVersions: fresh.generatedFromContentVersions ?? [],
    items
  };
  // Validate the diff structure before handing it to callers / persisting it.
  const parsed = topicRefreshDiffSchema.safeParse(diff);
  return parsed.success ? parsed.data : null;
}

// Persist (or replace) a pending refresh-diff suggestion so the UI can render and
// apply it item-by-item. Deduplicated per topic so re-running refresh updates the
// same suggestion rather than stacking duplicates.
async function storeRefreshDiffSuggestion(topic: { id: string; workspaceId: string; spaceId: string }, diff: TopicRefreshDiff): Promise<void> {
  const existing = await db.execute<any>(sql`
    SELECT id FROM llm_suggestions
    WHERE space_id = ${topic.spaceId} AND type = 'topic_refresh_diff' AND status = 'pending'
      AND payload ->> 'topicId' = ${topic.id}::text
    LIMIT 1
  `);
  if (existing.rows.length > 0) {
    await db.execute(sql`
      UPDATE llm_suggestions SET payload = ${JSON.stringify({ topicId: topic.id, diff })}::jsonb, updated_at = now()
      WHERE id = ${existing.rows[0].id}
    `);
    return;
  }
  await db.execute(sql`
    INSERT INTO llm_suggestions(workspace_id, space_id, page_id, topic_id, type, risk, status, payload, evidence)
    VALUES (
      ${topic.workspaceId}, ${topic.spaceId}, NULL, ${topic.id}, 'topic_refresh_diff', 'low', 'pending',
      ${JSON.stringify({ topicId: topic.id, diff })}::jsonb,
      ${JSON.stringify({ topicId: topic.id })}::jsonb
    )
  `);
}

// Clear the stale flag on a topic whose sources now agree with its synthesis.
async function clearStaleFlag(topicId: string): Promise<void> {
  await db.execute(sql`
    UPDATE wiki_topics
    SET freshness_status = 'fresh', status = CASE WHEN status = 'stale' THEN 'accepted' ELSE status END,
        publication_status = CASE WHEN publication_status = 'stale' OR publication_status = 'suggested' THEN 'accepted' ELSE publication_status END,
        last_ai_refresh_at = now(), updated_at = now()
    WHERE id = ${topicId}
  `);
  await db.execute(sql`
    UPDATE llm_suggestions SET status = 'ignored', updated_at = now()
    WHERE topic_id = ${topicId} AND type = 'stale_topic' AND status = 'pending'
  `);
}

/**
 * Phase 4 refresh entry point. Replaces the Phase 0 behaviour for *structured*
 * Topics (topic-synthesis-v1): instead of silently overwriting the body, it
 * generates an itemised diff and stores it for the user to apply. The topic
 * stays `stale` until the user applies the diff (Gate: 用户正文不被覆盖).
 *
 * Legacy (doc-only) Topics keep the original overwrite behaviour so the Phase 0
 * contract (`refreshTopicSuggestions` returns `refreshed:true` and clears stale
 * on AI success) is preserved.
 *
 * `user_edited` Topics are NEVER overwritten — the diff is generated and stored
 * for review, but the user's body is left untouched (Gate: 用户正文不被覆盖).
 */
export async function refreshTopicSuggestions(topicId: string): Promise<{ refreshed: boolean; error?: string; diff?: TopicRefreshDiff }> {
  const topicRes = await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${topicId} LIMIT 1`);
  const topic = topicRes.rows[0];
  if (!topic) return { refreshed: false, error: 'topic not found' };

  const contentJson = (topic.content_json ?? {}) as TopicSynthesis;
  const isStructured = contentJson?.schemaVersion === 'topic-synthesis-v1';

  if (isStructured) {
    let ai: AiProvider;
    try {
      ai = await createAiProviderForContext({ workspaceId: topic.workspace_id, spaceId: topic.space_id });
    } catch (err) {
      if (isAiDisabledError(err)) {
        // Disabled space: nothing to refresh; keep stale, report (no false success).
        return { refreshed: false, error: 'ai disabled for this space' };
      }
      throw err;
    }
    const diff = await generateRefreshDiff(topicId, ai);
    // AI / validation failure -> keep stale, do NOT write (Gate: AI 失败时保持 stale).
    if (!diff) return { refreshed: false, error: 'refresh diff generation failed' };

    if (diff.items.length === 0) {
      // Sources now agree with the synthesis — nothing to overwrite; clear stale.
      await clearStaleFlag(topicId);
      return { refreshed: true };
    }

    // Store the diff for item-by-item application. Never overwrite the body.
    await storeRefreshDiffSuggestion({ id: topic.id, workspaceId: topic.workspace_id, spaceId: topic.space_id }, diff);
    // user_edited bodies are protected: keep stale, leave content intact.
    return { refreshed: true, diff };
  }

  // ---- Legacy (doc-only) Topic: original Phase 0 overwrite behaviour ----
  const src = await db.execute<any>(sql`
    SELECT p.text_content FROM topic_sources ts
    JOIN pages p ON p.id = ts.page_id
    WHERE ts.topic_id = ${topicId}
    ORDER BY p.updated_at DESC LIMIT 20
  `);
  const text = src.rows.map((r: { text_content: string }) => r.text_content).join('\n\n').trim();
  if (!text) return { refreshed: false, error: 'no source content' };

  try {
    const ai = await createAiProviderForContext({ workspaceId: topic.workspace_id, spaceId: topic.space_id });
    const out = await ai.generateText([
      { role: 'system', content: '用一句话概括以下资料的主题要点。只输出文本，不要使用 JSON。' },
      { role: 'user', content: text.slice(0, 2000) }
    ]);
    if (!out || !out.trim()) return { refreshed: false, error: 'ai returned empty summary' };
    await db.execute(sql`
      UPDATE wiki_topics
      SET ai_summary = ${out.trim().slice(0, 500)}, status = 'accepted', last_ai_refresh_at = now(),
          ai_version = 'refreshed', updated_at = now(),
          freshness_status = 'fresh', publication_status = 'accepted'
      WHERE id = ${topicId}
    `);
    await db.execute(sql`
      UPDATE llm_suggestions SET status = 'ignored', updated_at = now()
      WHERE topic_id = ${topicId} AND type = 'stale_topic' AND status = 'pending'
    `);
    return { refreshed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { refreshed: false, error: message };
  }
}

/**
 * Apply selected items of a stored refresh diff to a Topic (spec E5 "逐项应用").
 * Every change is validated against `topicSynthesisSchema` before persisting, so
 * the result is always a legal synthesis (Gate: 非法 JSON / 无效结构不写库).
 * Applying is an explicit user action, so a `user_edited` body is preserved as
 * `user_edited` (the user chose to incorporate the diff), and the topic is
 * re-indexed for RAG. The stale flag is cleared once the diff is applied.
 */
export async function applyRefreshDiff(topicId: string, itemIndexes: number[], _userId: string): Promise<{ applied: number }> {
  const sugg = await db.execute<any>(sql`
    SELECT * FROM llm_suggestions
    WHERE topic_id = ${topicId} AND type = 'topic_refresh_diff' AND status = 'pending'
    LIMIT 1
  `);
  if (sugg.rows.length === 0) throw new Error('no pending refresh diff for this topic');
  const diff = (sugg.rows[0].payload as { diff?: TopicRefreshDiff }).diff;
  if (!diff) throw new Error('refresh diff payload missing');

  const topicRes = await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${topicId} LIMIT 1`);
  const topic = topicRes.rows[0];
  if (!topic) throw new Error('topic not found');
  const synth = (topic.content_json ?? {}) as TopicSynthesis;
  if (synth?.schemaVersion !== 'topic-synthesis-v1') throw new Error('topic is not a structured synthesis');

  const selected = new Set(itemIndexes);
  const next: TopicSynthesis = JSON.parse(JSON.stringify(synth));
  let applied = 0;

  diff.items.forEach((item, idx) => {
    if (!selected.has(idx)) return;
    switch (item.kind) {
      case 'add_key_point':
        next.keyPoints.push(item.keyPoint);
        applied++;
        break;
      case 'modify_key_point': {
        const kp = next.keyPoints.find((k) => k.id === item.keyPointId);
        if (kp) {
          kp.content = item.newContent;
          kp.citations = item.newCitations;
          if (item.title) kp.title = item.title;
          applied++;
        }
        break;
      }
      case 'remove_key_point':
        next.keyPoints = next.keyPoints.filter((k) => k.id !== item.keyPointId);
        applied++;
        break;
      case 'conflict':
        next.conflicts = next.conflicts ?? [];
        next.conflicts.push({ description: item.description, sides: item.sides });
        applied++;
        break;
      case 'add_source':
        // captured below (needs an insert); counted here for the return value.
        applied++;
        break;
      case 'stale_source':
        // captured below (needs a delete); counted here for the return value.
        applied++;
        break;
    }
  });

  // Source-level items require DB writes (outside the synthesis JSON).
  for (const idx of selected) {
    const item = diff.items[idx];
    if (item.kind === 'add_source') {
      await db.insert(topicSources).values({ topicId, pageId: item.pageId, addedBy: 'user', contributionType: 'key_point', sourceType: 'page' }).onConflictDoNothing();
      // A user applied a diff that added a new source page to the Topic.
      await recordActivity({ workspaceId: topic.workspace_id, spaceId: topic.space_id, entityType: 'topic', entityId: topicId, eventType: 'added_to_source', userId: _userId, metadata: { pageId: item.pageId } });
    } else if (item.kind === 'stale_source') {
      await db.execute(sql`DELETE FROM topic_sources WHERE topic_id = ${topicId} AND page_id = ${item.pageId}::uuid`);
    }
  }

  // Gate: resulting synthesis must still be valid (e.g. removing the last
  // keyPoint is rejected rather than persisting an illegal structure).
  const validated = topicSynthesisSchema.safeParse(next);
  if (!validated.success) throw new Error('applying the diff would produce an invalid synthesis');

  const textContent = extractTextFromSynthesis(next);
  const wasUserEdited = topic.publication_status === 'user_edited';
  await db.execute(sql`
    UPDATE wiki_topics
    SET content_json = ${JSON.stringify(next)}::jsonb, text_content = ${textContent},
        ai_summary = ${(next.definition || next.overview).slice(0, 500)},
        freshness_status = 'fresh',
        status = CASE WHEN status = 'stale' THEN 'accepted' ELSE status END,
        publication_status = ${wasUserEdited ? 'user_edited' : 'accepted'},
        last_ai_refresh_at = now(), updated_at = now()
    WHERE id = ${topicId}
  `);
  // Resolve the diff + stale suggestions now that the user has applied changes.
  await db.execute(sql`
    UPDATE llm_suggestions SET status = 'ignored', updated_at = now()
    WHERE topic_id = ${topicId} AND type IN ('topic_refresh_diff', 'stale_topic') AND status = 'pending'
  `);

  // Re-index the (now updated) Topic so RAG reflects the applied diff.
  try {
    const ai = await createAiProviderForContext({ workspaceId: topic.workspace_id, spaceId: topic.space_id });
    await indexTopicForSearch(topic, next, ai);
  } catch {
    /* indexing is best-effort */
  }

  return { applied };
}

/* ------------------------------------------- Phase 4: merge / split --------- */

/**
 * Merge `mergedId` INTO `survivorId`. The merged Topic becomes a redirect stub
 * (lifecycle 'archived', pointing at the survivor) so old links keep working.
 * Provenance (topic_sources) and RAG chunks (document_chunks.topic_id) are moved
 * to the survivor. The operation is recorded in `topic_operations` with enough
 * reversal data to fully undo it (Gate: 合并后可追溯和恢复).
 */
export async function mergeTopics(survivorId: string, mergedId: string, userId: string): Promise<{ operationId: string }> {
  if (survivorId === mergedId) throw new Error('cannot merge a topic into itself');
  const [survivor, merged] = await Promise.all([
    db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${survivorId} LIMIT 1`),
    db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${mergedId} LIMIT 1`)
  ]);
  const s = survivor.rows[0];
  const m = merged.rows[0];
  if (!s || !m) throw new Error('topic not found');
  if (s.space_id !== m.space_id) throw new Error('cannot merge topics across spaces');

  // Capture the merged topic's sources so we can move provenance correctly and
  // reverse it. We move only the rows whose pageId the survivor does NOT already
  // have (duplicate provenance is dropped); the rest are re-inserted on undo.
  const mergedSources = await db.execute<any>(sql`SELECT * FROM topic_sources WHERE topic_id = ${mergedId}`);
  const survivorSourcePages = new Set(
    (await db.execute<any>(sql`SELECT page_id FROM topic_sources WHERE topic_id = ${survivorId}`)).rows.map((r: { page_id: string }) => r.page_id)
  );
  const movedKeys: string[] = [];
  const droppedRows: Record<string, unknown>[] = [];
  for (const row of mergedSources.rows) {
    if (survivorSourcePages.has(row.page_id)) {
      droppedRows.push(row);
    } else {
      movedKeys.push(row.page_id);
    }
  }

  // Alias the merged title into the survivor for future clustering.
  const mergedNorm = normalizeTitle(m.title);
  const survivorAliases: string[] = Array.isArray(s.aliases) ? [...s.aliases] : [];
  if (!survivorAliases.includes(mergedNorm)) survivorAliases.push(mergedNorm);
  // Build a Postgres text[] literal (raw SQL needs explicit array syntax).
  const aliasLiteral = `{${survivorAliases.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(',')}}`;

  // All data mutations run inside ONE transaction so a mid-merge failure leaves
  // no "half-merged" orphan state (Gate: 合并可完整回滚). The (network) reindex
  // is deliberately performed AFTER commit, best-effort.
  const [op] = await db.transaction(async (tx) => {
    // Move provenance: delete duplicate sources, re-point the rest to survivor.
    for (const row of droppedRows) {
      await tx.execute(sql`DELETE FROM topic_sources WHERE topic_id = ${mergedId} AND page_id = ${row.page_id}::uuid`);
    }
    for (const pageId of movedKeys) {
      await tx.execute(sql`UPDATE topic_sources SET topic_id = ${survivorId}::uuid WHERE topic_id = ${mergedId} AND page_id = ${pageId}::uuid`);
    }

    // Move the merged Topic's RAG chunks to the survivor (so search keeps it).
    const chunkRows = await tx.execute<any>(sql`SELECT id FROM document_chunks WHERE topic_id = ${mergedId}`);
    const chunkIds = chunkRows.rows.map((r: { id: string }) => r.id);
    if (chunkIds.length > 0) {
      await tx.execute(sql`UPDATE document_chunks SET topic_id = ${survivorId}::uuid WHERE topic_id = ${mergedId} AND id = ANY(ARRAY[${sql.join(chunkIds.map((id) => sql`${id}::uuid`), sql`, `)}])`);
    }

    // Update survivor aliases.
    await tx.execute(sql`UPDATE wiki_topics SET aliases = ${aliasLiteral}::text[] WHERE id = ${survivorId}`);

    // Turn the merged topic into a redirect stub.
    await tx.execute(sql`
      UPDATE wiki_topics
      SET merged_into_topic_id = ${survivorId}::uuid, merged_at = now(), merged_by_id = ${userId}::uuid,
          lifecycle_status = 'archived', status = 'archived', freshness_status = 'fresh', updated_at = now()
      WHERE id = ${mergedId}
    `);

    // Audit record (reversible: re-point chunks + sources back, restore stub).
    const [operation] = await tx
      .insert(topicOperations)
      .values({
        workspaceId: s.workspace_id,
        spaceId: s.space_id,
        operationType: 'merge',
        topicId: mergedId,
        targetTopicId: survivorId,
        createdById: userId,
        payload: {
          movedKeys,
          droppedRows,
          chunkIds,
          previousMerged: { lifecycleStatus: m.lifecycle_status, status: m.status, publicationStatus: m.publication_status, title: m.title }
        }
      })
      .returning();
    return [operation];
  });

  // Re-index the survivor (now carries the merged chunks). Network call kept
  // OUTSIDE the transaction: a reindex failure must not roll back the merge.
  try {
    const ai = await createAiProviderForContext({ workspaceId: s.workspace_id, spaceId: s.space_id });
    const sSynth = (s.content_json ?? {}) as TopicSynthesis;
    if (sSynth?.schemaVersion === 'topic-synthesis-v1') {
      await indexTopicForSearch({ id: s.id, workspaceId: s.workspace_id, spaceId: s.space_id, title: s.title }, sSynth, ai);
    }
  } catch {
    /* best-effort */
  }

  // The survivor gained the merged Topic's provenance — a real user-driven change.
  await recordActivity({ workspaceId: s.workspace_id, spaceId: s.space_id, entityType: 'topic', entityId: survivorId, eventType: 'added_to_source', userId, metadata: { fromMerge: mergedId } });

  return { operationId: op.id };
}

/**
 * Split selected keyPoints OUT of `topicId` into a NEW Topic. The new Topic keeps
 * the extracted keyPoints (with their real citations) and inherits the parent's
 * source provenance. `promotedFromTopicId` ties it back to the parent for
 * traceability. The operation is recorded with a pre-split synthesis snapshot so
 * it can be fully undone (Gate: 合并后可追溯和恢复 — also covers split).
 */
export async function splitTopic(topicId: string, newTitle: string, keyPointIds: string[], userId: string): Promise<{ topicId: string; operationId: string }> {
  if (!keyPointIds.length) throw new Error('no keyPoints selected to split');
  const topicRes = await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${topicId} LIMIT 1`);
  const topic = topicRes.rows[0];
  if (!topic) throw new Error('topic not found');
  const synth = (topic.content_json ?? {}) as TopicSynthesis;
  if (synth?.schemaVersion !== 'topic-synthesis-v1') throw new Error('topic is not a structured synthesis');

  const extracted = synth.keyPoints.filter((k) => keyPointIds.includes(k.id));
  if (extracted.length === 0) throw new Error('none of the selected keyPoints exist on this topic');
  if (extracted.length === synth.keyPoints.length) throw new Error('cannot split all keyPoints out of a topic');

  const newSynth: TopicSynthesis = {
    ...synth,
    definition: extracted.map((k) => k.title).join('、').slice(0, 160),
    overview: extracted.map((k) => k.content).join(' ').slice(0, 600),
    keyPoints: extracted,
    subtopics: [],
    conflicts: [],
    decisions: [],
    openQuestions: []
  };
  const parentSynth: TopicSynthesis = { ...synth, keyPoints: synth.keyPoints.filter((k) => !keyPointIds.includes(k.id)) };

  // All data mutations run inside ONE transaction so a mid-split failure leaves
  // no orphan Topic / half-updated parent (Gate: 拆分可完整回滚). Reindex is
  // performed AFTER commit, best-effort.
  const [newTopic, op] = await db.transaction(async (tx) => {
    const [nt] = await tx
      .insert(wikiTopics)
      .values({
        workspaceId: topic.workspace_id,
        spaceId: topic.space_id,
        title: newTitle,
        contentJson: newSynth as unknown,
        textContent: extractTextFromSynthesis(newSynth),
        status: 'accepted',
        source: 'ai_generated',
        aiSummary: newSynth.definition || newSynth.overview.slice(0, 200),
        aliases: [normalizeTitle(newTitle)],
        normalizedTitle: normalizeTitle(newTitle),
        synthesisVersion: 'topic-synthesis-v1',
        createdById: userId,
        promotedFromTopicId: topicId,
        originSpaceId: topic.space_id,
        publicationStatus: 'accepted',
        freshnessStatus: 'fresh',
        lifecycleStatus: 'active'
      })
      .returning();

    // Inherit the parent's source provenance for the new Topic.
    const sources = await tx.execute<any>(sql`SELECT page_id, chunk_id, source_content_version, source_type, relevance_score, evidence_excerpt, added_by, contribution_type FROM topic_sources WHERE topic_id = ${topicId}`);
    if (sources.rows.length > 0) {
      await tx.insert(topicSources).values(
        sources.rows.map((r: Record<string, unknown>) => ({
          topicId: nt.id,
          pageId: r.page_id as string,
          chunkId: (r.chunk_id as string) ?? null,
          sourceContentVersion: (r.source_content_version as number) ?? null,
          sourceType: (r.source_type as string) ?? 'page',
          relevanceScore: (r.relevance_score as number) ?? null,
          evidenceExcerpt: (r.evidence_excerpt as string) ?? null,
          addedBy: (r.added_by as string) ?? 'ai',
          contributionType: (r.contribution_type as string) ?? 'key_point'
        }))
      );
    }

    // Parent loses the extracted keyPoints.
    await tx.execute(sql`
      UPDATE wiki_topics
      SET content_json = ${JSON.stringify(parentSynth)}::jsonb, text_content = ${extractTextFromSynthesis(parentSynth)},
          ai_summary = ${(parentSynth.definition || parentSynth.overview).slice(0, 500)}, updated_at = now()
      WHERE id = ${topicId}
    `);

    const [operation] = await tx
      .insert(topicOperations)
      .values({
        workspaceId: topic.workspace_id,
        spaceId: topic.space_id,
        operationType: 'split',
        topicId,
        targetTopicId: nt.id,
        createdById: userId,
        payload: { extractedKeyPointIds: keyPointIds, newTitle, parentSynthesisBefore: synth }
      })
      .returning();

    return [nt, operation];
  });

  // The split spawned a Topic carrying inherited sources — a real user action.
  await recordActivity({ workspaceId: topic.workspace_id, spaceId: topic.space_id, entityType: 'topic', entityId: newTopic.id, eventType: 'added_to_source', userId, metadata: { fromSplit: topicId } });

  // Re-index both topics for RAG (network call outside the transaction).
  try {
    const ai = await createAiProviderForContext({ workspaceId: topic.workspace_id, spaceId: topic.space_id });
    await indexTopicForSearch(newTopic, newSynth, ai);
    await indexTopicForSearch(topic, parentSynth, ai);
  } catch {
    /* best-effort */
  }

  return { topicId: newTopic.id, operationId: op.id };
}

/**
 * Undo a recorded merge / split operation. Restores the prior state exactly:
 *   - merge: re-point chunks + sources back to the merged (stub) Topic, restore
 *     its lifecycle/status, and re-index both Topics.
 *   - split: delete the spawned Topic (+ its chunks/sources) and restore the
 *     parent's pre-split synthesis snapshot, then re-index the parent.
 * Idempotent: a previously-undone operation is a no-op.
 */
export async function undoTopicOperation(operationId: string, userId: string): Promise<void> {
  const [op] = await db.select().from(topicOperations).where(eq(topicOperations.id, operationId)).limit(1);
  if (!op) throw new Error('operation not found');
  if (op.undoneAt) return; // already undone

  // IDs needed for the post-commit re-index (network calls stay outside the tx).
  let mergedId: string | undefined;
  let survivorId: string | undefined;
  let parentId: string | undefined;
  const p = (op.payload ?? {}) as {
    movedKeys?: string[];
    droppedRows?: Record<string, unknown>[];
    chunkIds?: string[];
    previousMerged?: { lifecycleStatus: string; status: string; publicationStatus: string; title: string };
    parentSynthesisBefore?: TopicSynthesis;
  };

  // Every restoration write runs inside ONE transaction so an interrupted undo
  // cannot leave a half-restored Topic (Gate: 撤销可完整回滚). Reindex happens
  // after commit, best-effort.
  await db.transaction(async (tx) => {
    if (op.operationType === 'merge') {
      mergedId = op.topicId!;
      survivorId = op.targetTopicId!;
      // Move chunks back to the merged topic.
      if (p.chunkIds?.length) {
        await tx.execute(sql`UPDATE document_chunks SET topic_id = ${mergedId}::uuid WHERE topic_id = ${survivorId} AND id = ANY(ARRAY[${sql.join(p.chunkIds.map((id) => sql`${id}::uuid`), sql`, `)}])`);
      }
      // Move the (previously moved) sources back.
      if (p.movedKeys?.length) {
        await tx.execute(sql`UPDATE topic_sources SET topic_id = ${mergedId}::uuid WHERE topic_id = ${survivorId} AND page_id = ANY(ARRAY[${sql.join(p.movedKeys.map((id) => sql`${id}::uuid`), sql`, `)}])`);
      }
      // Re-insert the dropped (duplicate) sources under the merged topic.
      for (const row of p.droppedRows ?? []) {
        await tx.insert(topicSources).values({
          topicId: mergedId,
          pageId: row.page_id as string,
          chunkId: (row.chunk_id as string) ?? null,
          sourceContentVersion: (row.source_content_version as number) ?? null,
          sourceType: (row.source_type as string) ?? 'page',
          relevanceScore: (row.relevance_score as number) ?? null,
          evidenceExcerpt: (row.evidence_excerpt as string) ?? null,
          addedBy: (row.added_by as string) ?? 'ai',
          contributionType: (row.contribution_type as string) ?? 'key_point'
        }).onConflictDoNothing();
      }
      // Restore the merged topic from its redirect-stub state.
      const prev = p.previousMerged;
      await tx.execute(sql`
        UPDATE wiki_topics
        SET merged_into_topic_id = NULL, merged_at = NULL, merged_by_id = NULL,
            lifecycle_status = ${prev?.lifecycleStatus ?? 'active'},
            status = ${prev?.status ?? 'accepted'},
            publication_status = ${prev?.publicationStatus ?? 'accepted'},
            updated_at = now()
        WHERE id = ${mergedId}
      `);
    } else if (op.operationType === 'split') {
      parentId = op.topicId!;
      const newTopicId = op.targetTopicId!;
      // Delete the spawned topic and its chunks / sources.
      await tx.execute(sql`DELETE FROM document_chunks WHERE topic_id = ${newTopicId}::uuid`);
      await tx.execute(sql`DELETE FROM topic_sources WHERE topic_id = ${newTopicId}::uuid`);
      await tx.execute(sql`DELETE FROM wiki_topics WHERE id = ${newTopicId}::uuid`);
      // Restore the parent's pre-split synthesis.
      if (p.parentSynthesisBefore) {
        await tx.execute(sql`
          UPDATE wiki_topics
          SET content_json = ${JSON.stringify(p.parentSynthesisBefore)}::jsonb,
              text_content = ${extractTextFromSynthesis(p.parentSynthesisBefore)},
              ai_summary = ${(p.parentSynthesisBefore.definition || p.parentSynthesisBefore.overview).slice(0, 500)},
              updated_at = now()
          WHERE id = ${parentId}
        `);
      }
    } else if (op.operationType === 'derive') {
      // Derive copies the original (which is left untouched), so undo simply
      // removes the derived Topic and its chunks / sources. Nothing to restore on
      // the original — its history stays fully intact (gate: 原项目历史完整).
      const derivedId = op.targetTopicId!;
      await tx.execute(sql`DELETE FROM document_chunks WHERE topic_id = ${derivedId}::uuid`);
      await tx.execute(sql`DELETE FROM topic_sources WHERE topic_id = ${derivedId}::uuid`);
      await tx.execute(sql`DELETE FROM wiki_topics WHERE id = ${derivedId}::uuid`);
    }

    await tx.execute(sql`UPDATE topic_operations SET undone_at = now(), undone_by_id = ${userId}::uuid WHERE id = ${operationId}`);
  });

  // Re-index AFTER commit (network calls outside the transaction).
  try {
    const ai = await createAiProviderForContext({ workspaceId: op.workspaceId, spaceId: op.spaceId });
    if (op.operationType === 'merge') {
      const mergedRow = (await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${mergedId} LIMIT 1`)).rows[0];
      const survivorRow = (await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${survivorId} LIMIT 1`)).rows[0];
      if (mergedRow && (mergedRow.content_json ?? {}).schemaVersion === 'topic-synthesis-v1') {
        await indexTopicForSearch({ id: mergedRow.id, workspaceId: mergedRow.workspace_id, spaceId: mergedRow.space_id, title: mergedRow.title }, mergedRow.content_json as TopicSynthesis, ai);
      }
      if (survivorRow && (survivorRow.content_json ?? {}).schemaVersion === 'topic-synthesis-v1') {
        await indexTopicForSearch({ id: survivorRow.id, workspaceId: survivorRow.workspace_id, spaceId: survivorRow.space_id, title: survivorRow.title }, survivorRow.content_json as TopicSynthesis, ai);
      }
    } else if (op.operationType === 'split' && p.parentSynthesisBefore) {
      const parentRow = (await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${parentId} LIMIT 1`)).rows[0];
      await indexTopicForSearch({ id: parentRow.id, workspaceId: parentRow.workspace_id, spaceId: parentRow.space_id, title: parentRow.title }, p.parentSynthesisBefore, ai);
    }
  } catch {
    /* best-effort */
  }
}

/* ------------------------------------------- Phase 5: archive center -------- */

/**
 * Archive a Topic (deliberate user action — the "归档中心" recovery path). Sets
 * lifecycle_status='archived' and records who/when/why. Archiving is NOT deletion
 * (spec rule 10): the Topic stays searchable and citable, just down-weighted.
 */
export async function archiveTopic(topicId: string, userId: string, reason = 'manual'): Promise<void> {
  await db.execute(sql`
    UPDATE wiki_topics
    SET lifecycle_status = 'archived', status = 'archived',
        archived_at = now(), archived_by_id = ${userId}::uuid, archive_reason = ${reason},
        updated_at = now()
    WHERE id = ${topicId}::uuid
  `);
}

/**
 * Reactivate an archived Topic (the recovery half of the archive center). Restores
 * it to 'active' and stamps last_meaningful_activity_at so lifecycle evaluation
 * no longer flags it. A real user action, so activity is recorded.
 */
export async function reactivateTopic(topicId: string, userId: string): Promise<void> {
  const [topic] = await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${topicId} LIMIT 1`).then((r) => [r.rows[0]]);
  if (!topic) throw new Error('topic not found');
  await db.execute(sql`
    UPDATE wiki_topics
    SET lifecycle_status = 'active',
        status = CASE WHEN status = 'archived' THEN 'accepted' ELSE status END,
        archived_at = NULL, archived_by_id = NULL, archive_reason = NULL,
        last_meaningful_activity_at = now(), updated_at = now()
    WHERE id = ${topicId}::uuid
  `);
  await recordActivity({ workspaceId: topic.workspace_id, spaceId: topic.space_id, entityType: 'topic', entityId: topicId, eventType: 'view', userId, metadata: { reactivated: true } });
}

/**
 * Phase B (B2.3): soft-delete a Topic. We NEVER hard-delete — deletion is an
 * archive with reason 'deleted' (plus deleted_at/deleted_by_id) so the Topic
 * stays auditable and recoverable via `reactivateTopic`. It is therefore hidden
 * from the default list (which excludes lifecycle='archived') but still
 * reachable through `?lifecycle=archived`.
 */
export async function deleteTopic(topicId: string, userId: string): Promise<void> {
  const [topic] = await db.execute<any>(sql`SELECT * FROM wiki_topics WHERE id = ${topicId} LIMIT 1`).then((r) => [r.rows[0]]);
  if (!topic) throw new Error('topic not found');
  await db.execute(sql`
    UPDATE wiki_topics
    SET lifecycle_status = 'archived', status = 'archived',
        archived_at = now(), archived_by_id = ${userId}::uuid, archive_reason = 'deleted',
        deleted_at = now(), deleted_by_id = ${userId}::uuid,
        updated_at = now()
    WHERE id = ${topicId}::uuid
  `);
  await recordActivity({ workspaceId: topic.workspace_id, spaceId: topic.space_id, entityType: 'topic', entityId: topicId, eventType: 'view', userId, metadata: { deleted: true } });
}


export async function retryFailedTopicSynthesis(topicId: string, ai: AiProvider): Promise<{ ok: boolean; error?: string }> {
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) return { ok: false, error: 'topic not found' };
  const { support } = await getTopicSupportChunks(topicId);
  const result = await generateTopicSynthesis(support, ai);
  if (result.status === 'failed') {
    await db.update(wikiTopics).set({
      status: 'synthesis_failed', synthesisStatus: 'failed', aiSummary: result.error,
      contentJson: { schemaVersion: 'topic-synthesis-failed-v1', error: result.error, evidencePreview: result.evidencePreview },
      textContent: '', qualityIssues: result.diagnostics.qualityIssues,
      synthesisDiagnostics: result.diagnostics, updatedAt: sql`now()`
    }).where(eq(wikiTopics.id, topicId));
    return { ok: false, error: result.error };
  }
  // P0-5: respect user-locked fields. If the Topic has any lockedFields,
  // restore the previous synthesis's version of those fields before
  // persisting — AI refresh must never overwrite a user-pinned field.
  const previousRaw = topic.contentJson as { schemaVersion?: string } | null;
  const previousSynthesis = previousRaw?.schemaVersion === 'topic-synthesis-v1'
    ? (previousRaw as unknown as TopicSynthesis)
    : null;
  const finalSynthesis = applySynthesisRespectingLocks(result.synthesis, previousSynthesis, topic.lockedFields);
  const lockViolations = evaluateLockedFieldViolations(result.synthesis, topic.lockedFields);
  await db.update(wikiTopics).set({
    status: 'suggested', synthesisStatus: 'ready', synthesisVersion: 'topic-synthesis-v1',
    contentJson: finalSynthesis, textContent: extractTextFromSynthesis(finalSynthesis),
    aiSummary: finalSynthesis.definition || finalSynthesis.overview.slice(0, 200),
    qualityIssues: result.diagnostics.qualityIssues, synthesisDiagnostics: result.diagnostics,
    updatedAt: sql`now()`
  }).where(eq(wikiTopics.id, topicId));
  // If the AI tried to overwrite locked fields, surface it as a quality issue
  // on the Topic row so reviewers can see the lock was enforced.
  if (lockViolations.violations.length > 0) {
    await db.update(wikiTopics).set({
      qualityIssues: [...result.diagnostics.qualityIssues, ...lockViolations.violations],
      updatedAt: sql`now()`
    }).where(eq(wikiTopics.id, topicId));
  }
  const [updated] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (updated) await indexTopicForSearch(updated, result.synthesis, ai);
  return { ok: true };
}


export async function assignCandidateToTopic(candidateId: string, topicId: string): Promise<void> {
  const [candidate] = await db.select().from(topicCandidates).where(eq(topicCandidates.id, candidateId)).limit(1);
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!candidate || !topic || candidate.spaceId !== topic.spaceId) throw new Error('candidate and topic must belong to the same space');
  if (candidate.chunkId) await db.insert(topicSources).values({ topicId, pageId: candidate.pageId, chunkId: candidate.chunkId, addedBy: 'user', contributionType: 'key_point', evidenceExcerpt: candidate.summary.slice(0, 200) }).onConflictDoNothing();
  await db.update(topicCandidates).set({ status: 'promoted', promotedTopicId: topicId, updatedAt: sql`now()` }).where(eq(topicCandidates.id, candidateId));
  await refreshTopicEvidenceCentroid(topicId);
}

export async function degradeTopicToFacet(topicId: string, userId: string): Promise<void> {
  const [topic] = await db.select().from(wikiTopics).where(eq(wikiTopics.id, topicId)).limit(1);
  if (!topic) throw new Error('topic not found');
  await db.update(wikiTopics).set({ lifecycleStatus: 'archived', status: 'archived', archiveReason: 'degraded_to_facet', archivedAt: sql`now()`, archivedById: userId, updatedAt: sql`now()` }).where(eq(wikiTopics.id, topicId));
}

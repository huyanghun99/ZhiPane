import { sql } from 'drizzle-orm';
import { HybridSearchResult, RRF_K } from '@zhipane/shared';
import { db } from '../db/client';
import { createAiProviderForContext, isAiDisabledError, vectorToSqlLiteral, type AiProvider } from './ai.service';
import { getReadableSpaceIds } from './permission.service';
import { tokenizeChineseFriendly } from '../utils/text';
import { logger } from './logger';

interface RankedRow {
  id: string;
  page_id: string | null;
  topic_id: string | null;
  space_id: string;
  title: string;
  content: string;
  score: number;
  [key: string]: unknown;
}

/**
 * Query-embedding cache (Phase 2 perf, Phase H S6 hardening).
 *
 * The semantic branch needs a vector for the *user's query string*. Without
 * caching, every debounced keystroke that lands on a cache miss would call
 * the remote embedding endpoint. We memoise per (embeddingModel, normalised
 * query) so repeated searches reuse the vector instead of hitting the
 * network.
 *
 * Phase H (S6) fixes three remaining gaps:
 *  - TTL: entries expire after QUERY_CACHE_TTL_MS so a long-lived process
 *    does not serve stale embeddings indefinitely.
 *  - Model-aware key: cache key includes embeddingModel, so swapping the
 *    model (e.g. mock -> text-embedding-3-small) invalidates old vectors
 *    automatically instead of returning wrong-dimension hits.
 *  - Bounded LRU by insertion order (unchanged, QUERY_CACHE_MAX).
 */
interface CacheEntry {
  vector: number[];
  ts: number;
}
const QUERY_EMBEDDING_CACHE = new Map<string, CacheEntry>();
const QUERY_CACHE_MAX = 512;
const QUERY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function embedQuery(ai: AiProvider, query: string): Promise<number[] | null> {
  const key = `${ai.embeddingModel ?? 'default'}|${query.trim().toLowerCase()}`;
  if (!key) return null;
  const hit = QUERY_EMBEDDING_CACHE.get(key);
  if (hit && Date.now() - hit.ts < QUERY_CACHE_TTL_MS) return hit.vector;
  const emb = await ai.embed(query);
  if (QUERY_EMBEDDING_CACHE.size >= QUERY_CACHE_MAX) {
    const oldest = QUERY_EMBEDDING_CACHE.keys().next().value;
    if (oldest !== undefined) QUERY_EMBEDDING_CACHE.delete(oldest);
  }
  QUERY_EMBEDDING_CACHE.set(key, { vector: emb, ts: Date.now() });
  return emb;
}

function rrfFuse(bm25: RankedRow[], vector: RankedRow[], limit: number): HybridSearchResult[] {
  const map = new Map<string, HybridSearchResult & { bm25Rank?: number; vectorRank?: number }>();
  for (let i = 0; i < bm25.length; i++) {
    const row = bm25[i];
    map.set(row.id, {
      id: row.id,
      pageId: row.page_id ?? '',
      topicId: row.topic_id ?? undefined,
      spaceId: row.space_id,
      title: row.title,
      content: row.content,
      source: 'bm25',
      score: 0.4 / (RRF_K + i + 1),
      bm25Rank: i + 1
    });
  }
  for (let i = 0; i < vector.length; i++) {
    const row = vector[i];
    const existing = map.get(row.id);
    if (existing) {
      existing.source = 'both';
      existing.score += 0.6 / (RRF_K + i + 1);
      existing.vectorRank = i + 1;
    } else {
      map.set(row.id, {
        id: row.id,
        pageId: row.page_id ?? '',
        topicId: row.topic_id ?? undefined,
        spaceId: row.space_id,
        title: row.title,
        content: row.content,
        source: 'vector',
        score: 0.6 / (RRF_K + i + 1),
        vectorRank: i + 1
      });
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function buildExcerpt(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 220 ? collapsed.slice(0, 220) + '…' : collapsed;
}

export async function hybridSearch(params: {
  userId: string;
  workspaceId: string;
  spaceId?: string;
  query: string;
  limit: number;
  mode?: 'keyword' | 'vector' | 'hybrid';
  /** When set, restrict results to chunks of this single page. */
  pageId?: string;
  /** Phase 5 (F5): `current` down-weights archived; `historical` raises it. */
  intent?: 'current' | 'historical';
}): Promise<HybridSearchResult[]> {
  const mode = params.mode ?? 'hybrid';
  const readable = params.spaceId ? [params.spaceId] : await getReadableSpaceIds(params.userId, params.workspaceId);
  if (readable.length === 0) return [];
  const ftsQuery = tokenizeChineseFriendly(params.query);
  const pageFilter = params.pageId ? sql` AND page_id = ${params.pageId}::uuid` : sql``;

  const useKeyword = mode === 'keyword' || mode === 'hybrid';
  const useVector = mode === 'vector' || mode === 'hybrid';

  const bm25Promise: Promise<{ rows: RankedRow[] }> = useKeyword
    ? db.execute<RankedRow>(sql`
      SELECT id, page_id, topic_id, space_id, title, content,
             ts_rank(to_tsvector('simple', fts_tokens), plainto_tsquery('simple', ${ftsQuery})) AS score
      FROM document_chunks
      WHERE workspace_id = ${params.workspaceId}
        AND space_id = ANY(ARRAY[${sql.join(readable.map((id) => sql`${id}::uuid`), sql`, `)}])
        AND to_tsvector('simple', fts_tokens) @@ plainto_tsquery('simple', ${ftsQuery})
        ${pageFilter}
      ORDER BY score DESC
      LIMIT ${params.limit * 3}
    `)
    : Promise.resolve({ rows: [] });

  const vectorPromise: Promise<{ rows: RankedRow[] }> = useVector
    ? (async () => {
        // A disabled space must not run Embedding. Skip vector search
        // (keyword/BM25 still works) and return no vector rows.
        try {
          const ai = await createAiProviderForContext({
            workspaceId: params.workspaceId,
            spaceId: params.spaceId,
            userId: params.userId
          });
          const embedding = await embedQuery(ai, params.query);
          if (!embedding) return { rows: [] };
          const vectorLiteral = vectorToSqlLiteral(embedding);
          return db.execute<RankedRow>(sql`
            SELECT id, page_id, topic_id, space_id, title, content,
                   1 - (embedding <=> ${vectorLiteral}::vector) AS score
            FROM document_chunks
            WHERE workspace_id = ${params.workspaceId}
              AND space_id = ANY(ARRAY[${sql.join(readable.map((id) => sql`${id}::uuid`), sql`, `)}])
              AND embedding IS NOT NULL
              ${pageFilter}
            ORDER BY embedding <=> ${vectorLiteral}::vector
            LIMIT ${params.limit * 3}
          `);
        } catch (err) {
          if (isAiDisabledError(err)) return { rows: [] };
          throw err;
        }
      })()
    : Promise.resolve({ rows: [] });

  const [bm25Res, vectorRes] = await Promise.allSettled([bm25Promise, vectorPromise]);
  const bm25Rows = bm25Res.status === 'fulfilled' ? bm25Res.value.rows : [];
  const vectorRows = vectorRes.status === 'fulfilled' ? vectorRes.value.rows : [];
  if (bm25Res.status === 'rejected') logger.warn('search bm25 branch failed', { err: bm25Res.reason instanceof Error ? bm25Res.reason.message : String(bm25Res.reason) });
  if (vectorRes.status === 'rejected') logger.warn('search vector branch failed', { err: vectorRes.reason instanceof Error ? vectorRes.reason.message : String(vectorRes.reason) });
  const fused = rrfFuse(bm25Rows, vectorRows, params.limit);
  const ranked = await applyLifecycleRanking(fused, params.spaceId, params.intent ?? 'current');
  return ranked.map((r) => ({ ...r, excerpt: buildExcerpt(r.content) }));
}

/**
 * Phase 5 (F5) — lifecycle-aware re-ranking. Archived knowledge is NEVER excluded
 * (spec rule 10), but it is down-weighted under the default `current` intent and
 * boosted under the `historical` intent. The active current Space gets a small
 * boost; completed (not-yet-archived) Projects are slightly demoted. Each result
 * is annotated with lifecycle metadata so the UI can show a historical warning
 * when an archived source is cited.
 */
const ACTIVE_CURRENT_BOOST = 1.1;
const COMPLETED_PROJECT_MULT = 0.9;
const ARCHIVED_CURRENT_MULT = 0.3;
const ARCHIVED_HISTORICAL_MULT = 1.3;
const NONARCHIVED_HISTORICAL_MULT = 0.9;

async function applyLifecycleRanking(
  results: HybridSearchResult[],
  currentSpaceId: string | undefined,
  intent: 'current' | 'historical'
): Promise<HybridSearchResult[]> {
  if (results.length === 0) return results;
  const topicIds = [...new Set(results.filter((r) => r.topicId).map((r) => r.topicId!))];
  const spaceIds = [...new Set(results.map((r) => r.spaceId))];

  const topicMap = new Map<string, { lifecycleStatus: string; spaceId: string; archivedAt: string | null; mergedInto: string | null }>();
  if (topicIds.length) {
    const rows = await db.execute<any>(sql`
      SELECT id, lifecycle_status, space_id, archived_at, merged_into_topic_id
      FROM wiki_topics
      WHERE id = ANY(ARRAY[${sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `)}])
    `);
    for (const r of rows.rows) {
      topicMap.set(r.id, {
        lifecycleStatus: r.lifecycle_status,
        spaceId: r.space_id,
        archivedAt: r.archived_at ?? null,
        mergedInto: r.merged_into_topic_id ?? null
      });
    }
  }

  const spaceMap = new Map<string, { spaceKind: string; lifecycleStatus: string; name: string }>();
  if (spaceIds.length) {
    const rows = await db.execute<any>(sql`
      SELECT id, space_kind, lifecycle_status, name FROM spaces
      WHERE id = ANY(ARRAY[${sql.join(spaceIds.map((id) => sql`${id}::uuid`), sql`, `)}])
    `);
    for (const r of rows.rows) {
      spaceMap.set(r.id, { spaceKind: r.space_kind, lifecycleStatus: r.lifecycle_status, name: r.name });
    }
  }

  const out = results.map((r) => {
    const topic = r.topicId ? topicMap.get(r.topicId) : null;
    const space = spaceMap.get(r.spaceId);
    const isArchived = !!topic && (topic.lifecycleStatus === 'archived' || topic.mergedInto);

    let multiplier = 1;
    if (isArchived) {
      multiplier = intent === 'historical' ? ARCHIVED_HISTORICAL_MULT : ARCHIVED_CURRENT_MULT;
    } else if (intent === 'historical') {
      multiplier = NONARCHIVED_HISTORICAL_MULT;
    } else if (currentSpaceId && r.spaceId === currentSpaceId) {
      multiplier = ACTIVE_CURRENT_BOOST;
    } else if (space?.spaceKind === 'project' && space.lifecycleStatus === 'completed') {
      multiplier = COMPLETED_PROJECT_MULT;
    }

    return {
      ...r,
      score: r.score * multiplier,
      lifecycleStatus: topic?.lifecycleStatus ?? space?.lifecycleStatus ?? undefined,
      archivedAt: isArchived ? topic?.archivedAt ?? undefined : undefined,
      spaceName: space?.name ?? undefined,
      spaceKind: space?.spaceKind ?? undefined
    };
  });

  return out.sort((a, b) => b.score - a.score);
}

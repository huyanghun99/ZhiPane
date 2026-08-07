import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

export type SearchResult = {
  id: string; pageId?: string; spaceId?: string; title: string; content: string;
  excerpt?: string; snippet?: string; score?: number; source?: string;
};

/**
 * Search hook with: (1) AbortController that cancels the previous in-flight
 * request as soon as a new keystroke/query change arrives; (2) different
 * debounce per mode — keyword is cheap so it fires at 300ms, while
 * semantic/vector (which triggers a remote embedding) waits 600ms; (3) a
 * client-side result cache keyed by mode+scope+query so identical consecutive
 * queries never re-hit the server (and thus never re-trigger a remote
 * embedding). Works together with the server-side query-embedding cache.
 */
const CACHE_TTL_MS = 60_000; // Phase C2.4 (U10): results go stale after 60s.
type CacheVal = { value: SearchResult[]; ts: number };
const resultCache = new Map<string, CacheVal>();

export function useSearch(params: { workspaceId: string; spaceId?: string }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'keyword' | 'hybrid' | 'vector'>('hybrid');
  const [scope, setScope] = useState<'space' | 'workspace'>('space');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    const q = query.trim();
    if (!q) { setResults([]); setLoading(false); return; }

    // Cancel any still-running previous request immediately.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const cacheKey = `${mode}:${scope}:${q}`;
    const hit = resultCache.get(cacheKey);
    if (hit) {
      if (Date.now() - hit.ts < CACHE_TTL_MS) { setResults(hit.value); setLoading(false); setError(null); return; }
      resultCache.delete(cacheKey); // expired — fall through to a fresh request
    }

    setLoading(true);
    setError(null);
    try {
      const res = await api<{ results: SearchResult[] }>(`/api/search`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: params.workspaceId,
          ...(scope === 'space' ? { spaceId: params.spaceId } : {}),
          query: q,
          limit: 20,
          mode
        }),
        signal: ctrl.signal
      });
      resultCache.set(cacheKey, { value: res.results, ts: Date.now() });
      if (!ctrl.signal.aborted) setResults(res.results);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(err as Error);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [query, mode, scope, params.workspaceId, params.spaceId]);

  // Debounced auto-search; keyword is faster than semantic/vector.
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const delay = mode === 'keyword' ? 300 : 600;
    const t = setTimeout(() => run(), delay);
    return () => {
      clearTimeout(t);
      // Cancel the in-flight request the moment a new keystroke lands.
      abortRef.current?.abort();
    };
  }, [query, mode, scope, run]);

  return { query, setQuery, mode, setMode, scope, setScope, results, loading, error, run };
}

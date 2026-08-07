import { useEffect, useMemo } from 'react';
import { Loader2, Search } from 'lucide-react';
import { useSearch, type SearchResult } from '../../hooks/useSearch';
import { EmptyState } from '../../components/EmptyState';
import type { Space, Workspace } from '../../types';

// Split a query into highlightable terms: ASCII words + maximal Chinese runs.
function extractTerms(q: string): string[] {
  const terms: string[] = [];
  const ascii = q.toLowerCase().match(/[a-z0-9_]+/g);
  if (ascii) terms.push(...ascii);
  const cn = q.match(/[一-鿿]+/g);
  if (cn) terms.push(...cn);
  return [...new Set(terms)].sort((a, b) => b.length - a.length);
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function highlight(text: string, terms: string[]): React.ReactNode {
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<mark key={k++}>{m[0]}</mark>);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function SearchView({ workspace, space, spaces, initialQuery, onOpenPage }: {
  workspace: Workspace; space: Space; spaces: Space[]; initialQuery?: string; onOpenPage: (id: string) => void;
}) {
  const { query, setQuery, mode, setMode, scope, setScope, results, loading, error, run } = useSearch({
    workspaceId: workspace.id,
    spaceId: space.id
  });

  // Seed the query from the command palette / route entry point. The hook's own
  // debounce effect then runs the search once the query is non-empty.
  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery]);

  const terms = useMemo(() => extractTerms(query), [query]);
  const spaceName = useMemo(() => {
    const map = new Map(spaces.map((s) => [s.id, s.name]));
    return (id?: string) => (id ? map.get(id) ?? '其他 Space' : '');
  }, [spaces]);

  return (
    <div className="single-pane search-pane">
      <div className="search-bar">
        <Search size={18} />
        <input autoFocus value={query} placeholder="搜索笔记（支持中文分词）…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); }} />
        {loading && <Loader2 className="spin search-spin" size={15} />}
        <div className="seg">
          <button className={scope === 'space' ? 'active' : ''} onClick={() => setScope('space')}>本 Space</button>
          <button className={scope === 'workspace' ? 'active' : ''} onClick={() => setScope('workspace')}>全部</button>
        </div>
        <div className="seg">
          {(['keyword', 'hybrid', 'vector'] as const).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{m === 'keyword' ? '关键词' : m === 'hybrid' ? '混合' : '语义'}</button>
          ))}
        </div>
        <button className="primary" disabled={!query.trim()} onClick={run}>
          搜索
        </button>
      </div>
      <div className="search-hint">
        <span>提示：</span>
        <kbd>⌘/Ctrl</kbd> + <kbd>K</kbd> 随时唤起搜索 · 输入即实时检索 · 「全部」跨所有可读 Space
      </div>
      {error && <p className="error">{String(error.message)}</p>}
      <div className="results">
        {query.trim() && !loading && results.length === 0 && (
          <EmptyState icon={<Search size={32} />} title="没有匹配的结果" hint="试试更换关键词，或切换到「语义」模式，或选择「全部」范围。" />
        )}
        {results.map((r: SearchResult, i) => (
          <button className="result-card" key={r.pageId ?? r.id ?? i} onClick={() => r.pageId && onOpenPage(r.pageId)}>
            <div className="result-head">
              <b>{highlight(r.title, terms)}</b>
              {scope === 'workspace' && r.spaceId && <span className="tag space">{spaceName(r.spaceId)}</span>}
              {r.source && <span className="tag">{r.source === 'both' ? '关键词+语义' : r.source === 'bm25' ? '关键词' : '语义'}</span>}
              {typeof r.score === 'number' && <span className="muted small">score {r.score.toFixed(3)}</span>}
            </div>
            {(r.excerpt || r.content || r.snippet) && <p className="muted">{highlight(r.excerpt ?? r.snippet ?? r.content, terms)}</p>}
          </button>
        ))}
      </div>
    </div>
  );
}

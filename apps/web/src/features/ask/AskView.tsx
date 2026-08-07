import { useRef, useState } from 'react';
import { Brain, Loader2, Send, Sparkles, SearchX } from 'lucide-react';
import { streamRag } from '../../api';
import { EmptyState } from '../../components/EmptyState';
import type { Space, Workspace } from '../../types';

type Citation = { chunkId?: string; pageId?: string; title?: string; excerpt?: string; score?: number };

// Render the answer while turning inline [n] citation markers into clickable
// badges that jump to the referenced source page (strict-citation UX).
function renderAnswer(answer: string, citations: Citation[], onOpen: (pageId: string) => void) {
  const parts = answer.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (m) {
      const c = citations[Number(m[1]) - 1];
      const pid = c?.pageId;
      return (
        <button key={i} className="cite-badge" title={c?.title ?? `引用 ${m[1]}`} onClick={() => pid && onOpen(pid)}>
          {m[1]}
        </button>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function relevanceLabel(score?: number): string {
  if (typeof score !== 'number') return '相关';
  const pct = Math.round(Math.min(1, Math.max(0, score)) * 100);
  if (pct >= 75) return '高度相关';
  if (pct >= 45) return '相关';
  return '弱相关';
}

export function AskView({ workspace, space, onOpenPage }: { workspace: Workspace; space: Space; onOpenPage: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [extended, setExtended] = useState(false);
  const [retrieving, setRetrieving] = useState(false);
  const [sources, setSources] = useState<Citation[]>([]);
  const [answer, setAnswer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const ask = () => {
    if (!query.trim() || streaming) return;
    setStreaming(true);
    setRetrieving(true);
    setSources([]);
    setAnswer('');
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    streamRag(
      { workspaceId: workspace.id, spaceId: space.id, query, extendedThinking: extended },
      (ev) => {
        if (ev.type === 'sources') { setSources(ev.citations as Citation[]); setRetrieving(false); }
        else if (ev.type === 'token') setAnswer((a) => a + ev.text);
        else if (ev.type === 'error') { setError(ev.message); setStreaming(false); setRetrieving(false); }
        else if (ev.type === 'done') { setStreaming(false); setRetrieving(false); }
      },
      ac.signal
    ).catch(() => { setStreaming(false); setRetrieving(false); });
  };

  const openChunk = (c: Citation) => { if (c.pageId) onOpenPage(c.pageId); };
  const hasAnswer = answer.length > 0;
  const noResults = !retrieving && !streaming && sources.length === 0 && hasAnswer;

  return (
    <div className="single-pane">
      <div className={`ask-head${extended ? ' extended' : ''}`}>
        <h3><Brain size={18} /> 带引用的问答 <span className="tag">strict citation</span></h3>
        <label className={`switch et-switch${extended ? ' on' : ''}`} title="开启后模型会做更深入的多步推理，回答更严谨但更慢">
          <input type="checkbox" checked={extended} onChange={(e) => setExtended(e.target.checked)} />
          <Sparkles size={14} /> 扩展思考{extended && <span className="et-pill">已开启</span>}
        </label>
      </div>
      <div className="search-bar">
        <input autoFocus value={query} placeholder="向你的知识库提问…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && query.trim()) ask(); }} />
        <button className="primary" disabled={!query.trim() || streaming} onClick={ask}>
          {streaming ? <Loader2 className="spin" size={15} /> : <Send size={15} />} 提问
        </button>
      </div>
      {error && <p className="error">{error}</p>}

      {/* Retrieving skeleton — shown the instant a question is asked, before
          the `sources` event arrives, so the user sees progress immediately. */}
      {retrieving && (
        <div className="answer-card retrieving">
          <div className="retrieving-head"><Loader2 className="spin" size={15} /> 正在检索知识库…</div>
          <div className="skel-list">
            <div className="skel-row"><div className="skeleton skel-line-el" style={{ width: '70%' }} /><div className="skeleton skel-line-el" style={{ width: '30%' }} /></div>
            <div className="skel-row"><div className="skeleton skel-line-el" style={{ width: '55%' }} /><div className="skeleton skel-line-el" style={{ width: '40%' }} /></div>
            <div className="skel-row"><div className="skeleton skel-line-el" style={{ width: '80%' }} /><div className="skeleton skel-line-el" style={{ width: '25%' }} /></div>
          </div>
        </div>
      )}

      {/* Friendly empty state when nothing matched (no sources, refusal answer). */}
      {noResults && (
        <div className="answer-card no-answer">
          <EmptyState
            icon={<SearchX size={34} />}
            title="知识库中未找到相关信息"
            hint="试着换一种问法，或切换到一个更相关的空间再提问。"
          />
        </div>
      )}

      {(sources.length > 0 || (hasAnswer && !noResults)) && (
        <div className="answer-card">
          {sources.length > 0 && (
            <div className="rp-ai-cites">
              <span className="muted small">来源（先出现，可点击跳转）</span>
              <div className="src-cards">
                {sources.map((c, i) => (
                  <button key={c.chunkId ?? i} className="src-card" title={c.excerpt} onClick={() => openChunk(c)}>
                    <span className="src-idx">[{i + 1}]</span>
                    <span className="src-main">
                      <span className="src-title">{c.title || '来源'}</span>
                      <span className="src-meta">
                        <span className="src-space">{space.name}</span>
                        <span className={`src-rel rel-${typeof c.score === 'number' ? (c.score >= 0.75 ? 'hi' : c.score >= 0.45 ? 'mid' : 'lo') : 'na'}`}>
                          {relevanceLabel(c.score)}
                        </span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {hasAnswer && !noResults && (
            <p className="answer-text">{renderAnswer(answer, sources, onOpenPage)}</p>
          )}
          {streaming && <span className="stream-cursor" />}
        </div>
      )}

      {!streaming && !retrieving && sources.length === 0 && !hasAnswer && !error && (
        <EmptyState icon={<Brain size={32} />} title="向知识库提问" hint="回答会先列出引用来源，再逐步生成内容，便于回到原文核对。" />
      )}
    </div>
  );
}

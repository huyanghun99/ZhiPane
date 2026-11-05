import { useEffect, useRef, useState } from 'react';
import { Brain, Loader2, Send, Sparkles, Square, Trash2 } from 'lucide-react';
import { streamRag } from '../../api';
import { applyRagEvent, finishTurn, startTurn, type ChatCitation, type ChatMessage } from './chat';
import type { Space, Workspace } from '../../types';

// Render the answer while turning inline [n] citation markers into clickable
// badges that jump to the referenced source page (strict-citation UX).
function renderAnswer(answer: string, citations: ChatCitation[], onOpen: (pageId: string) => void) {
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

function SourceList({ citations, spaceName, onOpenPage }: {
  citations: ChatCitation[];
  spaceName: string;
  onOpenPage: (id: string) => void;
}) {
  if (citations.length === 0) return null;
  return (
    <div className="chat-sources">
      {citations.map((c, i) => (
        <button key={c.chunkId ?? i} className="src-card" title={c.excerpt}
          onClick={() => { if (c.pageId) onOpenPage(c.pageId); }}>
          <span className="src-idx">[{i + 1}]</span>
          <span className="src-main">
            <span className="src-title">{c.title || '来源'}</span>
            <span className="src-meta">
              <span className="src-space">{spaceName}</span>
              <span className={`src-rel rel-${typeof c.score === 'number' ? (c.score >= 0.75 ? 'hi' : c.score >= 0.45 ? 'mid' : 'lo') : 'na'}`}>
                {relevanceLabel(c.score)}
              </span>
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

let turnSeq = 0;

export function AskView({ workspace, space, onOpenPage }: {
  workspace: Workspace;
  space: Space;
  onOpenPage: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [extended, setExtended] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Keep the newest turn visible as tokens stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (activeAssistantId) {
      setMessages((prev) => finishTurn(prev, activeAssistantId, 'aborted'));
      setActiveAssistantId(null);
    }
    setStreaming(false);
  };

  const ask = () => {
    const question = query.trim();
    if (!question || streaming) return;

    const turnId = `t${++turnSeq}`;
    const assistantId = `${turnId}:assistant`;
    setMessages((prev) => startTurn(prev, turnId, question));
    setActiveAssistantId(assistantId);
    setQuery('');
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    streamRag(
      { workspaceId: workspace.id, spaceId: space.id, query: question, extendedThinking: extended },
      (ev) => setMessages((prev) => applyRagEvent(prev, assistantId, ev)),
      ac.signal
    )
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        setMessages((prev) => finishTurn(prev, assistantId, 'error', e.message));
      })
      .finally(() => {
        if (abortRef.current === ac) {
          abortRef.current = null;
          setActiveAssistantId(null);
          setStreaming(false);
          setMessages((prev) => finishTurn(prev, assistantId, 'done'));
        }
      });
  };

  const clear = () => {
    if (streaming) stop();
    setMessages([]);
    inputRef.current?.focus();
  };

  return (
    <div className="chat-view">
      <div className={`ask-head${extended ? ' extended' : ''}`}>
        <h3><Brain size={18} /> 带引用的问答 <span className="tag">strict citation</span></h3>
        <div className="ask-head-actions">
          <label className={`switch et-switch${extended ? ' on' : ''}`} title="开启后模型会做更深入的多步推理，回答更严谨但更慢">
            <input type="checkbox" checked={extended} onChange={(e) => setExtended(e.target.checked)} />
            <Sparkles size={14} /> 扩展思考{extended && <span className="et-pill">已开启</span>}
          </label>
          {messages.length > 0 && (
            <button className="chat-clear" title="清空对话" onClick={clear}><Trash2 size={14} /> 清空</button>
          )}
        </div>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <span className="chat-empty-icon"><Brain size={30} /></span>
            <h4>向知识库提问</h4>
            <p>回答会先列出引用来源，再逐步生成内容，便于回到原文核对。连续提问会保留在这段对话里。</p>
            <div className="chat-suggestions">
              {['这个空间里有哪些主题？', '总结最近整理的结论', '列出与项目相关的笔记'].map((s) => (
                <button key={s} onClick={() => { setQuery(s); inputRef.current?.focus(); }}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`chat-row ${m.role}`}>
            {m.role === 'assistant' && <span className="chat-avatar"><Brain size={15} /></span>}
            <div className={`chat-bubble ${m.role}`}>
              {m.role === 'assistant' && m.status === 'retrieving' && (
                <div className="chat-retrieving"><Loader2 className="spin" size={14} /> 正在检索知识库…</div>
              )}
              {m.status === 'error' && <p className="error chat-error">{m.error || '本轮回答失败'}</p>}
              {m.role === 'assistant' && m.status === 'aborted' && !m.content && (
                <span className="muted small">已中止本轮回答</span>
              )}
              {m.content && (
                <p className="answer-text">{renderAnswer(m.content, m.citations, onOpenPage)}</p>
              )}
              {m.role === 'assistant' && m.status === 'streaming' && <span className="stream-cursor" />}
              {m.role === 'assistant' && m.status === 'done' && m.citations.length === 0 && m.content && (
                <p className="muted small chat-no-result">知识库中未找到直接引用，可换一种问法或切换空间。</p>
              )}
              {m.role === 'assistant' && (
                <SourceList citations={m.citations} spaceName={space.name} onOpenPage={onOpenPage} />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-composer">
        <textarea
          ref={inputRef}
          value={query}
          rows={1}
          placeholder="向你的知识库提问…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
          }}
        />
        {streaming ? (
          <button className="chat-stop" onClick={stop} title="中止本轮"><Square size={14} /> 中止</button>
        ) : (
          <button className="primary" disabled={!query.trim()} onClick={ask}><Send size={15} /> 发送</button>
        )}
      </div>
      <p className="chat-hint">Enter 发送 · Shift+Enter 换行 · 每段回答均附引用来源</p>
    </div>
  );
}

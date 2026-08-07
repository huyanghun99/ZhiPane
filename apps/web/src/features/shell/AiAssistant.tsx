/**
 * F12: Floating AI Assistant — bottom-right floating ball + drawer.
 *
 * Opens an AI chat drawer that can:
 *   - Ask questions about the current page
 *   - Search across the knowledge base
 *   - Select scope (current page / current space / all spaces)
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Brain, X, Send, Loader2, Sparkles, Bot, MessageSquare } from 'lucide-react';
import { streamRag } from '../../api';
import type { Space, Workspace } from '../../types';

type Scope = 'page' | 'space' | 'workspace';
type Citation = { chunkId?: string; pageId?: string; title?: string; excerpt?: string; score?: number };

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  citations?: Citation[];
}

export function AiAssistant({ workspace, space, pageId }: {
  workspace: Workspace | null;
  space: Space | null;
  pageId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('space');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [retrieving, setRetrieving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [ballPos, setBallPos] = useState({ x: -1, y: -1 });
  const dragStart = useRef<{ x: number; y: number; bx: number; by: number } | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // Drag the floating ball
  const onBallMouseDown = useCallback((e: React.MouseEvent) => {
    if (ballPos.x < 0) {
      // First drag: initialize from current position (bottom-right default)
      const ball = e.currentTarget as HTMLElement;
      const rect = ball.getBoundingClientRect();
      setBallPos({ x: rect.left, y: rect.top });
    }
    setDragging(true);
    const ball = e.currentTarget as HTMLElement;
    const rect = ball.getBoundingClientRect();
    dragStart.current = { x: e.clientX, y: e.clientY, bx: rect.left, by: rect.top };
  }, [ballPos.x]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      if (!dragStart.current) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      const nx = Math.max(0, Math.min(window.innerWidth - 48, dragStart.current.bx + dx));
      const ny = Math.max(0, Math.min(window.innerHeight - 48, dragStart.current.by + dy));
      setBallPos({ x: nx, y: ny });
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const ask = () => {
    if (!input.trim() || streaming || !workspace) return;
    const q = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text: q }]);
    setStreaming(true);
    setRetrieving(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const ragParams: Parameters<typeof streamRag>[0] = {
      workspaceId: workspace.id,
      spaceId: scope === 'workspace' ? undefined : space?.id,
      query: q,
      extendedThinking: false,
    };
    if (scope === 'page' && pageId) {
      (ragParams as Record<string, unknown>).pageId = pageId;
    }

    let answer = '';
    let cites: Citation[] = [];

    streamRag(ragParams, (ev: { type: string; text?: string; message?: string; citations?: unknown[] }) => {
      if (ev.type === 'sources') {
        cites = ev.citations as Citation[];
        setRetrieving(false);
      } else if (ev.type === 'token') {
        answer += ev.text;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, text: answer, citations: cites };
          } else {
            next.push({ role: 'assistant', text: answer, citations: cites });
          }
          return next;
        });
      } else if (ev.type === 'error') {
        setMessages((prev) => [...prev, { role: 'assistant', text: `出错了：${ev.message}` }]);
        setStreaming(false);
        setRetrieving(false);
      } else if (ev.type === 'done') {
        setStreaming(false);
        setRetrieving(false);
        if (!answer) {
          setMessages((prev) => [...prev, { role: 'assistant', text: '知识库中未找到相关信息。' }]);
        }
      }
    }, ac.signal).catch(() => {
      setStreaming(false);
      setRetrieving(false);
    });
  };

  const ballStyle: React.CSSProperties = ballPos.x >= 0
    ? { position: 'fixed', left: ballPos.x, top: ballPos.y, bottom: 'auto', right: 'auto' }
    : {};

  return (
    <>
      {/* Floating ball — bottom-right, draggable */}
      <button
        className={`ai-fab${open ? ' hidden' : ''}`}
        style={ballStyle}
        onMouseDown={onBallMouseDown}
        onClick={() => !dragging && setOpen(true)}
        title="AI 助手"
      >
        <Brain size={22} />
      </button>

      {/* Drawer — right side */}
      {open && (
        <div className="ai-drawer">
          <div className="ai-drawer-head">
            <div className="ai-drawer-title">
              <Bot size={18} /> AI 助手
            </div>
            <div className="ai-scope-bar">
              <button className={`ai-scope-btn${scope === 'page' ? ' active' : ''}`} disabled={!pageId} onClick={() => setScope('page')}>
                本页
              </button>
              <button className={`ai-scope-btn${scope === 'space' ? ' active' : ''}`} disabled={!space} onClick={() => setScope('space')}>
                本空间
              </button>
              <button className={`ai-scope-btn${scope === 'workspace' ? ' active' : ''}`} onClick={() => setScope('workspace')}>
                全部
              </button>
            </div>
            <button className="ai-drawer-close" onClick={() => setOpen(false)}>
              <X size={18} />
            </button>
          </div>

          <div className="ai-drawer-body" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="ai-empty">
                <MessageSquare size={32} />
                <p>向 AI 助手提问，它会基于你的知识库回答并标注引用来源。</p>
                <div className="ai-suggestions">
                  <button onClick={() => setInput('总结一下当前页面的要点')}>总结当前页面</button>
                  <button onClick={() => setInput('这个主题有哪些关键信息？')}>关键信息</button>
                  <button onClick={() => setInput('帮我找到相关的笔记')}>查找相关</button>
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`ai-msg ${msg.role}`}>
                {msg.role === 'assistant' && <Sparkles size={14} className="ai-msg-icon" />}
                <div className="ai-msg-text">{msg.text}</div>
                {msg.citations && msg.citations.length > 0 && (
                  <div className="ai-msg-cites">
                    {msg.citations.map((c, ci) => (
                      <button
                        key={c.chunkId ?? ci}
                        className="ai-cite-chip"
                        title={c.excerpt}
                        onClick={() => c.pageId && window.dispatchEvent(new CustomEvent('zhipane:navigate-page', { detail: c.pageId }))}
                      >
                        [{ci + 1}] {c.title || '来源'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {retrieving && (
              <div className="ai-msg assistant">
                <Loader2 size={14} className="spin" />
                <span className="muted small">正在检索知识库…</span>
              </div>
            )}
          </div>

          <div className="ai-drawer-input">
            <input
              value={input}
              placeholder="输入问题…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) ask(); }}
            />
            <button className="ai-send-btn" disabled={!input.trim() || streaming} onClick={ask}>
              {streaming ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

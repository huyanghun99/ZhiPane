import { useEffect, useRef, useState } from 'react';
import { Check, Copy, CornerDownLeft, Loader2, RotateCw, Sparkles, X } from 'lucide-react';
import { streamRag } from '../api';
import { AI_ACTIONS, type AiActionKind } from './ai-actions';

export interface AiRequest {
  kind: AiActionKind;
  sourceText: string;
  /** Screen-space anchor (selection / block) the popover points at. */
  anchor: { top: number; left: number };
  onReplace?: (text: string) => void;
  onInsert: (text: string) => void;
}

/**
 * Streaming AI result popover (Phase 3).
 *
 * Runs a single AI action via the RAG stream, shows the answer as it arrives,
 * and lets the user replace the selection, insert below, copy, retry or
 * discard. Fully keyboard-dismissable (Esc).
 */
export function AiPopover({
  request,
  workspaceId,
  spaceId,
  pageId,
  onClose
}: {
  request: AiRequest;
  workspaceId: string;
  spaceId: string;
  pageId?: string;
  onClose: () => void;
}) {
  const def = AI_ACTIONS[request.kind];
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  const run = () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const runId = ++runIdRef.current;
    setText('');
    setError('');
    setStatus('loading');
    let acc = '';
    void streamRag(
      {
        workspaceId,
        spaceId,
        pageId,
        query: def.buildPrompt(request.sourceText),
        limit: 4
      },
      (ev) => {
        if (runId !== runIdRef.current) return;
        if (ev.type === 'token') {
          acc += ev.text;
          setText(acc);
        } else if (ev.type === 'done') {
          if (ev.answer) setText(ev.answer);
          setStatus('done');
        } else if (ev.type === 'error') {
          setError(ev.message || 'AI 请求失败');
          setStatus('error');
        }
      },
      ctrl.signal
    ).catch((e) => {
      if (runId !== runIdRef.current) return;
      setError((e as Error)?.message ?? 'AI 请求失败');
      setStatus('error');
    });
  };

  useEffect(() => {
    run();
    return () => abortRef.current?.abort();
  }, [request]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const result = text.trim();
  const ready = status !== 'loading' && !!result;

  const doReplace = () => { if (result && request.onReplace) { request.onReplace(result); onClose(); } };
  const doInsert = () => { if (result) { request.onInsert(result); onClose(); } };
  const doCopy = async () => {
    try { await navigator.clipboard.writeText(result); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ }
  };

  const top = Math.min(request.anchor.top + 8, window.innerHeight - 60);
  const left = Math.min(Math.max(12, request.anchor.left - 180), window.innerWidth - 372);

  return (
    <div className="ai-pop" style={{ top, left }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="ai-pop-head">
        <span className="ai-pop-title"><Sparkles size={14} /> AI {def.label}</span>
        <button className="ai-pop-x" title="关闭" onClick={onClose}><X size={14} /></button>
      </div>

      <div className="ai-pop-body">
        {status === 'error' ? (
          <div className="ai-pop-error">{error}</div>
        ) : (
          <div className="ai-pop-text">
            {result || <span className="ai-pop-hint"><Loader2 className="spin" size={13} /> 正在生成…</span>}
            {status === 'loading' && result && <span className="ai-caret" />}
          </div>
        )}
      </div>

      <div className="ai-pop-actions">
        {status === 'error' ? (
          <button className="ai-pop-btn" onClick={run}><RotateCw size={13} /> 重试</button>
        ) : (
          <>
            {def.canReplace && request.onReplace && (
              <button className="ai-pop-btn primary" disabled={!ready} onClick={doReplace}><Check size={13} /> 替换</button>
            )}
            <button className="ai-pop-btn" disabled={!ready} onClick={doInsert}><CornerDownLeft size={13} /> 插入下方</button>
            <button className="ai-pop-btn" disabled={!ready} onClick={doCopy}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? '已复制' : '复制'}
            </button>
            <button className="ai-pop-btn" disabled={status === 'loading'} onClick={run}><RotateCw size={13} /> 重试</button>
          </>
        )}
      </div>
    </div>
  );
}

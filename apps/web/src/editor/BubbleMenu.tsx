import { useCallback, useEffect, useRef, useState } from 'react';
import { type Editor } from '@tiptap/react';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code, Highlighter,
  Link as LinkIcon, Check, Sparkles, ChevronDown, Type
} from 'lucide-react';
import { AI_ACTIONS, BUBBLE_AI_ACTIONS, type AiActionKind } from './ai-actions';

const PRESET_COLORS = ['#1a2233', '#dc2626', '#ea580c', '#d97706', '#16a34a', '#0891b2'];

// Block / atom nodes that own their own UI — the bubble menu should not
// cover them with a text-formatting bar.
const NON_TEXT = new Set([
  'mermaid', 'embed', 'drawio', 'excalidraw', 'image', 'video',
  'audio', 'pdf', 'file', 'mathBlock', 'mathInline', 'callout', 'toggle'
]);

const SHOW_DELAY = 200;

/**
 * Bubble Menu (Phase 3 — task 4).
 *
 * Appears ~200ms after a *text* range is selected (delay avoids flicker on
 * transient selections). Positioned centered above the selection. Provides
 * inline formatting, a link editor, text colors and AI actions
 * (polish / translate / summarize / explain). All actions use
 * onMouseDown + preventDefault so the editor selection is preserved.
 */
export function BubbleMenu({
  editor,
  onAi
}: {
  editor: Editor;
  onAi?: (kind: AiActionKind, text: string, anchor: { top: number; left: number }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [linkOpen, setLinkOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [active, setActive] = useState({ bold: false, italic: false, underline: false, strike: false, code: false, highlight: false, link: false });
  const [turnOpen, setTurnOpen] = useState(false);

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };

  const update = useCallback(() => {
    const { from, to, empty } = editor.state.selection;
    if (empty) {
      clearTimer();
      setShow(false);
      setLinkOpen(false);
      setAiOpen(false);
      return;
    }
    const node = editor.state.doc.nodeAt(from);
    if (node && NON_TEXT.has(node.type.name)) {
      clearTimer();
      setShow(false);
      return;
    }
    try {
      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      setPos({ top: Math.min(start.top, end.top), left: (start.left + end.left) / 2 });
      setActive({
        bold: editor.isActive('bold'),
        italic: editor.isActive('italic'),
        underline: editor.isActive('underline'),
        strike: editor.isActive('strike'),
        code: editor.isActive('code'),
        highlight: editor.isActive('highlight'),
        link: editor.isActive('link')
      });
      if (!show) {
        clearTimer();
        timerRef.current = setTimeout(() => setShow(true), SHOW_DELAY);
      }
    } catch {
      setShow(false);
    }
  }, [editor, show]);

  useEffect(() => {
    editor.on('selectionUpdate', update);
    return () => {
      editor.off('selectionUpdate', update);
      clearTimer();
    };
  }, [editor, update]);

  useEffect(() => {
    const hide = () => { clearTimer(); setShow(false); };
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, []);

  // Mod-k (with a selection) opens the link editor via a custom event.
  const openLink = useCallback(() => {
    setLinkUrl(editor.getAttributes('link').href ?? '');
    setLinkOpen(true);
    if (!show) setShow(true);
  }, [editor, show]);
  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    const handler = () => openLink();
    dom.addEventListener('zhipane:edit-link', handler);
    return () => dom.removeEventListener('zhipane:edit-link', handler);
  }, [editor, openLink]);

  // Viewport collision detection: once the menu is shown, keep it fully inside
  // the viewport so it never overflows off-screen on selections near edges.
  useEffect(() => {
    if (!show || !ref.current) return;
    const el = ref.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let { top, left } = pos;
    if (rect.right > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - rect.width - pad);
    if (rect.left < pad) left = pad;
    if (rect.bottom > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - rect.height - pad);
    if (rect.top < pad) top = pad;
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
  }, [show, pos]);

  if (!show) return null;

  const stop = (e: React.MouseEvent) => e.preventDefault();

  const applyLink = () => {
    const url = linkUrl.trim();
    if (!url) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setLinkOpen(false);
    setLinkUrl('');
  };

  const runAi = (kind: AiActionKind) => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n', ' ').trim();
    setAiOpen(false);
    setShow(false);
    if (text && onAi) onAi(kind, text, pos);
  };

  // "Turn into": convert the block that contains the current selection into
  // another type (heading / paragraph / list / quote / code).
  const turnInto = (kind: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'quote' | 'code') => {
    const { from } = editor.state.selection;
    editor.chain().focus().setTextSelection(from).run();
    switch (kind) {
      case 'h1': editor.chain().focus().toggleHeading({ level: 1 }).run(); break;
      case 'h2': editor.chain().focus().toggleHeading({ level: 2 }).run(); break;
      case 'h3': editor.chain().focus().toggleHeading({ level: 3 }).run(); break;
      case 'p': editor.chain().focus().setParagraph().run(); break;
      case 'ul': editor.chain().focus().toggleBulletList().run(); break;
      case 'ol': editor.chain().focus().toggleOrderedList().run(); break;
      case 'quote': editor.chain().focus().toggleBlockquote().run(); break;
      case 'code': editor.chain().focus().toggleCodeBlock().run(); break;
    }
    setTurnOpen(false);
    setShow(false);
  };

  return (
    <div ref={ref} className="bubble-menu" style={{ display: 'flex', top: pos.top, left: pos.left }}>
      <button type="button" className={`bub-btn${turnOpen ? ' active' : ''}`} title="转换为" onMouseDown={stop} onClick={() => { setTurnOpen((o) => !o); setAiOpen(false); setLinkOpen(false); }}><Type size={15} /></button>
      {turnOpen && (
        <div className="bub-turn-menu" onMouseDown={(e) => e.preventDefault()}>
          {([['h1', '标题 1'], ['h2', '标题 2'], ['h3', '标题 3'], ['p', '正文'], ['ul', '无序列表'], ['ol', '有序列表'], ['quote', '引用'], ['code', '代码块']] as const).map(([k, label]) => (
            <button key={k} type="button" className="bub-ai-item" onClick={() => turnInto(k)}>{label}</button>
          ))}
        </div>
      )}

      <button type="button" className={`bub-btn${active.bold ? ' active' : ''}`} title="加粗" onMouseDown={stop} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></button>
      <button type="button" className={`bub-btn${active.italic ? ' active' : ''}`} title="斜体" onMouseDown={stop} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></button>
      <button type="button" className={`bub-btn${active.underline ? ' active' : ''}`} title="下划线" onMouseDown={stop} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon size={15} /></button>
      <button type="button" className={`bub-btn${active.strike ? ' active' : ''}`} title="删除线" onMouseDown={stop} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={15} /></button>
      <button type="button" className={`bub-btn${active.code ? ' active' : ''}`} title="行内代码" onMouseDown={stop} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={15} /></button>
      <button type="button" className={`bub-btn${active.highlight ? ' active' : ''}`} title="高亮" onMouseDown={stop} onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter size={15} /></button>
      <span className="bub-sep" />
      {PRESET_COLORS.slice(0, 6).map((c) => (
        <button key={c} type="button" className="bub-swatch" style={{ background: c }} title="文字颜色" onMouseDown={stop} onClick={() => editor.chain().focus().setColor(c).run()} />
      ))}
      <span className="bub-sep" />
      <button type="button" className={`bub-btn${active.link ? ' active' : ''}`} title="链接" onMouseDown={stop} onClick={() => { setLinkUrl(editor.getAttributes('link').href ?? ''); setLinkOpen((o) => !o); setAiOpen(false); }}><LinkIcon size={15} /></button>
      {onAi && (
        <button type="button" className={`bub-btn bub-ai${aiOpen ? ' active' : ''}`} title="AI 操作" onMouseDown={stop} onClick={() => { setAiOpen((o) => !o); setLinkOpen(false); }}>
          <Sparkles size={15} /> <ChevronDown size={11} />
        </button>
      )}

      {aiOpen && onAi && (
        <div className="bub-ai-menu" onMouseDown={(e) => e.preventDefault()}>
          {BUBBLE_AI_ACTIONS.map((k) => (
            <button key={k} type="button" className="bub-ai-item" onClick={() => runAi(k)}>
              <span className="bub-ai-icon">{AI_ACTIONS[k].icon}</span> {AI_ACTIONS[k].label}
            </button>
          ))}
        </div>
      )}

      {linkOpen && (
        <div className="bub-link-bar" onMouseDown={(e) => e.stopPropagation()}>
          <input
            autoFocus
            value={linkUrl}
            placeholder="https://…"
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyLink(); if (e.key === 'Escape') { setLinkOpen(false); setLinkUrl(''); } }}
          />
          <button className="primary sm" onMouseDown={stop} onClick={applyLink}><Check size={13} /></button>
        </div>
      )}
    </div>
  );
}

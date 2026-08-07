import { useEffect, useRef, useState } from 'react';
import { type Editor } from '@tiptap/react';
import { GripVertical, Trash2, Copy } from 'lucide-react';

interface BlockRange {
  from: number;
  to: number;
}

/**
 * Block Handle + drag-to-reorder (Phase4 — task 4).
 *
 * A hover-only grip rendered in the left gutter of the block under the
 * cursor (AGENTS.md: "Block Handle 只在 Hover 时出现"). Dragging the
 * grip reorders the block: we hand ProseMirror a `dragging` slice so its
 * native (Dropcursor-aware) drop handling performs the move — no custom
 * drop math required.
 *
 * Clicking the grip opens a small menu with 复制 / 删除.
 */
export function BlockHandle({ editor }: { editor: Editor }) {
  const handleRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const rangeRef = useRef<BlockRange | null>(null);

  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    if (!dom) return;

    const findBlock = (clientX: number, clientY: number): HTMLElement | null => {
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      if (!el) return null;
      let node: HTMLElement | null = el;
      while (node && node.parentElement !== dom) node = node.parentElement;
      return node && node !== dom ? node : null;
    };

    const hide = () => {
      if (handleRef.current) handleRef.current.style.display = 'none';
      rangeRef.current = null;
    };

    // Keep the handle visible when the pointer moves from the editor onto the
    // grip itself (the grip is a sibling outside the editor DOM, so a plain
    // mouseleave would hide it before the user can grab it).
    const onLeave = (e: MouseEvent) => {
      if (handleRef.current && e.relatedTarget && handleRef.current.contains(e.relatedTarget as Node)) return;
      hide();
    };

    const onMove = (e: MouseEvent) => {
      if (menuOpen) return;
      const block = findBlock(e.clientX, e.clientY);
      const handle = handleRef.current;
      if (!block || !handle) return hide();
      const rect = block.getBoundingClientRect();
      handle.style.display = 'flex';
      handle.style.top = `${rect.top + 2}px`;
      handle.style.left = `${Math.max(6, rect.left - 28)}px`;
      try {
        const pos = editor.view.posAtDOM(block, 0);
        const $pos = editor.state.doc.resolve(pos);
        const depth = $pos.depth || 1;
        const start = $pos.start(depth);
        const node = $pos.node(depth);
        rangeRef.current = { from: start, to: start + node.nodeSize };
      } catch {
        rangeRef.current = null;
      }
    };

    dom.addEventListener('mousemove', onMove);
    dom.addEventListener('mouseleave', onLeave);
    return () => {
      dom.removeEventListener('mousemove', onMove);
      dom.removeEventListener('mouseleave', onLeave);
    };
  }, [editor, menuOpen]);

  const onDragStart = (e: React.DragEvent) => {
    const range = rangeRef.current;
    if (!range) {
      e.preventDefault();
      return;
    }
    const slice = editor.state.doc.slice(range.from, range.to);
    (editor.view as unknown as { dragging: unknown }).dragging = { slice, move: true };
    e.dataTransfer.effectAllowed = 'move';
    // Some browsers require data to start a drag.
    try {
      e.dataTransfer.setData('text/html', '');
      e.dataTransfer.setData('text/plain', '');
    } catch {
      /* ignore */
    }
  };

  const onDragEnd = () => {
    (editor.view as unknown as { dragging: unknown }).dragging = null;
  };

  const duplicate = () => {
    const range = rangeRef.current;
    if (!range) return;
    const node = editor.state.doc.nodeAt(range.from);
    if (!node) return;
    editor.chain().focus().insertContentAt(range.to, node.toJSON()).run();
    setMenuOpen(false);
  };

  const remove = () => {
    const range = rangeRef.current;
    if (!range) return;
    editor.chain().focus().deleteRange({ from: range.from, to: range.to }).run();
    setMenuOpen(false);
  };

  // Phase C2.6 (U12): convert the hovered block into another type. We first
  // move the selection onto the captured block range, then run the block
  // command (toggle*) so it applies to the right node.
  const convertTo = (kind: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'quote' | 'code') => {
    const range = rangeRef.current;
    if (!range) return;
    editor.chain().focus().setTextSelection(range).run();
    switch (kind) {
      case 'h1': editor.chain().focus().toggleHeading({ level: 1 }).run(); break;
      case 'h2': editor.chain().focus().toggleHeading({ level: 2 }).run(); break;
      case 'h3': editor.chain().focus().toggleHeading({ level: 3 }).run(); break;
      case 'p': editor.chain().focus().setParagraph().run(); break;
      case 'ul': editor.chain().focus().toggleBulletList().run(); break;
      case 'quote': editor.chain().focus().toggleBlockquote().run(); break;
      case 'code': editor.chain().focus().toggleCodeBlock().run(); break;
    }
    setConvertOpen(false);
    setMenuOpen(false);
  };

  return (
    <div ref={handleRef} className="block-handle" style={{ display: 'none' }} onDragEnd={onDragEnd}>
      <button
        type="button"
        className="block-handle-grip"
        title="拖动以移动；点击打开操作"
        draggable
        onDragStart={onDragStart}
        onClick={() => setMenuOpen((o) => !o)}
        onMouseDown={(e) => e.preventDefault()}
      >
        <GripVertical size={14} />
      </button>
      {menuOpen && (
        <div className="block-menu" onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" className="block-menu-item" onClick={duplicate}>
            <Copy size={13} /> 复制
          </button>
          <button
            type="button"
            className={`block-menu-item${convertOpen ? ' sub-open' : ''}`}
            onClick={() => setConvertOpen((o) => !o)}
            onMouseEnter={() => setConvertOpen(true)}
          >
            转换为…
          </button>
          {convertOpen && (
            <div className="block-submenu" onMouseDown={(e) => e.stopPropagation()}>
              <button type="button" className="block-menu-item" onClick={() => convertTo('h1')}>标题 1</button>
              <button type="button" className="block-menu-item" onClick={() => convertTo('h2')}>标题 2</button>
              <button type="button" className="block-menu-item" onClick={() => convertTo('h3')}>标题 3</button>
              <button type="button" className="block-menu-item" onClick={() => convertTo('p')}>正文</button>
              <button type="button" className="block-menu-item" onClick={() => convertTo('ul')}>无序列表</button>
              <button type="button" className="block-menu-item" onClick={() => convertTo('quote')}>引用</button>
              <button type="button" className="block-menu-item" onClick={() => convertTo('code')}>代码块</button>
            </div>
          )}
          <button type="button" className="block-menu-item danger" onClick={remove}>
            <Trash2 size={13} /> 删除
          </button>
        </div>
      )}
    </div>
  );
}

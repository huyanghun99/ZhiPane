import { memo, useEffect, useState } from 'react';
import { Node, mergeAttributes, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Pencil } from 'lucide-react';
import { createZhipaneBlock } from './blockContract';
import { BlockFrame } from './BlockFrame';

// KaTeX (~270KB) is only needed when a page actually contains a math node.
// Load it on first use, mirroring MermaidView's module-level promise cache, so
// it is split out of the initial bundle. katex.min.css stays global (main.tsx)
// because the rendered markup needs those styles immediately.
type KatexLike = { renderToString: (expression: string, options?: Record<string, unknown>) => string };
let katexPromise: Promise<KatexLike> | null = null;
function loadKatex(): Promise<KatexLike> {
  if (!katexPromise) {
    katexPromise = import('katex').then((m) => {
      const mod = m as unknown as { default?: KatexLike } & KatexLike;
      return mod.default ?? mod;
    });
  }
  return katexPromise;
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

/** Render LaTeX once KaTeX is available. Until then show the escaped source so
 *  the node never flashes empty and never injects raw user input into HTML. */
function useLatexHtml(latex: string, display: boolean): string {
  const [html, setHtml] = useState(() => escapeHtml(latex));
  useEffect(() => {
    let cancelled = false;
    loadKatex()
      .then((katex) => {
        if (cancelled) return;
        try {
          setHtml(katex.renderToString(latex || '', {
            displayMode: display, throwOnError: false, output: 'html'
          }));
        } catch {
          setHtml(`<span class="math-error">${escapeHtml(latex)}</span>`);
        }
      })
      .catch(() => {
        if (!cancelled) setHtml(`<span class="math-error">${escapeHtml(latex)}</span>`);
      });
    return () => { cancelled = true; };
  }, [latex, display]);
  return html;
}

const MathBlockView = memo(function MathBlockView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const latex = (node.attrs.latex as string) || '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const html = useLatexHtml(latex, true);

  const actions = (
    <button type="button" className="ml-block-action" onMouseDown={(e) => { e.preventDefault(); setDraft(latex); setEditing((v) => !v); }}>
      <Pencil size={13} /> {editing ? '完成' : '编辑'}
    </button>
  );

  return (
    <BlockFrame label="公式" kind="mathBlock" id={node.attrs.id} selected={selected} onDelete={() => deleteNode?.()} actions={actions}>
      {editing ? (
        <textarea className="math-editor" value={draft} spellCheck={false}
          placeholder="E = mc^2"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { updateAttributes({ latex: draft }); setEditing(false); }} />
      ) : (
        <div className="math-render" contentEditable={false}
          onDoubleClick={() => { setDraft(latex); setEditing(true); }}
          dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </BlockFrame>
  );
});

export const MathBlock = createZhipaneBlock({
  name: 'mathBlock',
  dataType: 'mathBlock',
  atom: true,
  addAttributes: () => ({ latex: { default: 'E = mc^2' } }),
  addNodeView: () => ReactNodeViewRenderer(MathBlockView)
});

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ latex: { default: '' } }),
  parseHTML() {
    return [{ tag: 'span[data-type="mathInline"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'mathInline' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView);
  }
});

const MathInlineView = memo(function MathInlineView({ node, updateAttributes, selected }: NodeViewProps) {
  const latex = (node.attrs.latex as string) || '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const html = useLatexHtml(latex, false);
  return (
    <NodeViewWrapper className={`math-inline${selected ? ' ProseMirror-selectednode' : ''}`} as="span" data-drag-handle>
      {editing ? (
        <input className="math-inline-editor" value={draft} spellCheck={false}
          onBlur={() => { updateAttributes({ latex: draft }); setEditing(false); }}
          onChange={(e) => setDraft(e.target.value)} autoFocus />
      ) : (
        <span className="math-inline-render" contentEditable={false} onDoubleClick={() => { setDraft(latex); setEditing(true); }}
          dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </NodeViewWrapper>
  );
});

import { useState } from 'react';
import { Node, mergeAttributes, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import katex from 'katex';
import { Pencil } from 'lucide-react';
import { createZhipaneBlock } from './blockContract';
import { BlockFrame } from './BlockFrame';

function renderLatex(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex || '', { displayMode: display, throwOnError: false, output: 'html' });
  } catch {
    return `<span class="math-error">${latex}</span>`;
  }
}

function MathBlockView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const latex = (node.attrs.latex as string) || '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const html = renderLatex(latex, true);

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
}

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

function MathInlineView({ node, updateAttributes, selected }: NodeViewProps) {
  const latex = (node.attrs.latex as string) || '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const html = renderLatex(latex, false);
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
}

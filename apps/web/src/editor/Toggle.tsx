import { useState } from 'react';
import { ReactNodeViewRenderer, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { createZhipaneBlock } from './blockContract';
import { BlockFrame } from './BlockFrame';

function ToggleView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const [open, setOpen] = useState(true);
  const summary = (node.attrs.summary as string) || '';

  const actions = (
    <button type="button" className="ml-block-action" onMouseDown={(e) => { e.preventDefault(); setOpen((v) => !v); }}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {open ? '收起' : '展开'}
    </button>
  );

  return (
    <BlockFrame label="折叠" kind="toggle" id={node.attrs.id} selected={selected} onDelete={() => deleteNode?.()} actions={actions}>
      <div className="toggle-content">
        <input
          className="toggle-summary"
          value={summary}
          placeholder="折叠标题…"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => updateAttributes({ summary: e.target.value })}
        />
        {open && <NodeViewContent className="toggle-editable" />}
      </div>
    </BlockFrame>
  );
}

export const Toggle = createZhipaneBlock({
  name: 'toggle',
  dataType: 'toggle',
  content: 'block+',
  addAttributes: () => ({ summary: { default: '' } }),
  addNodeView: () => ReactNodeViewRenderer(ToggleView)
});

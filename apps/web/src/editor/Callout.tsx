import { useState } from 'react';
import { ReactNodeViewRenderer, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { createZhipaneBlock } from './blockContract';
import { BlockFrame } from './BlockFrame';

const EMOJIS = ['💡', '📌', '⚠️', '✅', '❓', '🔥', '📚', '🧠', '🛠️', '📝'];
const COLORS = [
  { key: 'blue', label: '蓝', bg: '#eaf2ff', border: '#bcd4ff' },
  { key: 'green', label: '绿', bg: '#eafaf0', border: '#bce9cd' },
  { key: 'amber', label: '黄', bg: '#fff7e6', border: '#ffe0a3' },
  { key: 'red', label: '红', bg: '#fdecec', border: '#f7b8b8' },
  { key: 'purple', label: '紫', bg: '#f4ecff', border: '#d9c2ff' }
];

function CalloutView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const emoji = (node.attrs.emoji as string) || '💡';
  const color = (node.attrs.color as string) || 'blue';
  const palette = COLORS.find((c) => c.key === color) ?? COLORS[0];
  const [showEmoji, setShowEmoji] = useState(false);
  const [showColor, setShowColor] = useState(false);

  const actions = (
    <>
      <button type="button" className="ml-block-action" onMouseDown={(e) => { e.preventDefault(); setShowEmoji((v) => !v); setShowColor(false); }}>
        {emoji}
      </button>
      {showEmoji && (
        <div className="ml-pop">
          {EMOJIS.map((em) => (
            <button key={em} type="button" onMouseDown={(e) => { e.preventDefault(); updateAttributes({ emoji: em }); setShowEmoji(false); }}>{em}</button>
          ))}
        </div>
      )}
      <button type="button" className="ml-block-action" style={{ background: palette.border }} title="配色"
        onMouseDown={(e) => { e.preventDefault(); setShowColor((v) => !v); setShowEmoji(false); }} />
      {showColor && (
        <div className="ml-pop">
          {COLORS.map((c) => (
            <button key={c.key} type="button" className="ml-swatch" style={{ background: c.bg, borderColor: c.border }}
              onMouseDown={(e) => { e.preventDefault(); updateAttributes({ color: c.key }); setShowColor(false); }} title={c.label} />
          ))}
        </div>
      )}
    </>
  );

  return (
    <BlockFrame label="标注" kind="callout" id={node.attrs.id} selected={selected} onDelete={() => deleteNode?.()} actions={actions}>
      <div className="callout-content" style={{ background: palette.bg, borderColor: palette.border }}>
        <NodeViewContent className="callout-editable" />
      </div>
    </BlockFrame>
  );
}

export const Callout = createZhipaneBlock({
  name: 'callout',
  dataType: 'callout',
  content: 'block+',
  addAttributes: () => ({
    emoji: { default: '💡' },
    color: { default: 'blue' }
  }),
  addNodeView: () => ReactNodeViewRenderer(CalloutView)
});

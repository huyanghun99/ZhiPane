import { useState } from 'react';
import { ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { ExternalLink, Pencil } from 'lucide-react';
import { createZhipaneBlock } from './blockContract';
import { BlockFrame } from './BlockFrame';

function providerOf(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('youtube')) return 'YouTube';
    if (host.includes('figma')) return 'Figma';
    if (host.includes('bilibili')) return 'Bilibili';
    if (host.includes('vimeo')) return 'Vimeo';
    if (host.includes('notion')) return 'Notion';
    return host || '网页';
  } catch {
    return '网页';
  }
}

function EmbedView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const url = (node.attrs.url as string) || '';
  const [editing, setEditing] = useState(!url);
  const [draft, setDraft] = useState(url);
  const provider = providerOf(url);
  const valid = /^https?:\/\/.+/i.test(url);

  const save = () => {
    updateAttributes({ url: draft.trim(), title: providerOf(draft.trim()) });
    setEditing(false);
  };

  const actions = (
    <>
      <button type="button" className="ml-block-action" onMouseDown={(e) => { e.preventDefault(); setDraft(url); setEditing((v) => !v); }}>
        <Pencil size={13} /> {editing ? '完成' : '编辑'}
      </button>
      {valid && (
        <a className="ml-block-action" href={url} target="_blank" rel="noopener noreferrer" onMouseDown={(e) => e.stopPropagation()}>
          <ExternalLink size={13} /> 打开
        </a>
      )}
    </>
  );

  return (
    <BlockFrame label="嵌入网页" kind="embed" id={node.attrs.id} selected={selected} onDelete={() => deleteNode?.()} actions={actions}>
      {editing ? (
        <div className="embed-edit" onMouseDown={(e) => e.stopPropagation()}>
          <input className="embed-input" value={draft} placeholder="https://…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} autoFocus />
          <button className="primary sm" onMouseDown={(e) => { e.preventDefault(); save(); }}>嵌入</button>
        </div>
      ) : valid ? (
        <iframe className="embed-frame" src={url} title={provider}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms" loading="lazy" />
      ) : (
        <div className="embed-invalid">无效的嵌入地址</div>
      )}
    </BlockFrame>
  );
}

export const Embed = createZhipaneBlock({
  name: 'embed',
  dataType: 'embed',
  addAttributes: () => ({
    url: { default: '' },
    title: { default: '' }
  }),
  addNodeView: () => ReactNodeViewRenderer(EmbedView)
});

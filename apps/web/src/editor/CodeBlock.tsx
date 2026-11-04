import { memo, useState } from 'react';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import CodeBlockBase from '@tiptap/extension-code-block';
import { Copy, Check } from 'lucide-react';
import { useToast } from '../components/Toast';

const LANGS = [
  'plaintext', 'javascript', 'typescript', 'python', 'go', 'rust', 'java',
  'c', 'cpp', 'csharp', 'html', 'css', 'json', 'bash', 'sql', 'markdown', 'yaml'
];

const CodeBlockView = memo(function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const lang = (node.attrs.language as string) || 'plaintext';
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const copy = () => {
    const text = node.textContent;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { toast.error('复制失败'); });
  };

  return (
    <NodeViewWrapper className="code-block-frame" data-drag-handle>
      <div className="code-block-bar" contentEditable={false} style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', padding: '4px 8px', borderBottom: '1px solid var(--border, #2a2f3a)' }}>
        <select
          className="code-lang"
          value={lang}
          onMouseDown={(e) => e.preventDefault()}
          onChange={(e) => updateAttributes({ language: e.target.value })}
          style={{ background: 'transparent', border: 'none', color: 'inherit', fontSize: 12, cursor: 'pointer' }}
        >
          {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <button
          type="button"
          className="code-copy"
          onMouseDown={(e) => e.preventDefault()}
          onClick={copy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12 }}
        >
          {copied ? <><Check size={13} /> 已复制</> : <><Copy size={13} /> 复制</>}
        </button>
      </div>
      <pre style={{ margin: 0, padding: '10px 12px', overflow: 'auto' }}>
        <NodeViewContent as="code" className={`language-${lang}`} />
      </pre>
    </NodeViewWrapper>
  );
});

/** Phase 2 (S8): code block with an inline language picker + one-click copy,
 *  replacing the bare StarterKit codeBlock. */
export const CodeBlock = CodeBlockBase.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  }
});

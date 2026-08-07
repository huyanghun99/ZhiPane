import { ReactNodeViewRenderer } from '@tiptap/react';
import { MermaidView } from './MermaidView';
import { createZhipaneBlock } from './blockContract';

export const Mermaid = createZhipaneBlock({
  name: 'mermaid',
  dataType: 'mermaid',
  addAttributes: () => ({
    code: {
      default: 'graph TD\n  A[开始] --> B[结束]',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-code') ?? el.textContent ?? '',
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-code': attrs.code })
    }
  }),
  addNodeView: () => ReactNodeViewRenderer(MermaidView)
});

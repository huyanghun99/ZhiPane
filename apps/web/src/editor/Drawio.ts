import { ReactNodeViewRenderer } from '@tiptap/react';
import { DrawioView } from './DrawioView';
import { createZhipaneBlock } from './blockContract';

export const Drawio = createZhipaneBlock({
  name: 'drawio',
  dataType: 'drawio',
  atom: true,
  addAttributes: () => ({
    xml: {
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-xml') ?? '',
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-xml': attrs.xml ?? '' })
    },
    preview: {
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-preview') ?? '',
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-preview': attrs.preview ?? '' })
    },
    width: {
      default: null,
      parseHTML: (el: HTMLElement) => {
        const w = el.getAttribute('data-width');
        return w ? Number(w) || null : null;
      },
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.width ? { 'data-width': String(attrs.width), style: `width: ${attrs.width}px` } : {}
    }
  }),
  addNodeView: () => ReactNodeViewRenderer(DrawioView)
});

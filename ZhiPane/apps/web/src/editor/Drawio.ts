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
    }
  }),
  addNodeView: () => ReactNodeViewRenderer(DrawioView)
});

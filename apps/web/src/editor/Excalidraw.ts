import { ReactNodeViewRenderer } from '@tiptap/react';
import { ExcalidrawView } from './ExcalidrawView';
import { createZhipaneBlock } from './blockContract';

export const Excalidraw = createZhipaneBlock({
  name: 'excalidraw',
  dataType: 'excalidraw',
  atom: true,
  addAttributes: () => ({
    elements: {
      default: [],
      parseHTML: (el: HTMLElement) => {
        try {
          return JSON.parse(el.getAttribute('data-elements') || '[]');
        } catch {
          return [];
        }
      },
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-elements': JSON.stringify(attrs.elements ?? []) })
    },
    appState: {
      default: {},
      parseHTML: (el: HTMLElement) => {
        try {
          return JSON.parse(el.getAttribute('data-appstate') || '{}');
        } catch {
          return {};
        }
      },
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-appstate': JSON.stringify(attrs.appState ?? {}) })
    },
    files: {
      default: {},
      parseHTML: (el: HTMLElement) => {
        try {
          return JSON.parse(el.getAttribute('data-files') || '{}');
        } catch {
          return {};
        }
      },
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-files': JSON.stringify(attrs.files ?? {}) })
    },
    preview: {
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-preview') ?? '',
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-preview': attrs.preview ?? '' })
    }
  }),
  addNodeView: () => ReactNodeViewRenderer(ExcalidrawView)
});

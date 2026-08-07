import { Node, mergeAttributes } from '@tiptap/react';

/**
 * Unified Extension Contract for advanced (custom) blocks (Phase4 — task 10).
 *
 * Every advanced block (Mermaid, Embed, Draw.io, Excalidraw, Callout,
 * Toggle, Math, Media) is built through `createZhipaneBlock` so they share:
 *   - a stable `id` attribute (uuid) for identity / future diffing
 *   - `draggable` + `selectable` (so the Block Handle can grab them)
 *   - consistent `data-type` + `data-drag-handle` serialization
 *   - a common node-view chrome via <BlockFrame/>
 *
 * This keeps the editor's "advanced blocks" behaviourally uniform instead of
 * each node view re-inventing its toolbar, delete affordance and drag target.
 */
export interface ZhipaneBlockConfig {
  name: string;
  /** value used for `data-type` in serialization + parseHTML matching */
  dataType: string;
  group?: string;
  content?: string;
  atom?: boolean;
  inline?: boolean;
  selectable?: boolean;
  draggable?: boolean;
  addAttributes?: () => any;
  addNodeView: () => any;
  parseHTML?: () => { tag: string; getAttrs?: (el: HTMLElement) => Record<string, unknown> }[];
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'b-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function createZhipaneBlock(config: ZhipaneBlockConfig) {
  return Node.create({
    name: config.name,
    group: config.group ?? 'block',
    content: config.content,
    atom: config.atom,
    inline: config.inline,
    draggable: config.draggable ?? true,
    selectable: config.selectable ?? true,

    addAttributes() {
      return {
        id: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute('data-block-id') || null,
          renderHTML: (attrs: Record<string, unknown>) =>
            attrs.id ? { 'data-block-id': attrs.id as string } : {}
        },
        ...(config.addAttributes ? config.addAttributes() : {})
      };
    },

    parseHTML() {
      return config.parseHTML
        ? config.parseHTML()
        : [{ tag: `div[data-type="${config.dataType}"]` }];
    },

    renderHTML({ HTMLAttributes }) {
      return [
        'div',
        mergeAttributes(HTMLAttributes, {
          'data-type': config.dataType,
          'data-drag-handle': ''
        })
      ];
    },

    addNodeView() {
      return config.addNodeView() as never;
    }
  });
}

export { newId };

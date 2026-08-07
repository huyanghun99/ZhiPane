import type { PMNode } from '../../editor/prosemirror';

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
  /** Ordinal index among all headings — used to locate the DOM node. */
  index: number;
}

function inlineText(node: PMNode): string {
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) return node.content.map(inlineText).join('');
  return '';
}

/**
 * Derive the document outline (headings) from ProseMirror JSON.
 * Powers the right-panel "大纲" tab; purely a read of contentJson.
 */
export function extractOutline(doc: PMNode | null | undefined): OutlineItem[] {
  if (!doc || !Array.isArray(doc.content)) return [];
  const out: OutlineItem[] = [];
  let index = 0;
  for (const node of doc.content) {
    if (node.type === 'heading') {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      const text = inlineText(node).trim();
      out.push({ id: `h-${index}`, level, text: text || '（无标题）', index });
      index++;
    }
  }
  return out;
}

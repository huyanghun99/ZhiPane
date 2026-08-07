export interface AttachmentRef {
  attachmentId: string;
  fileName: string;
  mimeType?: string;
  url?: string;
}

export interface EditorNodeLike {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: EditorNodeLike[];
}

export interface EditorBlockExtension {
  name: string;
  nodeType: string;
  insertCommand: string;
  toTextContent(node: EditorNodeLike): string;
  toMarkdown?(node: EditorNodeLike): string;
  toHtml?(node: EditorNodeLike): string;
  getAttachments?(node: EditorNodeLike): AttachmentRef[];
  isIndexableByLlm: boolean;
}

export const mermaidExtensionContract: EditorBlockExtension = {
  name: 'Mermaid',
  nodeType: 'codeBlock',
  insertCommand: 'insertMermaid',
  isIndexableByLlm: true,
  toTextContent(node) {
    return typeof node.text === 'string' ? node.text : '';
  }
};

export const katexExtensionContract: EditorBlockExtension = {
  name: 'KaTeX',
  nodeType: 'mathBlock',
  insertCommand: 'insertMathBlock',
  isIndexableByLlm: true,
  toTextContent(node) {
    return String(node.attrs?.text ?? '');
  }
};

export const drawioExtensionContract: EditorBlockExtension = {
  name: 'Draw.io',
  nodeType: 'drawio',
  insertCommand: 'insertDrawio',
  isIndexableByLlm: false,
  toTextContent(node) {
    return String(node.attrs?.title ?? 'Draw.io diagram');
  },
  getAttachments(node) {
    const attachmentId = String(node.attrs?.attachmentId ?? '');
    if (!attachmentId) return [];
    return [{ attachmentId, fileName: String(node.attrs?.title ?? 'diagram.drawio.svg') }];
  }
};

export const excalidrawExtensionContract: EditorBlockExtension = {
  name: 'Excalidraw',
  nodeType: 'excalidraw',
  insertCommand: 'insertExcalidraw',
  isIndexableByLlm: false,
  toTextContent(node) {
    return String(node.attrs?.title ?? 'Excalidraw diagram');
  },
  getAttachments(node) {
    const attachmentId = String(node.attrs?.attachmentId ?? '');
    if (!attachmentId) return [];
    return [{ attachmentId, fileName: String(node.attrs?.title ?? 'diagram.excalidraw.svg') }];
  }
};

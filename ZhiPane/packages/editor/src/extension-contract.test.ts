import { describe, expect, it } from 'vitest';
import {
  mermaidExtensionContract,
  katexExtensionContract,
  drawioExtensionContract,
  excalidrawExtensionContract,
  type EditorBlockExtension
} from './extension-contract';
import { contentIndexabilityMatrix } from './indexability';

const ALL_CONTRACTS: EditorBlockExtension[] = [
  mermaidExtensionContract,
  katexExtensionContract,
  drawioExtensionContract,
  excalidrawExtensionContract
];

describe('EditorBlockExtension contract', () => {
  it('every contract declares a unique name and nodeType', () => {
    const names = new Set(ALL_CONTRACTS.map((c) => c.name));
    const nodeTypes = new Set(ALL_CONTRACTS.map((c) => c.nodeType));
    expect(names.size).toBe(ALL_CONTRACTS.length);
    expect(nodeTypes.size).toBe(ALL_CONTRACTS.length);
  });

  it('every contract has a non-empty insertCommand', () => {
    for (const c of ALL_CONTRACTS) {
      expect(c.insertCommand.length).toBeGreaterThan(0);
    }
  });

  it('every contract implements toTextContent', () => {
    for (const c of ALL_CONTRACTS) {
      const text = c.toTextContent({ type: c.nodeType });
      expect(typeof text).toBe('string');
    }
  });

  it('mermaid extracts source text from code blocks', () => {
    expect(mermaidExtensionContract.toTextContent({ type: 'codeBlock', text: 'graph TD; A-->B' })).toBe('graph TD; A-->B');
  });

  it('katex extracts formula from attrs.text', () => {
    expect(katexExtensionContract.toTextContent({ type: 'mathBlock', attrs: { text: '\\sum x_i' } })).toBe('\\sum x_i');
  });

  it('katex returns empty string when attrs.text missing', () => {
    expect(katexExtensionContract.toTextContent({ type: 'mathBlock' })).toBe('');
  });

  it('drawio reports attachments when attachmentId present', () => {
    const refs = drawioExtensionContract.getAttachments?.({ type: 'drawio', attrs: { attachmentId: 'att-1', title: 'diagram' } });
    expect(refs).toHaveLength(1);
    expect(refs?.[0].attachmentId).toBe('att-1');
  });

  it('drawio returns no attachments when attachmentId absent', () => {
    const refs = drawioExtensionContract.getAttachments?.({ type: 'drawio', attrs: {} });
    expect(refs).toEqual([]);
  });

  it('excalidraw reports attachments when attachmentId present', () => {
    const refs = excalidrawExtensionContract.getAttachments?.({ type: 'excalidraw', attrs: { attachmentId: 'att-2', title: 'sketch' } });
    expect(refs).toHaveLength(1);
    expect(refs?.[0].attachmentId).toBe('att-2');
  });

  it('isIndexableByLlm flag matches indexability matrix for diagram types', () => {
    expect(mermaidExtensionContract.isIndexableByLlm).toBe(true);
    expect(katexExtensionContract.isIndexableByLlm).toBe(true);
    // Drawio and excalidraw are metadata-only in MVP: not LLM-indexable.
    expect(drawioExtensionContract.isIndexableByLlm).toBe(false);
    expect(excalidrawExtensionContract.isIndexableByLlm).toBe(false);
  });

  it('content indexability matrix covers all key content types', () => {
    const types = contentIndexabilityMatrix.map((r) => r.contentType);
    expect(types).toContain('plain_text');
    expect(types).toContain('mermaid_source');
    expect(types).toContain('katex_source');
    expect(types).toContain('drawio');
    expect(types).toContain('excalidraw');
    expect(types).toContain('pdf_attachment');
    expect(types).toContain('iframe_embed');
  });

  it('plain_text is fully indexable (fullText + vector + llmWiki)', () => {
    const rule = contentIndexabilityMatrix.find((r) => r.contentType === 'plain_text');
    expect(rule?.fullText).toBe(true);
    expect(rule?.vector).toBe(true);
    expect(rule?.llmWiki).toBe(true);
  });

  it('diagram types disable vector indexing in MVP', () => {
    const drawio = contentIndexabilityMatrix.find((r) => r.contentType === 'drawio');
    const excalidraw = contentIndexabilityMatrix.find((r) => r.contentType === 'excalidraw');
    expect(drawio?.vector).toBe(false);
    expect(excalidraw?.vector).toBe(false);
  });
});

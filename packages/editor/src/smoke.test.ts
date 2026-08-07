import { describe, expect, it } from 'vitest';
import {
  mermaidExtensionContract,
  katexExtensionContract,
  drawioExtensionContract,
  excalidrawExtensionContract,
  contentIndexabilityMatrix
} from './index';

describe('@zhipane/editor smoke', () => {
  it('exports extension contracts for all block types', () => {
    expect(mermaidExtensionContract.name).toBe('Mermaid');
    expect(katexExtensionContract.name).toBe('KaTeX');
    expect(drawioExtensionContract.name).toBe('Draw.io');
    expect(excalidrawExtensionContract.name).toBe('Excalidraw');
  });

  it('extracts text content from editor nodes', () => {
    expect(mermaidExtensionContract.toTextContent({ type: 'codeBlock', text: 'graph A-->B' })).toBe('graph A-->B');
    expect(katexExtensionContract.toTextContent({ type: 'mathBlock', attrs: { text: 'E=mc^2' } })).toBe('E=mc^2');
  });

  it('provides content indexability rules', () => {
    expect(contentIndexabilityMatrix.length).toBeGreaterThan(0);
    const plainText = contentIndexabilityMatrix.find((r) => r.contentType === 'plain_text');
    expect(plainText?.fullText).toBe(true);
    expect(plainText?.vector).toBe(true);
  });
});

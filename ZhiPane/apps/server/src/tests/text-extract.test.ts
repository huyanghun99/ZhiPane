import { describe, expect, it } from 'vitest';
import { extractTextFromProseMirrorJson } from '../utils/text';

describe('ProseMirror text extraction', () => {
  it('extracts text from simple paragraph', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] };
    expect(extractTextFromProseMirrorJson(doc)).toBe('Hello world');
  });

  it('extracts text from multiple blocks', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }
      ]
    };
    expect(extractTextFromProseMirrorJson(doc)).toBe('First\nSecond');
  });

  it('handles empty doc', () => {
    expect(extractTextFromProseMirrorJson({ type: 'doc', content: [] })).toBe('');
  });

  it('handles null input', () => {
    expect(extractTextFromProseMirrorJson(null)).toBe('');
  });

  it('extracts attrs.text fallback', () => {
    const doc = { type: 'doc', content: [{ type: 'math', attrs: { text: 'x^2 + y^2' } }] };
    expect(extractTextFromProseMirrorJson(doc)).toBe('x^2 + y^2');
  });
});

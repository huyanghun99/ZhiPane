import { describe, expect, it } from 'vitest';
import { chunkText } from '../utils/text';

describe('chunkText', () => {
  it('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('returns single chunk for text smaller than maxSize', () => {
    const text = 'short text';
    const chunks = chunkText(text, 100, 20);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('short text');
  });

  it('splits long text into multiple chunks', () => {
    const text = 'a'.repeat(2000);
    const chunks = chunkText(text, 800, 150);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(800);
  });

  it('overlaps chunks by the configured overlap size', () => {
    const text = '0123456789'.repeat(20); // 200 chars
    const chunks = chunkText(text, 100, 30);
    // step = maxSize - overlap = 70; expect overlap between consecutive chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const step = 100 - 30;
    expect(chunks[1]).toBe(text.slice(step, step + 100));
  });

  it('uses default maxSize and overlap when omitted', () => {
    const text = 'x'.repeat(900);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('trims whitespace from each chunk', () => {
    const chunks = chunkText('  hello  ', 100, 20);
    expect(chunks[0]).toBe('hello');
  });
});

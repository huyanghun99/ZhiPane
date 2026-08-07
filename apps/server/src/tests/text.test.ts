import { describe, expect, it } from 'vitest';
import { chunkText, tokenizeChineseFriendly } from '../utils/text';

describe('text utilities', () => {
  it('tokenizes Chinese with ngrams for simple tsvector search', () => {
    const out = tokenizeChineseFriendly('员工手册 AI Knowledge');
    expect(out).toContain('员工');
    expect(out).toContain('工手');
    expect(out).toContain('员工手');
    expect(out).toContain('ai');
  });

  it('chunks text with overlap', () => {
    const chunks = chunkText('a'.repeat(2000), 800, 150);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBe(800);
  });
});

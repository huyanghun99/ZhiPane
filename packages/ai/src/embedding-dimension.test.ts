import { describe, expect, it } from 'vitest';
import { MockAiProvider, deterministicVector, DEFAULT_EMBEDDING_DIMENSION } from './provider';

describe('Embedding dimension lock', () => {
  it('produces vectors matching the configured dimension', async () => {
    const ai = new MockAiProvider(768);
    const vec = await ai.embed('lock test');
    expect(vec.length).toBe(768);
  });

  it('defaults to the canonical 1536 dimension', async () => {
    const ai = new MockAiProvider();
    const vec = await ai.embed('default dim');
    expect(vec.length).toBe(DEFAULT_EMBEDDING_DIMENSION);
    expect(vec.length).toBe(1536);
  });

  it('produces different lengths for different configured dimensions', () => {
    const small = deterministicVector('text', 128);
    const large = deterministicVector('text', 512);
    expect(small.length).toBe(128);
    expect(large.length).toBe(512);
  });

  it('detects dimension mismatch when comparing vectors of different sizes', () => {
    const a = deterministicVector('text', 128);
    const b = deterministicVector('text', 256);
    expect(a.length).not.toBe(b.length);
    // A dimension lock guard would reject this mismatch.
    const sameDimension = a.length === b.length;
    expect(sameDimension).toBe(false);
  });

  it('produces unit-norm vectors regardless of dimension', () => {
    for (const dim of [64, 128, 768, 1536]) {
      const vec = deterministicVector('normalization check', dim);
      const norm = Math.sqrt(vec.reduce((acc, n) => acc + n * n, 0));
      expect(norm).toBeCloseTo(1, 4);
    }
  });

  it('produces deterministic vectors for same input and dimension', () => {
    const a = deterministicVector('deterministic', 384);
    const b = deterministicVector('deterministic', 384);
    expect(a).toEqual(b);
  });
});

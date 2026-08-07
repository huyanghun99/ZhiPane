import { describe, expect, it } from 'vitest';
import { MockAiProvider, deterministicVector, vectorToSqlLiteral, DEFAULT_EMBEDDING_DIMENSION } from './provider';

describe('@zhipane/ai smoke', () => {
  it('generates deterministic embedding with default dimension', async () => {
    const ai = new MockAiProvider();
    const vec = await ai.embed('hello world');
    expect(vec.length).toBe(DEFAULT_EMBEDDING_DIMENSION);
  });

  it('produces consistent vectors for identical input', () => {
    const a = deterministicVector('test', 128);
    const b = deterministicVector('test', 128);
    expect(a).toEqual(b);
  });

  it('converts vector to SQL literal format', () => {
    const literal = vectorToSqlLiteral([0.1, 0.2, 0.3]);
    expect(literal).toBe('[0.1,0.2,0.3]');
  });

  it('generates text response from mock provider', async () => {
    const ai = new MockAiProvider();
    const text = await ai.generateText([{ role: 'user', content: 'question' }]);
    expect(text).toContain('Mock answer');
  });
});

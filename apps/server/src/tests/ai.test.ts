import { describe, expect, it } from 'vitest';
import { MockAiProvider } from '../services/ai.service';

describe('mock AI provider', () => {
  it('generates deterministic embedding dimensions', async () => {
    const ai = new MockAiProvider();
    const vector = await ai.embed('hello');
    expect(vector.length).toBe(1536);
  });
});

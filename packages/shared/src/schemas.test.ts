import { describe, expect, it } from 'vitest';
import { ragAskSchema } from './schemas';

describe('schemas', () => {
  it('validates rag ask payload', () => {
    const parsed = ragAskSchema.parse({ workspaceId: crypto.randomUUID(), query: 'hello' });
    expect(parsed.limit).toBe(10);
    expect(parsed.extendedThinking).toBe(false);
  });
});

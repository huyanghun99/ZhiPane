import { describe, expect, it, afterEach, vi } from 'vitest';
import { OpenAICompatibleProvider, MockAiProvider } from './provider';

describe('OpenAICompatibleProvider usage + embeddingModel (Phase H N2)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(response: unknown): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
      statusText: 'OK'
    }) as unknown as Response);
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    return fn;
  }

  it('exposes embeddingModel from options', () => {
    const p = new OpenAICompatibleProvider({
      baseUrl: 'http://x',
      apiKey: 'k',
      completionModel: 'm',
      embeddingBaseUrl: 'http://x',
      embeddingApiKey: 'k',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimension: 1536
    });
    expect(p.embeddingModel).toBe('text-embedding-3-small');
  });

  it('captures usage from generateText response', async () => {
    mockFetch({
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 42, completion_tokens: 7 }
    });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'http://x',
      apiKey: 'k',
      completionModel: 'm',
      embeddingBaseUrl: 'http://x',
      embeddingApiKey: 'k',
      embeddingModel: 'emb',
      embeddingDimension: 8
    });
    expect(p.getLastUsage?.()).toBeNull();
    const out = await p.generateText([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('hello');
    const usage = p.getLastUsage?.();
    expect(usage).toEqual({ promptTokens: 42, completionTokens: 7 });
  });

  it('returns null usage when upstream omits the field', async () => {
    mockFetch({ choices: [{ message: { content: 'hi' } }] });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'http://x',
      apiKey: 'k',
      completionModel: 'm',
      embeddingBaseUrl: 'http://x',
      embeddingApiKey: 'k',
      embeddingModel: 'emb',
      embeddingDimension: 8
    });
    await p.generateText([{ role: 'user', content: 'hi' }]);
    expect(p.getLastUsage?.()).toBeNull();
  });

  it('returns null usage when usage values are non-numeric', async () => {
    mockFetch({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 'bad', completion_tokens: 7 }
    });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'http://x',
      apiKey: 'k',
      completionModel: 'm',
      embeddingBaseUrl: 'http://x',
      embeddingApiKey: 'k',
      embeddingModel: 'emb',
      embeddingDimension: 8
    });
    await p.generateText([{ role: 'user', content: 'hi' }]);
    expect(p.getLastUsage?.()).toBeNull();
  });
});

describe('MockAiProvider embeddingModel (Phase H N2)', () => {
  it('exposes a stable mock embedding model name', () => {
    const p = new MockAiProvider(8);
    expect(p.embeddingModel).toBe('mock-embedding');
  });

  it('does not implement getLastUsage (mock never reports usage)', () => {
    const p = new MockAiProvider(8);
    // Cast to access the optional runtime property without a TS error —
    // the mock intentionally omits getLastUsage, so the type system does
    // not know it exists (or rather, does not exist) at runtime.
    expect((p as unknown as { getLastUsage?: unknown }).getLastUsage).toBeUndefined();
  });
});

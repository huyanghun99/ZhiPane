import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from './provider';

// Phase G (S2): the OpenAI-compatible provider must never hang forever and
// must tolerate a single transient upstream failure (5xx / 429 / network)
// without surfacing it. 4xx must NOT retry — it will never succeed.
// These tests stub global.fetch so no real network call is ever made.

function makeProvider() {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://api.test/v1',
    apiKey: 'sk-test',
    completionModel: 'm',
    embeddingBaseUrl: 'https://api.test/v1',
    embeddingApiKey: 'sk-emb',
    embeddingModel: 'emb',
    embeddingDimension: 8
  });
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAICompatibleProvider fetchWithRetry (Phase G S2)', () => {
  it('retries once on 5xx then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ error: 'boom' }, 503))
      .mockResolvedValueOnce(jsonRes({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await makeProvider().generateText([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(jsonRes({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await makeProvider().generateText([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx (auth / bad request surfaces immediately)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ error: 'bad key' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeProvider().generateText([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on network error then surfaces after exhausting retries', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeProvider().generateText([{ role: 'user', content: 'hi' }])).rejects.toThrow('network down');
    // 1 initial attempt + 1 retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('embed retries on 5xx then returns the vector', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonRes({ data: [{ embedding: [1, 2, 3, 4, 5, 6, 7, 8] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const vec = await makeProvider().embed('hello');
    expect(vec).toHaveLength(8);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

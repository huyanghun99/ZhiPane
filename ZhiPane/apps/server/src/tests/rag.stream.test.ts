import { describe, expect, it, vi } from 'vitest';

// Isolate RAG streaming from the real hybrid search; the AI provider is forced
// to the deterministic mock by NODE_ENV=test in setup.ts.
vi.mock('../services/search.service', () => ({
  hybridSearch: vi.fn()
}));

import { hybridSearch } from '../services/search.service';
import { streamRag } from '../services/rag.service';

const BASE = { userId: 'u-1', workspaceId: 'w-1', spaceId: 's-1', query: 'q', limit: 5, extendedThinking: false };

describe('streamRag — provenance-first streaming', () => {
  it('emits sources BEFORE any token, then a done event', async () => {
    vi.mocked(hybridSearch).mockResolvedValueOnce([
      { id: 'c-1', pageId: 'p-1', spaceId: 's-1', title: 'T1', content: 'body text', source: 'both', score: 0.9 }
    ]);

    const events: unknown[] = [];
    for await (const ev of streamRag(BASE)) events.push(ev);

    const first = events[0] as { type: string; citations: { pageId?: string; chunkId?: string; title?: string; excerpt?: string; score?: number }[] };
    expect(first.type).toBe('sources');
    expect(first.citations).toHaveLength(1);
    expect(first.citations[0]).toMatchObject({ pageId: 'p-1', chunkId: 'c-1', title: 'T1', score: 0.9 });

    const tokenIdx = events.findIndex((e) => (e as { type: string }).type === 'token');
    const doneIdx = events.findIndex((e) => (e as { type: string }).type === 'done');
    expect(tokenIdx).toBeGreaterThan(0); // sources came first
    expect(doneIdx).toBeGreaterThan(tokenIdx);
    expect(typeof (events[doneIdx] as { answer: string }).answer).toBe('string');
    expect((events[doneIdx] as { answer: string }).answer.length).toBeGreaterThan(0);
  });

  it('refuses clearly (no throw) when no relevant data is found', async () => {
    vi.mocked(hybridSearch).mockResolvedValueOnce([]);
    const events: { type: string; citations?: unknown[]; answer?: string }[] = [];
    for await (const ev of streamRag({ ...BASE, spaceId: undefined })) events.push(ev as never);

    expect(events[0].type).toBe('sources');
    expect(events[0].citations).toEqual([]);
    const done = events.find((e) => e.type === 'done');
    expect(done?.answer).toContain('未找到');
  });

  it('surfaces failures as an error event instead of throwing', async () => {
    vi.mocked(hybridSearch).mockRejectedValueOnce(new Error('boom'));
    const events: { type: string; message?: string }[] = [];
    for await (const ev of streamRag(BASE)) events.push(ev as never);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeTruthy();
    expect(err?.message).toBe('boom');
  });
});

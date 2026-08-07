import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/search.service', () => ({
  hybridSearch: vi.fn().mockResolvedValue([]),
  rrfFuse: vi.fn()
}));

import { hybridSearch } from '../services/search.service';
import { askRag } from '../services/rag.service';

describe('RAG eval — no-answer accuracy', () => {
  it('returns standard no-answer message when no results found', async () => {
    vi.mocked(hybridSearch).mockResolvedValueOnce([]);
    const result = await askRag({
      userId: 'user-1',
      workspaceId: 'ws-1',
      query: 'unanswerable question',
      limit: 5,
      extendedThinking: false
    });
    expect(result.answer).toBe('知识库中未找到相关信息。');
    expect(result.citations).toEqual([]);
    expect(result.usedExtendedThinking).toBe(false);
  });
});

describe('RAG eval — citation format', () => {
  it('produces citations with required fields when results exist', async () => {
    vi.mocked(hybridSearch).mockResolvedValueOnce([
      { id: 'chunk-1', pageId: 'page-1', spaceId: 'space-1', title: 'Test Page', content: 'Some content here', source: 'both', score: 0.95 }
    ]);
    const result = await askRag({
      userId: 'user-1',
      workspaceId: 'ws-1',
      query: 'test',
      limit: 5,
      extendedThinking: false
    });
    expect(result.citations).toHaveLength(1);
    const citation = result.citations[0];
    expect(citation).toHaveProperty('pageId', 'page-1');
    expect(citation).toHaveProperty('chunkId', 'chunk-1');
    expect(citation).toHaveProperty('title', 'Test Page');
    expect(citation).toHaveProperty('excerpt');
    expect(citation).toHaveProperty('score', 0.95);
    expect(typeof citation.excerpt).toBe('string');
  });
});

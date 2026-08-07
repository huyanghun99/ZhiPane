import { describe, expect, it } from 'vitest';
import { RRF_K } from '@zhipane/shared';

// Reimplementation matching search.service.ts rrfFuse for unit testing.
function rrfFuse<T extends { id: string; page_id: string; title: string; content: string }>(bm25: T[], vector: T[], limit: number) {
  const map = new Map<string, { id: string; pageId: string; title: string; content: string; source: string; score: number }>();
  for (let i = 0; i < bm25.length; i++) {
    const row = bm25[i];
    map.set(row.id, { id: row.id, pageId: row.page_id, title: row.title, content: row.content, source: 'bm25', score: 0.4 / (RRF_K + i + 1) });
  }
  for (let i = 0; i < vector.length; i++) {
    const row = vector[i];
    const existing = map.get(row.id);
    if (existing) {
      existing.source = 'both';
      existing.score += 0.6 / (RRF_K + i + 1);
    } else {
      map.set(row.id, { id: row.id, pageId: row.page_id, title: row.title, content: row.content, source: 'vector', score: 0.6 / (RRF_K + i + 1) });
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

describe('RRF fusion', () => {
  it('marks results in both lists as "both"', () => {
    const bm25 = [{ id: '1', page_id: 'p1', title: 'A', content: 'a' }];
    const vector = [{ id: '1', page_id: 'p1', title: 'A', content: 'a' }];
    const result = rrfFuse(bm25, vector, 10);
    expect(result[0].source).toBe('both');
  });

  it('combines scores for overlapping results', () => {
    const bm25 = [{ id: '1', page_id: 'p1', title: 'A', content: 'a' }];
    const vector = [{ id: '1', page_id: 'p1', title: 'A', content: 'a' }];
    const result = rrfFuse(bm25, vector, 10);
    const expected = 0.4 / (RRF_K + 1) + 0.6 / (RRF_K + 1);
    expect(result[0].score).toBeCloseTo(expected, 10);
  });

  it('ranks higher-ranked results higher', () => {
    const bm25 = [
      { id: '1', page_id: 'p1', title: 'A', content: 'a' },
      { id: '2', page_id: 'p2', title: 'B', content: 'b' }
    ];
    const vector: typeof bm25 = [];
    const result = rrfFuse(bm25, vector, 10);
    expect(result[0].id).toBe('1');
    expect(result[1].id).toBe('2');
  });

  it('limits results to specified count', () => {
    const bm25 = Array.from({ length: 10 }, (_, i) => ({ id: String(i), page_id: 'p', title: 'T', content: 'c' }));
    const result = rrfFuse(bm25, [], 3);
    expect(result).toHaveLength(3);
  });

  it('handles empty inputs', () => {
    expect(rrfFuse([], [], 10)).toEqual([]);
  });

  it('marks bm25-only results as "bm25"', () => {
    const bm25 = [{ id: '1', page_id: 'p1', title: 'A', content: 'a' }];
    const result = rrfFuse(bm25, [], 10);
    expect(result[0].source).toBe('bm25');
  });

  it('marks vector-only results as "vector"', () => {
    const vector = [{ id: '1', page_id: 'p1', title: 'A', content: 'a' }];
    const result = rrfFuse([], vector, 10);
    expect(result[0].source).toBe('vector');
  });
});

import { describe, expect, it } from 'vitest';
import { buildPageKnowledgeMap } from '../services/page-knowledge.service';
import { clearKnowledgeMetrics, getKnowledgeMetrics, recordKnowledgeStage } from '../services/knowledge-metrics';

describe('Plan 04 Phase 8 observability and incremental primitives', () => {
  it('uses content version as the cache identity', () => {
    const a = buildPageKnowledgeMap('# A\n正文', 'A', [{ id: '1', content: '# A\n正文' }]);
    const b = buildPageKnowledgeMap('# B\n正文', 'B', [{ id: '2', content: '# B\n正文' }]);
    expect(a.primaryTopic).not.toBe(b.primaryTopic);
  });
  it('records bounded stage metrics with cache state', () => {
    clearKnowledgeMetrics();
    recordKnowledgeStage({ stage: 'page_map', pageId: 'p', contentVersion: 1, durationMs: 3, inputCharacters: 10, outputItems: 2, cacheHit: false });
    expect(getKnowledgeMetrics()[0].cacheHit).toBe(false);
    expect(getKnowledgeMetrics()[0].stage).toBe('page_map');
  });
});

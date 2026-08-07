import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Mock the db client so the metrics endpoint can be tested without a running
// PostgreSQL. We stub `db.execute` to return canned aggregates that exercise
// the response shape (queue depth, totals, byType, failures, usage, latency).
// vi.hoisted lifts the mock fn above the vi.mock call so the factory can
// reference it (vi.mock is hoisted to the top of the file by the compiler).
const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock('../db/client', () => ({
  db: { execute: executeMock },
  pool: { query: vi.fn(async () => ({ rows: [] })) }
}));

// Import after mocks are registered.
import { createApp } from '../app';

function rows(r: unknown) {
  return { rows: Array.isArray(r) ? r : [r] };
}

describe('GET /health/metrics (Phase H N2)', () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with aggregated metrics when db is reachable', async () => {
    // getDbJobMetrics runs 7 queries in parallel; stub each.
    executeMock
      .mockResolvedValueOnce(rows({ pending: 3, running: 1 })) // queueDepth
      .mockResolvedValueOnce(rows({ succeeded: 100, failed: 5, cancelled: 2 })) // totals
      .mockResolvedValueOnce(rows([
        { type: 'page.process_llm', succeeded: 80, failed: 3, pending: 2, running: 1 },
        { type: 'space.consolidate_topic_candidates', succeeded: 20, failed: 2, pending: 1, running: 0 }
      ])) // byType
      .mockResolvedValueOnce(rows([
        { id: 'j1', type: 'page.process_llm', error_message: 'boom', updated_at: '2026-07-23T00:00:00Z' }
      ])) // recentFailures
      .mockResolvedValueOnce(rows({ total_prompt_tokens: '12345', total_completion_tokens: '6789' })) // aiUsage
      .mockResolvedValueOnce(rows({ succeeded: 10, failed: 2 })) // successRate1h
      .mockResolvedValueOnce(rows({ p50: 1.5, p95: 4.2 })); // latency1h

    const app = createApp();
    const res = await app.request('/health/metrics');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toBe('zhipane-server');
    expect(body.queueDepth).toEqual({ pending: 3, running: 1 });
    expect(body.totals).toEqual({ succeeded: 100, failed: 5, cancelled: 2 });
    expect(body.byType).toHaveLength(2);
    expect(body.byType[0]).toEqual({
      type: 'page.process_llm',
      succeeded: 80, failed: 3, pending: 2, running: 1
    });
    expect(body.recentFailures).toHaveLength(1);
    expect(body.recentFailures[0].errorMessage).toBe('boom');
    expect(body.aiUsage).toEqual({ totalPromptTokens: 12345, totalCompletionTokens: 6789 });
    expect(body.successRate1h).toBeCloseTo(10 / 12, 5);
    expect(body.latencySeconds1h).toEqual({ p50: 1.5, p95: 4.2 });
  });

  it('returns successRate1h=1 when no jobs ran in the last hour', async () => {
    executeMock
      .mockResolvedValueOnce(rows({ pending: 0, running: 0 }))
      .mockResolvedValueOnce(rows({ succeeded: 0, failed: 0, cancelled: 0 }))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows({ total_prompt_tokens: '0', total_completion_tokens: '0' }))
      .mockResolvedValueOnce(rows({ succeeded: 0, failed: 0 }))
      .mockResolvedValueOnce(rows({ p50: -1, p95: -1 }));

    const app = createApp();
    const res = await app.request('/health/metrics');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successRate1h).toBe(1);
    expect(body.latencySeconds1h).toEqual({ p50: null, p95: null });
    expect(body.byType).toEqual([]);
    expect(body.recentFailures).toEqual([]);
  });

  it('returns 503 when the database is unreachable', async () => {
    executeMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const app = createApp();
    const res = await app.request('/health/metrics');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('metrics unavailable');
  });
});

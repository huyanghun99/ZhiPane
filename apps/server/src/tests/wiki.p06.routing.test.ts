import { describe, expect, it } from 'vitest';
import { MockAiProvider, type AiProvider } from '@zhipane/ai';
import {
  routeClaims,
  analyzeClaimRelations
} from '../services/wiki.service';

// ---------- helpers ---------------------------------------------------------

const sampleClaims = [
  { id: 'claim-01', text: '机器学习是研究如何让计算机系统从数据中学习的学科', sectionAnchor: 'section-01' },
  { id: 'claim-02', text: '深度学习是机器学习的一个分支，使用多层神经网络', sectionAnchor: 'section-02' },
  { id: 'claim-03', text: '本章第一节介绍了基本概念', sectionAnchor: 'section-03' }
];

const existingTopics = [
  { id: 'topic-aaa', title: '机器学习基础', aliases: ['ML'], normalizedTitle: '机器学习基础' }
];

const mockAi = () => new MockAiProvider();

// A garbage AI that returns non-JSON for every call (simulates LLM failure).
const garbageAi = {
  async generateText() { return 'not json'; },
  async *streamText() { /* not used */ },
  async embed() { return []; },
  async embedBatch(texts: string[]) { return texts.map(() => []); }
} as unknown as AiProvider;

// ---------- routeClaims -----------------------------------------------------

describe('P0-6: routeClaims — 7-action routing decision', () => {
  it('routes the first Claim to update_existing when an existing Topic matches', async () => {
    const decisions = await routeClaims(sampleClaims, existingTopics, '测试页面', mockAi());
    expect(decisions).toHaveLength(3);
    const first = decisions.find((d) => d.claimId === 'claim-01');
    expect(first).toBeDefined();
    expect(first!.routingAction).toBe('update_existing');
    expect(first!.targetTopicId).toBe('topic-aaa');
  });

  it('routes the first Claim to create_emerging when no existing Topic matches', async () => {
    const decisions = await routeClaims(sampleClaims, [], '测试页面', mockAi());
    const first = decisions.find((d) => d.claimId === 'claim-01');
    expect(first).toBeDefined();
    expect(first!.routingAction).toBe('create_emerging');
    expect(first!.newTopicTitle).toBeTruthy();
  });

  it('routes chapter-level Claims (not the first) to keep_as_facet', async () => {
    const decisions = await routeClaims(sampleClaims, [], '测试页面', mockAi());
    const facet = decisions.find((d) => d.claimId === 'claim-02');
    expect(facet).toBeDefined();
    expect(facet!.routingAction).toBe('keep_as_facet');
  });

  it('returns a decision for every incoming Claim (1:1 mapping)', async () => {
    const decisions = await routeClaims(sampleClaims, existingTopics, '测试页面', mockAi());
    expect(decisions).toHaveLength(sampleClaims.length);
    const claimIds = decisions.map((d) => d.claimId);
    for (const c of sampleClaims) {
      expect(claimIds).toContain(c.id);
    }
  });

  it('only uses valid routing actions from the 7 allowed', async () => {
    const decisions = await routeClaims(sampleClaims, existingTopics, '测试页面', mockAi());
    const validActions = new Set([
      'update_existing', 'create_emerging', 'keep_as_facet',
      'attach_as_example', 'keep_as_reference', 'ignore_duplicate', 'request_review'
    ]);
    for (const d of decisions) {
      expect(validActions.has(d.routingAction)).toBe(true);
    }
  });

  it('downgrades to request_review when LLM references a non-existent targetTopicId', async () => {
    // An AI that returns update_existing with a fake targetTopicId.
    const badAi = {
      async generateText() {
        return JSON.stringify({
          decisions: [
            { claimId: 'claim-01', routingAction: 'update_existing', targetTopicId: 'nonexistent-topic', reason: 'fake' }
          ]
        });
      },
      async *streamText() { /* not used */ },
      async embed() { return []; },
      async embedBatch(texts: string[]) { return texts.map(() => []); }
    } as unknown as AiProvider;
    const decisions = await routeClaims(sampleClaims, existingTopics, '测试页面', badAi);
    const first = decisions.find((d) => d.claimId === 'claim-01');
    expect(first).toBeDefined();
    expect(first!.routingAction).toBe('request_review');
    expect(first!.reason).toContain('转人工复核');
  });

  it('downgrades to request_review when create_emerging has no newTopicTitle', async () => {
    const badAi = {
      async generateText() {
        return JSON.stringify({
          decisions: [
            { claimId: 'claim-01', routingAction: 'create_emerging', reason: 'no title' }
          ]
        });
      },
      async *streamText() { /* not used */ },
      async embed() { return []; },
      async embedBatch(texts: string[]) { return texts.map(() => []); }
    } as unknown as AiProvider;
    const decisions = await routeClaims(sampleClaims, [], '测试页面', badAi);
    const first = decisions.find((d) => d.claimId === 'claim-01');
    expect(first).toBeDefined();
    expect(first!.routingAction).toBe('request_review');
  });

  it('falls back to request_review for all Claims on LLM failure', async () => {
    const decisions = await routeClaims(sampleClaims, existingTopics, '测试页面', garbageAi);
    expect(decisions).toHaveLength(sampleClaims.length);
    for (const d of decisions) {
      expect(d.routingAction).toBe('request_review');
      expect(d.reason).toContain('转人工复核');
    }
  });

  it('returns an empty array when no Claims are provided', async () => {
    const decisions = await routeClaims([], existingTopics, '测试页面', mockAi());
    expect(decisions).toEqual([]);
  });

  it('fills missing Claims with request_review when LLM omits them', async () => {
    const partialAi = {
      async generateText() {
        return JSON.stringify({
          decisions: [
            { claimId: 'claim-01', routingAction: 'create_emerging', newTopicTitle: '新主题', reason: '边界清晰' }
          ]
        });
      },
      async *streamText() { /* not used */ },
      async embed() { return []; },
      async embedBatch(texts: string[]) { return texts.map(() => []); }
    } as unknown as AiProvider;
    const decisions = await routeClaims(sampleClaims, [], '测试页面', partialAi);
    expect(decisions).toHaveLength(3);
    const missing = decisions.find((d) => d.claimId === 'claim-02');
    expect(missing).toBeDefined();
    expect(missing!.routingAction).toBe('request_review');
  });
});

// ---------- analyzeClaimRelations ------------------------------------------

describe('P0-6: analyzeClaimRelations — semantic relation analysis', () => {
  it('returns relations for pairs of Claims', async () => {
    const relations = await analyzeClaimRelations(sampleClaims, mockAi());
    expect(relations.length).toBeGreaterThan(0);
    // At least one supports relation between claim-01 and claim-02.
    const supports = relations.find((r) => r.relation === 'supports');
    expect(supports).toBeDefined();
  });

  it('only uses valid relation types', async () => {
    const relations = await analyzeClaimRelations(sampleClaims, mockAi());
    const validRelations = new Set(['supports', 'contradicts', 'refines', 'unrelated']);
    for (const r of relations) {
      expect(validRelations.has(r.relation)).toBe(true);
    }
  });

  it('only references Claim IDs from the input', async () => {
    const relations = await analyzeClaimRelations(sampleClaims, mockAi());
    const claimIds = new Set(sampleClaims.map((c) => c.id));
    for (const r of relations) {
      expect(claimIds.has(r.claimAId)).toBe(true);
      expect(claimIds.has(r.claimBId)).toBe(true);
      expect(r.claimAId).not.toBe(r.claimBId);
    }
  });

  it('returns an empty array when fewer than 2 Claims are provided', async () => {
    const relations = await analyzeClaimRelations([sampleClaims[0]], mockAi());
    expect(relations).toEqual([]);
  });

  it('returns an empty array on LLM failure (graceful degradation)', async () => {
    const relations = await analyzeClaimRelations(sampleClaims, garbageAi);
    expect(relations).toEqual([]);
  });
});

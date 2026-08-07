import { describe, expect, it } from 'vitest';
import { MockAiProvider, type AiProvider, type AiMessage } from '@zhipane/ai';
import {
  evaluateSynthesisQuality,
  evaluateLockedFieldViolations,
  applySynthesisRespectingLocks,
  generateTopicSynthesis,
  type SupportChunk
} from '../services/wiki.service';
import type { TopicSynthesis } from '@zhipane/shared';

// ---------- helpers ---------------------------------------------------------

const baseChunks: SupportChunk[] = [
  { chunkId: 'chunk-a1', pageId: 'page-a', content: '机器学习是研究如何让计算机系统从数据中学习的学科，常用于分类与回归任务。', contentVersion: 1 },
  { chunkId: 'chunk-b2', pageId: 'page-b', content: '深度学习是机器学习的一个分支，使用多层神经网络处理复杂数据。', contentVersion: 1 }
];

function makeSynth(overrides: Partial<TopicSynthesis> = {}): TopicSynthesis {
  return {
    schemaVersion: 'topic-synthesis-v1',
    definition: '该主题围绕机器学习与深度学习的基本概念形成可审阅的结论。',
    overview: '综合多源资料，机器学习与深度学习构成了现代人工智能的核心方法体系，二者在数据驱动上互为补充。',
    keyPoints: [
      {
        id: 'kp-1',
        title: '机器学习的定义',
        content: '机器学习研究如何让计算机系统从数据中学习，常用于分类与回归任务。',
        citations: [{ chunkId: 'chunk-a1', excerpt: '机器学习是研究如何让计算机系统从数据中学习的学科' }]
      },
      {
        id: 'kp-2',
        title: '深度学习的位置',
        content: '深度学习是机器学习的一个分支，使用多层神经网络处理复杂数据。',
        citations: [{ chunkId: 'chunk-b2', excerpt: '深度学习是机器学习的一个分支' }]
      }
    ],
    subtopics: [],
    conflicts: [],
    decisions: [],
    openQuestions: [],
    relatedTopicIds: [],
    generatedFromContentVersions: [],
    ...overrides
  };
}

// A flaky AI that returns an HTML-fragment synthesis on the first call and
// delegates repair calls to MockAiProvider (which returns a clean synthesis
// via its "知识综合修复助手" branch).
function makeFlakyAi(): AiProvider {
  const mock = new MockAiProvider();
  let callCount = 0;
  return {
    async generateText(messages: AiMessage[]) {
      const system = messages.find((m: AiMessage) => m.role === 'system')?.content ?? '';
      if (system.includes('知识综合修复助手')) {
        return mock.generateText(messages);
      }
      callCount++;
      if (callCount === 1) {
        return JSON.stringify({
          schemaVersion: 'topic-synthesis-v1',
          definition: '该主题围绕机器学习与深度学习的基本概念形成可审阅的结论。',
          overview: '综合多源资料，机器学习与深度学习构成了现代人工智能的核心方法体系，二者在数据驱动上互为补充。',
          keyPoints: [
            {
              id: 'kp-1',
              title: '要点',
              content: '<div>包含 HTML 残片的内容</div>',
              citations: [{ chunkId: 'chunk-a1', excerpt: '机器学习基础' }]
            }
          ],
          subtopics: [], conflicts: [], decisions: [], openQuestions: [], relatedTopicIds: [], generatedFromContentVersions: []
        });
      }
      return mock.generateText(messages);
    },
    async *streamText() { /* not used */ },
    async embed() { return []; },
    async embedBatch(texts: string[]) { return texts.map(() => []); }
  } as unknown as AiProvider;
}

// An AI that ALWAYS returns an HTML-fragment synthesis, even on repair calls,
// so the repair loop exhausts its 2 rounds and routes to the anomaly queue.
function makeAlwaysBadAi(): AiProvider {
  const bad = JSON.stringify({
    schemaVersion: 'topic-synthesis-v1',
    definition: '该主题围绕机器学习与深度学习的基本概念形成可审阅的结论。',
    overview: '综合多源资料，机器学习与深度学习构成了现代人工智能的核心方法体系，二者在数据驱动上互为补充。',
    keyPoints: [
      {
        id: 'kp-1',
        title: '要点',
        content: '<div>仍然包含 HTML 残片</div>',
        citations: [{ chunkId: 'chunk-a1', excerpt: '机器学习基础' }]
      }
    ],
    subtopics: [], conflicts: [], decisions: [], openQuestions: [], relatedTopicIds: [], generatedFromContentVersions: []
  });
  return {
    async generateText() { return bad; },
    async *streamText() { /* not used */ },
    async embed() { return []; },
    async embedBatch(texts: string[]) { return texts.map(() => []); }
  } as unknown as AiProvider;
}

// ---------- evaluateSynthesisQuality: new P0-5 checks ----------------------

describe('P0-5: evaluateSynthesisQuality — HTML fragment detection', () => {
  it('flags html_fragment when a keyPoint contains a raw HTML tag', () => {
    const synth = makeSynth({
      keyPoints: [
        { id: 'kp-1', title: '要点', content: '<div>HTML 残片</div>', citations: [{ chunkId: 'chunk-a1', excerpt: '机器学习基础' }] }
      ]
    });
    const result = evaluateSynthesisQuality(synth, baseChunks);
    expect(result.issues).toContain('html_fragment');
  });

  it('does not flag html_fragment for clean synthesis', () => {
    const result = evaluateSynthesisQuality(makeSynth(), baseChunks);
    expect(result.issues).not.toContain('html_fragment');
  });
});

describe('P0-5: evaluateSynthesisQuality — citation support check', () => {
  it('flags citation_not_supporting when the citation excerpt shares no overlap with the keyPoint', () => {
    const synth = makeSynth({
      keyPoints: [
        {
          id: 'kp-1',
          title: '量子物理基础',
          content: '量子物理研究微观粒子的波粒二象性与测不准原理。',
          citations: [{ chunkId: 'chunk-a1', excerpt: '机器学习使用梯度下降优化模型参数。' }]
        }
      ]
    });
    const result = evaluateSynthesisQuality(synth, baseChunks);
    expect(result.issues).toContain('citation_not_supporting');
  });

  it('does not flag citation_not_supporting when the excerpt overlaps the keyPoint', () => {
    const result = evaluateSynthesisQuality(makeSynth(), baseChunks);
    expect(result.issues).not.toContain('citation_not_supporting');
  });

  it('does not flag citation_not_supporting when excerpt is empty (trust the LLM)', () => {
    const synth = makeSynth({
      keyPoints: [
        { id: 'kp-1', title: '量子物理', content: '量子物理研究微观粒子。', citations: [{ chunkId: 'chunk-a1', excerpt: '' }] }
      ]
    });
    const result = evaluateSynthesisQuality(synth, baseChunks);
    expect(result.issues).not.toContain('citation_not_supporting');
  });
});

describe('P0-5: evaluateSynthesisQuality — off-topic drift check', () => {
  it('flags off_topic_drift when a keyPoint is unrelated to every source chunk', () => {
    const synth = makeSynth({
      keyPoints: [
        {
          id: 'kp-1',
          title: '量子物理',
          content: '量子物理研究微观粒子的波粒二象性与测不准原理，与经典力学截然不同。',
          citations: [{ chunkId: 'chunk-a1', excerpt: '量子物理研究微观粒子的波粒二象性' }]
        }
      ]
    });
    const result = evaluateSynthesisQuality(synth, baseChunks);
    expect(result.issues).toContain('off_topic_drift');
  });

  it('does not flag off_topic_drift when keyPoints are grounded in the chunks', () => {
    const result = evaluateSynthesisQuality(makeSynth(), baseChunks);
    expect(result.issues).not.toContain('off_topic_drift');
  });
});

// ---------- locked-field helpers ------------------------------------------

describe('P0-5: evaluateLockedFieldViolations', () => {
  it('returns no violations when lockedFields is empty', () => {
    const result = evaluateLockedFieldViolations(makeSynth(), []);
    expect(result.violations).toHaveLength(0);
  });

  it('returns a violation per locked field that the synthesis would overwrite', () => {
    const synth = makeSynth();
    expect(evaluateLockedFieldViolations(synth, ['definition']).violations).toContain('definition_locked');
    expect(evaluateLockedFieldViolations(synth, ['overview']).violations).toContain('overview_locked');
    expect(evaluateLockedFieldViolations(synth, ['keyPoints']).violations).toContain('keyPoints_locked');
    expect(evaluateLockedFieldViolations(synth, ['definition', 'overview', 'keyPoints']).violations).toHaveLength(3);
  });

  it('returns no violations for null / undefined lockedFields', () => {
    expect(evaluateLockedFieldViolations(makeSynth(), null).violations).toHaveLength(0);
    expect(evaluateLockedFieldViolations(makeSynth(), undefined).violations).toHaveLength(0);
  });
});

describe('P0-5: applySynthesisRespectingLocks', () => {
  it('preserves locked fields from the previous synthesis and lets unlocked fields update', () => {
    const previous = makeSynth({
      definition: '旧的定义内容',
      overview: '旧的概述内容',
      keyPoints: [{ id: 'old-kp', title: '旧要点', content: '旧要点内容', citations: [{ chunkId: 'chunk-a1', excerpt: '' }] }]
    });
    const next = makeSynth({
      definition: '新的定义内容',
      overview: '新的概述内容',
      keyPoints: [{ id: 'new-kp', title: '新要点', content: '新要点内容', citations: [{ chunkId: 'chunk-a1', excerpt: '' }] }]
    });
    const result = applySynthesisRespectingLocks(next, previous, ['definition', 'keyPoints']);
    expect(result.definition).toBe('旧的定义内容'); // locked -> preserved
    expect(result.overview).toBe('新的概述内容'); // not locked -> updated
    expect(result.keyPoints).toEqual(previous.keyPoints); // locked -> preserved
  });

  it('returns next unchanged when there are no locked fields', () => {
    const next = makeSynth();
    expect(applySynthesisRespectingLocks(next, null, [])).toBe(next);
    expect(applySynthesisRespectingLocks(next, null, null)).toBe(next);
  });

  it('returns next unchanged when previous synthesis is missing', () => {
    const next = makeSynth();
    expect(applySynthesisRespectingLocks(next, null, ['definition'])).toBe(next);
  });
});

// ---------- automatic repair loop -----------------------------------------

describe('P0-5: automatic repair loop (generateTopicSynthesis)', () => {
  it('converges to a ready synthesis after one repair round', async () => {
    const result = await generateTopicSynthesis(baseChunks, makeFlakyAi());
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      // The repaired synthesis must not contain HTML fragments.
      const recheck = evaluateSynthesisQuality(result.synthesis, baseChunks);
      expect(recheck.issues).not.toContain('html_fragment');
    }
  });

  it('routes to the anomaly queue (failed) after 2 unsuccessful repair rounds', async () => {
    const result = await generateTopicSynthesis(baseChunks, makeAlwaysBadAi());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('2 轮自动修复后仍失败');
      expect(result.diagnostics.qualityIssues).toContain('html_fragment');
    }
  });

  it('returns failed immediately (no repair) when there are no chunks', async () => {
    const result = await generateTopicSynthesis([], new MockAiProvider());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.diagnostics.evidenceCount).toBe(0);
    }
  });
});

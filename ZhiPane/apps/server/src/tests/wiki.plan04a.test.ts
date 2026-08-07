import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deterministicVector, type AiProvider } from '@zhipane/ai';
import { evaluateSynthesisQuality, generateTopicSynthesis, type SupportChunk } from '../services/wiki.service';

const fixturePath = join(process.cwd(), 'src/tests/fixtures/deepseek-long-essay.md');

const support: SupportChunk[] = [
  { chunkId: 'chunk-01', pageId: 'page-01', content: readFileSync(fixturePath, 'utf8'), contentVersion: 1 }
];

const garbageAi = {
  async generateText() { return 'not json'; },
  async *streamText() {},
  async embed(text: string) { return deterministicVector(text, 1536); },
  async embedBatch(texts: string[]) { return texts.map((text) => deterministicVector(text, 1536)); }
} as unknown as AiProvider;

describe('Plan 04-A synthesis quality stopgap', () => {
  it('keeps the full DeepSeek fixture as a deterministic long-document regression sample', () => {
    const text = support[0].content;
    expect(text.length).toBeGreaterThan(1_000);
    for (const section of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']) {
      expect(text).toContain(`# ${section}`);
    }
    expect(text).toContain('结尾反思');
  });

  it('reports a failed result with evidence preview instead of deterministic pseudo-synthesis', async () => {
    const result = await generateTopicSynthesis(support, garbageAi);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.evidencePreview[0].excerpt).toContain('DeepSeek');
      expect(result.diagnostics.inputCharacterCount).toBe(support[0].content.length);
      expect(result.diagnostics.usedFallback).toBe(false);
    }
  });

  it('rejects duplicated definition, overview and key points', () => {
    const repeated = '这是同一段重复内容，用于验证质量门禁止把原文或相同结论重复填入不同字段。';
    const quality = evaluateSynthesisQuality({
      schemaVersion: 'topic-synthesis-v1',
      definition: repeated,
      overview: repeated,
      keyPoints: [
        { id: 'one', title: '重复要点', content: repeated, citations: [{ chunkId: 'chunk-01', excerpt: '' }] },
        { id: 'two', title: '重复要点', content: repeated, citations: [{ chunkId: 'chunk-01', excerpt: '' }] }
      ],
      subtopics: [], conflicts: [], decisions: [], openQuestions: [], relatedTopicIds: [],
      generatedFromContentVersions: [{ pageId: 'page-01', contentVersion: 1 }]
    }, support);
    expect(quality.issues).toContain('definition_overview_redundant');
    expect(quality.issues).toContain('key_points_redundant');
  });

  it('rejects sentence fragments and long copied source text', () => {
    const copied = support[0].content.slice(0, 160);
    const quality = evaluateSynthesisQuality({
      schemaVersion: 'topic-synthesis-v1',
      definition: '起来，需要建立完整的判断。',
      overview: copied,
      keyPoints: [{ id: 'one', title: '结论', content: copied, citations: [{ chunkId: 'chunk-01', excerpt: '' }] }],
      subtopics: [], conflicts: [], decisions: [], openQuestions: [], relatedTopicIds: [],
      generatedFromContentVersions: [{ pageId: 'page-01', contentVersion: 1 }]
    }, support);
    expect(quality.issues).toContain('sentence_fragment');
    expect(quality.issues).toContain('source_copy_too_long');
  });
});

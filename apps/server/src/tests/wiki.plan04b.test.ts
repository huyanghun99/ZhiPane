import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPageKnowledgeMap } from '../services/page-knowledge.service';

const text = readFileSync(join(process.cwd(), 'src/tests/fixtures/deepseek-long-essay.md'), 'utf8');

describe('Plan 04-B page knowledge map', () => {
  it('covers the full DeepSeek document as sections and facets', () => {
    const chunks = text.split(/(?=^# )/m).filter(Boolean).map((content, index) => ({ id: `chunk-${index + 1}`, content }));
    const map = buildPageKnowledgeMap(text, 'DeepSeek 长文', chunks);
    expect(map.documentType).toBe('single_topic_essay');
    expect(map.processedCharacterCount / map.inputCharacterCount).toBeGreaterThanOrEqual(0.95);
    expect(map.sectionTree.length).toBeGreaterThanOrEqual(11);
    expect(map.facets.length).toBeGreaterThanOrEqual(6);
    expect(map.facets.length).toBeLessThanOrEqual(10);
    for (const concept of ['Scaling Law', '算力与国产芯片', '行业收敛', '高质量数据']) expect(map.sectionTree.map((section) => section.heading).join(' ')).toContain(concept);
  });
});

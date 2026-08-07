import { describe, expect, it } from 'vitest';
import { classifyLegacyTopic } from '../services/wiki-migration.service';

describe('Plan 04 Phase 7 migration classifier', () => {
  const base = { id: 'x', title: '主题', status: 'accepted', source: 'ai_generated', contentJson: { schemaVersion: 'topic-synthesis-v1', definition: '定义', overview: '概述', keyPoints: [{}] }, textContent: '正文', sourceCount: 2, chunkSourceCount: 2 };
  it('preserves user edits', () => expect(classifyLegacyTopic({ ...base, status: 'user_edited', userEditedAt: new Date() }).disposition).toBe('preserve_user_override'));
  it('flags single chunk topics for facet degradation', () => expect(classifyLegacyTopic({ ...base, chunkSourceCount: 1 }).disposition).toBe('suggest_degrade_to_facet'));
  it('flags invalid synthesis for reprocessing', () => expect(classifyLegacyTopic({ ...base, contentJson: { type: 'doc' } }).disposition).toBe('degrade_and_resynthesize'));
  it('keeps valid v2 synthesis', () => expect(classifyLegacyTopic(base).disposition).toBe('migrate_v2'));
});

export type LegacyTopicSnapshot = {
  id: string;
  title: string;
  status: string;
  source: string;
  contentJson: unknown;
  textContent: string;
  userEditedAt?: Date | null;
  synthesisStatus?: string;
  sourceCount: number;
  chunkSourceCount: number;
};

export type MigrationDisposition = 'migrate_v2' | 'degrade_and_resynthesize' | 'suggest_degrade_to_facet' | 'suggest_merge' | 'preserve_user_override';

export function classifyLegacyTopic(topic: LegacyTopicSnapshot): { disposition: MigrationDisposition; reasons: string[] } {
  const json = topic.contentJson as { schemaVersion?: string; definition?: string; overview?: string; keyPoints?: unknown[] } | null;
  if (topic.userEditedAt || topic.status === 'user_edited') return { disposition: 'preserve_user_override', reasons: ['用户已编辑正文'] };
  if (topic.chunkSourceCount <= 1) return { disposition: 'suggest_degrade_to_facet', reasons: ['仅有一个 Chunk 证据'] };
  if (topic.synthesisStatus === 'failed' || json?.schemaVersion === 'topic-synthesis-failed-v1') return { disposition: 'degrade_and_resynthesize', reasons: ['综合失败'] };
  if (json?.schemaVersion !== 'topic-synthesis-v1' || !Array.isArray(json.keyPoints) || json.keyPoints.length === 0) return { disposition: 'degrade_and_resynthesize', reasons: ['缺少有效 V2 综合结构'] };
  const normalize = (value: string) => value.replace(/\s+/g, '').replace(/[\p{P}\p{S}]/gu, '').toLocaleLowerCase();
  if (json.definition && json.overview && normalize(json.definition) === normalize(json.overview)) return { disposition: 'degrade_and_resynthesize', reasons: ['定义与概述重复'] };
  return { disposition: 'migrate_v2', reasons: ['结构完整且质量可用'] };
}

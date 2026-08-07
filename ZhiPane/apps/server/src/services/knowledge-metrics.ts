import { logger } from './logger';

export type KnowledgeStage = 'page_map' | 'claim_extraction' | 'topic_assignment' | 'synthesis';
export type KnowledgeMetric = { stage: KnowledgeStage; pageId?: string; contentVersion?: number; durationMs: number; inputCharacters: number; outputItems: number; cacheHit: boolean; at: string };
const recent: KnowledgeMetric[] = [];
const MAX_RECENT = 500;
export function recordKnowledgeStage(metric: Omit<KnowledgeMetric, 'at'>): void {
  const item = { ...metric, at: new Date().toISOString() };
  recent.push(item);
  if (recent.length > MAX_RECENT) recent.shift();
  logger.info('knowledge stage complete', item);
}
export function getKnowledgeMetrics(): KnowledgeMetric[] { return recent.slice(); }
export function clearKnowledgeMetrics(): void { recent.length = 0; }

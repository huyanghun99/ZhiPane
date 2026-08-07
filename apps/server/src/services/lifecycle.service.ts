import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { getActivityStats } from './activity.service';

// Phase 5 (F4) thresholds (days). All deterministic domain policy — never LLM.
export const TOPIC_COOLING_DAYS = 90;
export const TOPIC_ARCHIVE_DAYS = 180;
export const PROJECT_GRACE_DAYS = 30;
export const RESOURCE_ARCHIVE_DAYS = 365;
export const RAG_CITATION_PROTECT_DAYS = 30;

export const LIFECYCLE_SUGGESTION_TYPES = [
  'lifecycle_cooling',
  'lifecycle_archive',
  'reactivation',
  'inbox_classify'
] as const;

export interface LifecycleSuggestion {
  topicId: string;
  spaceId: string;
  type: string;
  reason: string;
}

function daysSince(date: Date | null, fallback: Date): number {
  const d = date ?? fallback;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * A Topic is "referenced by an active project" when an *active* project Space
 * has a knowledge edge pointing at it. Such Topics must never be auto-archived
 * (spec F4 protection: "被活跃项目引用").
 */
export async function isReferencedByActiveProject(topicId: string): Promise<boolean> {
  const rows = await db.execute<any>(sql`
    SELECT 1 FROM knowledge_edges
    WHERE target_type = 'topic' AND target_id = ${topicId}::uuid AND status <> 'deleted'
      AND space_id IN (SELECT id FROM spaces WHERE space_kind = 'project' AND lifecycle_status = 'active')
    LIMIT 1
  `);
  return rows.rows.length > 0;
}

/**
 * Protection rules that prevent a Topic from receiving an archive suggestion
 * (spec F4 "保护条件"). Any one of these blocks auto-archiving.
 */
export async function isProtectedTopic(topic: Record<string, unknown>, stats: Record<string, unknown> | null): Promise<boolean> {
  if (topic.pinned) return true;
  if (topic.keep_active_until && new Date(topic.keep_active_until as string) > new Date()) return true;
  // user_edited Topics are never auto-archived (spec F4).
  if (topic.publication_status === 'user_edited') return true;
  // An unhandled stale flag means the user still has pending review work — do
  // not archive while stale is outstanding.
  if (topic.freshness_status === 'stale') return true;
  if (await isReferencedByActiveProject(topic.id as string)) return true;
  // Recently cited by RAG (a "final" reference) keeps it alive.
  if (stats?.lastRetrievedAt && daysSince(new Date(stats.lastRetrievedAt as string), new Date()) <= RAG_CITATION_PROTECT_DAYS) {
    return true;
  }
  return false;
}

async function maybeSuggest(
  space: Record<string, unknown>,
  topic: Record<string, unknown>,
  type: string,
  reason: string,
  sink: LifecycleSuggestion[]
): Promise<void> {
  // Idempotent: skip if a pending suggestion of this type already exists for the
  // topic (so re-running the job never stacks duplicates — gate "lifecycle Job 幂等").
  const existing = await db.execute<any>(sql`
    SELECT 1 FROM llm_suggestions
    WHERE space_id = ${space.id}::uuid AND type = ${type} AND status = 'pending'
      AND payload ->> 'topicId' = ${topic.id}::text
    LIMIT 1
  `);
  if (existing.rows.length > 0) {
    // Idempotent: a pending suggestion of this type already exists. Do NOT
    // stack a duplicate, but still reflect it in the returned set so callers
    // (the evaluate API / Archive Center) see the current pending suggestions.
    sink.push({ topicId: topic.id as string, spaceId: space.id as string, type, reason });
    return;
  }
  await db.execute(sql`
    INSERT INTO llm_suggestions(workspace_id, space_id, page_id, topic_id, type, risk, status, payload, evidence)
    VALUES (
      ${space.workspace_id}, ${space.id}, NULL, ${topic.id}, ${type}, 'low', 'pending',
      ${JSON.stringify({ topicId: topic.id, topicTitle: topic.title, reason })}::jsonb,
      ${JSON.stringify({ topicId: topic.id, reason })}::jsonb
    )
  `);
  sink.push({ topicId: topic.id as string, spaceId: space.id as string, type, reason });
}

/**
 * Phase 5 (F4) — the daily lifecycle evaluation Job. It ONLY generates
 * Suggestions (never archives directly). For every non-archived Topic it applies
 * the deterministic threshold + protection rules; for archived Topics recently
 * cited by RAG it proposes reactivation. Scoped by workspaceId / spaceId so the
 * test harness can evaluate a single space.
 */
export async function evaluateLifecycle(workspaceId?: string, spaceId?: string): Promise<{ suggestions: LifecycleSuggestion[] }> {
  const suggestions: LifecycleSuggestion[] = [];
  const spaceRows = await db.execute<any>(sql`
    SELECT * FROM spaces
    WHERE ${workspaceId ? sql`workspace_id = ${workspaceId}::uuid` : sql`1 = 1`}
      AND ${spaceId ? sql`id = ${spaceId}::uuid` : sql`1 = 1`}
  `);

  for (const space of spaceRows.rows) {
    const topicRows = await db.execute<any>(sql`
      SELECT * FROM wiki_topics
      WHERE space_id = ${space.id}::uuid
        AND lifecycle_status <> 'archived'
        AND merged_into_topic_id IS NULL
    `);

    for (const topic of topicRows.rows) {
      const stats = await getActivityStats('topic', topic.id);
      const lastActivity = topic.last_meaningful_activity_at
        ? new Date(topic.last_meaningful_activity_at as string)
        : topic.created_at
          ? new Date(topic.created_at as string)
          : new Date();
      const inactiveDays = daysSince(lastActivity, new Date());
      const protectedTopic = await isProtectedTopic(topic, stats);

      // Inbox: only a classification hint, never an archive suggestion.
      if (space.space_kind === 'inbox') {
        if (!protectedTopic) {
          await maybeSuggest(space, topic, 'inbox_classify', '该笔记尚未分类，建议整理到合适的 Space。', suggestions);
        }
        continue;
      }

      if (protectedTopic) continue;

      // Archive threshold: Resource spaces use a longer window; a completed
      // Project's topics may be archived after a short grace period.
      const isCompletedProject = space.space_kind === 'project' && space.lifecycle_status === 'completed';
      const archiveDays = isCompletedProject
        ? PROJECT_GRACE_DAYS
        : space.space_kind === 'resource'
          ? RESOURCE_ARCHIVE_DAYS
          : TOPIC_ARCHIVE_DAYS;

      if (inactiveDays >= archiveDays) {
        const reason = isCompletedProject
          ? `项目已完成 ${Math.floor(inactiveDays)} 天且无活动，建议归档。`
          : `主题已 ${Math.floor(inactiveDays)} 天无有意义活动，建议归档。`;
        await maybeSuggest(space, topic, 'lifecycle_archive', reason, suggestions);
      } else if (inactiveDays >= TOPIC_COOLING_DAYS) {
        await maybeSuggest(
          space,
          topic,
          'lifecycle_cooling',
          `主题已 ${Math.floor(inactiveDays)} 天无活动，建议降权为 cooling/dormant。`,
          suggestions
        );
      }
    }

    // Reactivation: an archived Topic recently cited by RAG is still useful.
    const archivedRows = await db.execute<any>(sql`
      SELECT * FROM wiki_topics
      WHERE space_id = ${space.id}::uuid AND lifecycle_status = 'archived' AND merged_into_topic_id IS NULL
    `);
    for (const topic of archivedRows.rows) {
      const stats = await getActivityStats('topic', topic.id);
      if (stats?.lastRetrievedAt && daysSince(new Date(stats.lastRetrievedAt as string), new Date()) <= RAG_CITATION_PROTECT_DAYS) {
        await maybeSuggest(space, topic, 'reactivation', '归档主题近期被 RAG 引用，建议重新激活。', suggestions);
      }
    }
  }

  return { suggestions };
}

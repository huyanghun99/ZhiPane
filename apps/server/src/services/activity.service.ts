import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { knowledgeActivityStats } from '@zhipane/db';

export type ActivityEntityType = 'topic' | 'page';
export type ActivityEventType =
  | 'edit'
  | 'view'
  | 'search_click'
  | 'rag_citation'
  | 'citation_open'
  | 'added_to_source'
  | 'project_reference';

export interface RecordActivityInput {
  workspaceId: string;
  spaceId: string;
  entityType: ActivityEntityType;
  entityId: string;
  eventType: ActivityEventType;
  userId?: string | null;
  metadata?: Record<string, unknown>;
  /** Override the occurrence time (used by tests to simulate historical events). */
  occurredAt?: Date;
}

/**
 * Record a single *real* user activity event (spec F3). Background tasks (index
 * indexing, AI summaries, scheduled lifecycle evaluation, polling) MUST NOT call
 * this — see the gate "后台任务不伪造活跃度". The matching rolled-up statistics
 * row is recomputed from the event log so the 30-day windows stay exact.
 */
export async function recordActivity(input: RecordActivityInput): Promise<void> {
  const at = input.occurredAt ?? new Date();
  await db.execute(sql`
    INSERT INTO knowledge_activity_events(
      workspace_id, space_id, entity_type, entity_id, event_type, user_id, occurred_at, metadata
    )
    VALUES (
      ${input.workspaceId}, ${input.spaceId}, ${input.entityType}, ${input.entityId},
      ${input.eventType}, ${input.userId ?? null}, ${at}, ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
  `);
  await upsertStats(input.workspaceId, input.spaceId, input.entityType, input.entityId);
}

// Recompute the rolled-up stats for an entity from its event log (exact 30-day
// windows) and upsert them. Deterministic, no LLM, no external calls.
async function upsertStats(
  workspaceId: string,
  spaceId: string,
  entityType: ActivityEntityType,
  entityId: string
): Promise<void> {
  const rows = await db.execute<any>(sql`
    SELECT
      MAX(CASE WHEN event_type = 'edit' THEN occurred_at END) AS last_edited_at,
      MAX(CASE WHEN event_type IN ('view','search_click','citation_open') THEN occurred_at END) AS last_viewed_at,
      MAX(CASE WHEN event_type IN ('search_click','rag_citation') THEN occurred_at END) AS last_retrieved_at,
      MAX(CASE WHEN event_type IN ('added_to_source','project_reference') THEN occurred_at END) AS last_linked_at,
      MAX(occurred_at) AS last_meaningful_activity_at,
      COUNT(*) FILTER (WHERE event_type IN ('view','search_click','citation_open') AND occurred_at >= now() - interval '30 days') AS views30d,
      COUNT(*) FILTER (WHERE event_type IN ('added_to_source','project_reference') AND occurred_at >= now() - interval '30 days') AS citations30d,
      COUNT(*) FILTER (WHERE event_type = 'rag_citation' AND occurred_at >= now() - interval '30 days') AS rag_citations30d,
      COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL AND occurred_at >= now() - interval '30 days') AS active_users30d
    FROM knowledge_activity_events
    WHERE entity_type = ${entityType} AND entity_id = ${entityId}
  `);
  const r = rows.rows[0] ?? {};
  const views30d = Number(r.views30d ?? 0);
  const citations30d = Number(r.citations30d ?? 0);
  const ragCitations30d = Number(r.rag_citations30d ?? 0);
  const activeUsers30d = Number(r.active_users30d ?? 0);
  // Deterministic activity score (capped). Weighted so RAG citations and distinct
  // active users matter most.
  const activityScore = Math.min(1000, views30d * 1 + citations30d * 2 + ragCitations30d * 3 + activeUsers30d * 5);
  await db.execute(sql`
    INSERT INTO knowledge_activity_stats(
      workspace_id, space_id, entity_type, entity_id,
      last_edited_at, last_viewed_at, last_retrieved_at, last_linked_at, last_meaningful_activity_at,
      views_30d, citations_30d, rag_citations_30d, active_users_30d, activity_score, calculated_at
    )
    VALUES (
      ${workspaceId}, ${spaceId}, ${entityType}, ${entityId},
      ${r.last_edited_at ?? null}, ${r.last_viewed_at ?? null}, ${r.last_retrieved_at ?? null},
      ${r.last_linked_at ?? null}, ${r.last_meaningful_activity_at ?? null},
      ${views30d}, ${citations30d}, ${ragCitations30d}, ${activeUsers30d}, ${activityScore}, now()
    )
    ON CONFLICT (entity_type, entity_id)
    DO UPDATE SET
      last_edited_at = EXCLUDED.last_edited_at,
      last_viewed_at = EXCLUDED.last_viewed_at,
      last_retrieved_at = EXCLUDED.last_retrieved_at,
      last_linked_at = EXCLUDED.last_linked_at,
      last_meaningful_activity_at = EXCLUDED.last_meaningful_activity_at,
      views_30d = EXCLUDED.views_30d,
      citations_30d = EXCLUDED.citations_30d,
      rag_citations_30d = EXCLUDED.rag_citations_30d,
      active_users_30d = EXCLUDED.active_users_30d,
      activity_score = EXCLUDED.activity_score,
      calculated_at = now(),
      space_id = EXCLUDED.space_id
  `);
}

/** Fetch the rolled-up stats for an entity (or null if no activity yet). */
export async function getActivityStats(
  entityType: ActivityEntityType,
  entityId: string
): Promise<Record<string, unknown> | null> {
  // Use the Drizzle query builder so results come back with the camelCase field
  // names defined by the schema (e.g. views30d, lastRetrievedAt), matching the
  // API contract consumed by the web client (apps/web/src/types.ts).
  const rows = await db
    .select()
    .from(knowledgeActivityStats)
    .where(
      and(
        eq(knowledgeActivityStats.entityType, entityType),
        eq(knowledgeActivityStats.entityId, entityId)
      )
    )
    .limit(1);
  return (rows[0] ?? null) as Record<string, unknown> | null;
}

/** All activity events for an entity, most-recent first (audit / debugging). */
export async function listActivityEvents(
  entityType: ActivityEntityType,
  entityId: string,
  limit = 100
): Promise<Record<string, unknown>[]> {
  const rows = await db.execute<any>(sql`
    SELECT * FROM knowledge_activity_events
    WHERE entity_type = ${entityType} AND entity_id = ${entityId}
    ORDER BY occurred_at DESC LIMIT ${limit}
  `);
  return rows.rows;
}

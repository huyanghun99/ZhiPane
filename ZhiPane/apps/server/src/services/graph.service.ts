import { sql } from 'drizzle-orm';
import { db } from '../db/client';

export interface GraphNode {
  id: string;
  type: string;
  label: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: string;
  confidence: number;
  status: string;
  evidence: unknown;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface EdgeRow {
  id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  relation_type: string;
  confidence: number;
  status: string;
  evidence: unknown;
  [key: string]: unknown;
}

async function resolveNodeLabels(nodeRefs: Set<string>): Promise<GraphNode[]> {
  const pageIds: string[] = [];
  const topicIds: string[] = [];
  const entityIds: string[] = [];
  for (const ref of nodeRefs) {
    const [type, id] = ref.split(':');
    if (type === 'page') pageIds.push(id);
    else if (type === 'topic') topicIds.push(id);
    else if (type === 'entity') entityIds.push(id);
  }
  const nodes: GraphNode[] = [];
  if (pageIds.length > 0) {
    const list = sql.join(pageIds.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = await db.execute<{ id: string; title: string }>(sql`SELECT id, title FROM pages WHERE id IN (${list})`);
    for (const r of rows.rows) nodes.push({ id: r.id, type: 'page', label: r.title });
  }
  if (topicIds.length > 0) {
    const list = sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = await db.execute<{ id: string; title: string }>(sql`SELECT id, title FROM wiki_topics WHERE id IN (${list})`);
    for (const r of rows.rows) nodes.push({ id: r.id, type: 'topic', label: r.title });
  }
  if (entityIds.length > 0) {
    const list = sql.join(entityIds.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = await db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM entities WHERE id IN (${list})`);
    for (const r of rows.rows) nodes.push({ id: r.id, type: 'entity', label: r.name });
  }
  return nodes;
}

async function buildFullGraph(edgeRows: EdgeRow[]): Promise<Graph> {
  const nodeRefs = new Set<string>();
  const edges: GraphEdge[] = edgeRows.map((r) => {
    nodeRefs.add(`${r.source_type}:${r.source_id}`);
    nodeRefs.add(`${r.target_type}:${r.target_id}`);
    return { id: r.id, source: r.source_id, target: r.target_id, relationType: r.relation_type, confidence: r.confidence, status: r.status, evidence: r.evidence };
  });
  const nodes = await resolveNodeLabels(nodeRefs);
  return { nodes, edges };
}

export async function getGraphAroundEntity(params: { workspaceId: string; spaceId: string; sourceType: string; sourceId: string }): Promise<Graph> {
  const result = await db.execute<EdgeRow>(sql`
    SELECT id, source_type, source_id, target_type, target_id, relation_type, confidence, status, evidence
    FROM knowledge_edges
    WHERE workspace_id = ${params.workspaceId} AND space_id = ${params.spaceId} AND status <> 'deleted'
      AND ((source_type = ${params.sourceType} AND source_id = ${params.sourceId})
        OR (target_type = ${params.sourceType} AND target_id = ${params.sourceId}))
    ORDER BY confidence DESC, updated_at DESC LIMIT 100
  `);
  const graph = await buildFullGraph(result.rows);
  const centerRef = `${params.sourceType}:${params.sourceId}`;
  if (!graph.nodes.some((n) => n.id === params.sourceId)) {
    const [center] = await resolveNodeLabels(new Set([centerRef]));
    if (center) graph.nodes.unshift(center);
  }
  return graph;
}

export async function getSpaceGraph(workspaceId: string, spaceId: string): Promise<Graph> {
  const result = await db.execute<EdgeRow>(sql`
    SELECT id, source_type, source_id, target_type, target_id, relation_type, confidence, status, evidence
    FROM knowledge_edges
    WHERE workspace_id = ${workspaceId} AND space_id = ${spaceId} AND status <> 'deleted'
    ORDER BY confidence DESC, updated_at DESC LIMIT 500
  `);
  return buildFullGraph(result.rows);
}

export async function getEvidenceCard(edgeId: string): Promise<{ space_id: string; [key: string]: unknown } | null> {
  const result = await db.execute<{ space_id: string; [key: string]: unknown }>(sql`SELECT * FROM knowledge_edges WHERE id = ${edgeId} LIMIT 1`);
  return result.rows[0] ?? null;
}

export async function acceptEdge(edgeId: string, userId: string) {
  const result = await db.execute(sql`UPDATE knowledge_edges SET status = 'confirmed', user_confirmed_by_id = ${userId}, confirmed_at = now(), updated_at = now() WHERE id = ${edgeId} RETURNING *`);
  return result.rows[0] ?? null;
}

export async function rejectEdge(edgeId: string) {
  const result = await db.execute(sql`UPDATE knowledge_edges SET status = 'deleted', updated_at = now() WHERE id = ${edgeId} RETURNING *`);
  return result.rows[0] ?? null;
}

export async function patchEdge(edgeId: string, patch: { relationType?: string; confidence?: number; status?: string }) {
  const clauses: ReturnType<typeof sql>[] = [sql`updated_at = now()`];
  if (patch.relationType !== undefined) clauses.push(sql`relation_type = ${patch.relationType}`);
  if (patch.confidence !== undefined) clauses.push(sql`confidence = ${patch.confidence}`);
  if (patch.status !== undefined) clauses.push(sql`status = ${patch.status}`);
  const result = await db.execute(sql`UPDATE knowledge_edges SET ${sql.join(clauses, sql`, `)} WHERE id = ${edgeId} RETURNING *`);
  return result.rows[0] ?? null;
}

export async function getGraphForEntity(params: { workspaceId: string; spaceId: string; sourceType: string; sourceId: string }) {
  const result = await db.execute(sql`
    SELECT * FROM knowledge_edges
    WHERE workspace_id = ${params.workspaceId}
      AND space_id = ${params.spaceId}
      AND status <> 'deleted'
      AND ((source_type = ${params.sourceType} AND source_id = ${params.sourceId})
        OR (target_type = ${params.sourceType} AND target_id = ${params.sourceId}))
    ORDER BY confidence DESC, updated_at DESC
    LIMIT 100
  `);
  return result.rows;
}

/**
 * M6 — when a Wiki suggestion is accepted, promote the knowledge edge(s) it
 * implies to 'confirmed' so the graph reflects the user's decisions.
 */
export async function confirmEdgesForSuggestion(s: { type: string; payload: Record<string, unknown> }): Promise<void> {
  if (s.type === 'cross_link') {
    const p = s.payload as { sourcePageId?: string; targetPageId?: string };
    if (p.sourcePageId && p.targetPageId) {
      await db.execute(sql`
        UPDATE knowledge_edges SET status = 'confirmed', updated_at = now()
        WHERE source_type = 'page' AND source_id = ${p.sourcePageId}
          AND target_type = 'page' AND target_id = ${p.targetPageId}
          AND relation_type = 'related' AND status <> 'deleted'
      `);
    }
  } else if (s.type === 'topic_proposal') {
    const p = s.payload as { topicId?: string };
    if (p.topicId) {
      await db.execute(sql`
        UPDATE knowledge_edges SET status = 'confirmed', updated_at = now()
        WHERE source_type = 'topic' AND source_id = ${p.topicId}
          AND relation_type = 'covers' AND status <> 'deleted'
      `);
    }
  }
}

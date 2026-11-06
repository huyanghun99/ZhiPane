import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import {
  AGENT_SCOPES, createAgentToken, listAgentTokens, revokeAgentToken,
  audit, requireScope
} from '../middleware/agent-auth';
import { db } from '../db/client';
import { env } from '../env';
import { getAppPreferences, saveAppPreferences, getAiExecutionMode } from '../services/app-preferences';

export const agentRoutes = new Hono<AppEnv>();
agentRoutes.use('*', authMiddleware);

const PROMPT_VERSION = 'topic-extraction-v1';
const SYSTEM_PROMPT = '你是知识库整理助手。根据给定笔记内容提取结构化知识：摘要、主题候选、关键论断、标签。只输出 JSON，不要解释。';

/** JSON Schema handed to the desktop agent; the server validates with Zod. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '不超过 400 字的摘要' },
    topics: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, confidence: { type: 'number' } }, required: ['title'] }, description: '主题候选，最多 50 条' },
    claims: { type: 'array', items: { type: 'string' }, description: '关键论断，最多 100 条' },
    tags: { type: 'array', items: { type: 'string' }, description: '标签，最多 30 个' }
  },
  required: ['topics']
};

const wikiResult = z.object({
  summary: z.string().max(4000).optional(),
  topics: z.array(z.object({
    title: z.string().min(1).max(200),
    summary: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1).optional()
  })).max(50).default([]),
  claims: z.array(z.string().max(1000)).max(100).default([]),
  tags: z.array(z.string().max(50)).max(30).default([])
});

async function rows<T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> {
  const r = await db.execute(q) as unknown as { rows: T[] };
  return r.rows ?? [];
}

// ------------------------------------------------------------ token management
const createTokenSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
  workspaceId: z.string().uuid().nullable().optional(),
  ttlDays: z.number().int().min(1).max(365).optional()
});

agentRoutes.get('/tokens', async (c) => {
  return c.json({ tokens: await listAgentTokens(c.get('user').id) });
});

agentRoutes.post('/tokens', async (c) => {
  const body = createTokenSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Invalid input', details: body.error.message }, 400);
  const v = body.data;
  // A token may only be bound to a workspace the caller belongs to.
  if (v.workspaceId) {
    const ok = await rows(sql`
      SELECT 1 FROM workspace_members WHERE workspace_id=${v.workspaceId}::uuid AND user_id=${c.get('user').id}::uuid LIMIT 1
    `);
    if (!ok.length) return c.json({ error: 'Forbidden: not a member of that workspace' }, 403);
  }
  const created = await createAgentToken({
    userId: c.get('user').id, name: v.name, scopes: v.scopes,
    workspaceId: v.workspaceId ?? null, ttlDays: v.ttlDays
  });
  await audit(c.get('user').id, undefined, 'agent.create_token', { name: v.name, scopes: v.scopes }, 'ok');
  // Plaintext is returned exactly once; only its hash is stored.
  return c.json({
    id: created.id, token: created.token, expiresAt: created.expiresAt,
    scopes: v.scopes, workspaceId: v.workspaceId ?? null,
    hint: '请立即保存此 Token，之后无法再次查看。'
  }, 201);
});

agentRoutes.delete('/tokens/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'Invalid id' }, 400);
  await revokeAgentToken(c.get('user').id, id);
  return c.json({ ok: true });
});

/** Ready-to-paste WorkBuddy mcp.json fragment for cloud deployment. */
agentRoutes.get('/config', (c) => {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return c.json({
    workbuddy: {
      mcpServers: {
        zhipane: {
          type: 'http', url: `${base}/mcp`,
          headers: { Authorization: 'Bearer ${ZHIPANE_AGENT_TOKEN}' },
          description: 'ZhiPane 知识库 / 任务管理'
        }
      }
    },
    generic: {
      mcpServers: {
        zhipane: { url: `${base}/mcp`, headers: { Authorization: 'Bearer ${ZHIPANE_AGENT_TOKEN}' } }
      }
    }
  });
});

// ------------------------------------------------------------ instance preferences
agentRoutes.get('/preferences', async (c) => c.json(await getAppPreferences()));

agentRoutes.put('/preferences', async (c) => {
  const schema = z.object({
    aiExecutionMode: z.enum(['internal', 'external']).optional(),
    mcpEnabled: z.boolean().optional(),
    caldavEnabled: z.boolean().optional(),
    embedding: z.object({
      baseUrl: z.string().max(500).optional(),
      model: z.string().max(200).optional(),
      dimension: z.number().int().positive().max(4096).optional(),
      apiKey: z.string().max(2000).optional()
    }).optional()
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.message }, 400);
  return c.json(await saveAppPreferences(parsed.data));
});

// ------------------------------------------------------------ external AI jobs
type JobRow = {
  id: string; type: string; entity_id: string | null; workspace_id: string | null;
  space_id: string | null; payload: Record<string, unknown>; source_version: number | null;
  status: string; locked_by: string | null; locked_at: string | null; attempts: number;
};

agentRoutes.get('/jobs', async (c) => {
  if (!requireScope(c, 'ai:claim')) return c.json({ error: 'Forbidden: ai:claim required' }, 403);
  const bound = c.get('agentWorkspaceId');
  const r = await rows<JobRow>(sql`
    SELECT id, type, entity_id, workspace_id, space_id, payload, source_version, status, locked_by, locked_at, attempts
    FROM jobs WHERE type LIKE 'external.%' AND status IN ('pending','running')
      ${bound ? sql`AND workspace_id = ${bound}::uuid` : sql``}
    ORDER BY priority DESC, run_after ASC LIMIT 50
  `);
  return c.json({ jobs: r });
});

/** Claim one job with a lease. FOR UPDATE SKIP LOCKED prevents double-claiming. */
agentRoutes.post('/jobs/claim', async (c) => {
  if (!requireScope(c, 'ai:claim')) return c.json({ error: 'Forbidden: ai:claim required' }, 403);
  const actor = c.get('agentTokenId') ?? `user:${c.get('user').id}`;
  const bound = c.get('agentWorkspaceId');
  const claimed = await rows<JobRow>(sql`
    WITH candidate AS (
      SELECT id FROM jobs
      WHERE type LIKE 'external.%'
        AND status IN ('pending','running')
        AND run_after <= now()
        AND (locked_at IS NULL OR locked_at < now() - interval '10 minutes')
        ${bound ? sql`AND workspace_id = ${bound}::uuid` : sql``}
      ORDER BY priority DESC, run_after ASC
      LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs j SET status='running', locked_by=${actor}, locked_at=now(),
                      attempts = j.attempts + 1, updated_at=now()
    FROM candidate cd WHERE j.id = cd.id
    RETURNING j.id, j.type, j.entity_id, j.workspace_id, j.space_id, j.payload, j.source_version, j.status
  `);
  return c.json({ job: claimed[0] ?? null });
});

/** Payload = source text + prompt spec + output schema. No model call server-side. */
agentRoutes.get('/jobs/:id/payload', async (c) => {
  if (!requireScope(c, 'ai:claim')) return c.json({ error: 'Forbidden: ai:claim required' }, 403);
  const id = c.req.param('id');
  const r = await rows<JobRow>(sql`
    SELECT id, type, entity_id, workspace_id, space_id, payload, source_version, status, locked_by
    FROM jobs WHERE id=${id}::uuid LIMIT 1
  `);
  const job = r[0];
  if (!job) return c.json({ error: 'Job not found' }, 404);
  const bound = c.get('agentWorkspaceId');
  if (bound && job.workspace_id !== bound) return c.json({ error: 'Forbidden' }, 403);
  const page = job.entity_id
    ? (await rows<{ title: string; text_content: string; content_version: number }>(sql`
        SELECT title, text_content, content_version FROM pages WHERE id=${job.entity_id}::uuid LIMIT 1
      `))[0]
    : null;
  if (page && job.source_version != null && page.content_version !== job.source_version) {
    return c.json({ error: 'Source version changed; this job is stale' }, 409);
  }
  return c.json({
    jobId: job.id, type: job.type, pageId: job.entity_id,
    sourceVersion: job.source_version, promptVersion: PROMPT_VERSION,
    prompt: { system: SYSTEM_PROMPT, user: `请分析以下笔记并输出结构化知识：\n\n${page?.title ?? ''}\n\n${page?.text_content ?? ''}` },
    outputSchema: OUTPUT_SCHEMA
  });
});

/** Submit a validated structured result. Embedding is NOT part of this path. */
agentRoutes.post('/jobs/:id/result', async (c) => {
  if (!requireScope(c, 'ai:submit')) return c.json({ error: 'Forbidden: ai:submit required' }, 403);
  const id = c.req.param('id');
  const parsed = wikiResult.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Result schema invalid', details: parsed.error.message }, 400);
  const r = await rows<JobRow>(sql`
    SELECT id, entity_id, workspace_id, source_version, locked_by, status FROM jobs WHERE id=${id}::uuid LIMIT 1
  `);
  const job = r[0];
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.status !== 'running' && job.status !== 'pending') return c.json({ error: 'Job is not claimable' }, 409);

  const actor = c.get('agentTokenId') ?? `user:${c.get('user').id}`;
  if (job.locked_by && job.locked_by !== actor) return c.json({ error: 'Job is locked by another agent' }, 409);

  const version = job.source_version ?? 0;
  await db.execute(sql`
    INSERT INTO agent_job_results (job_id, source_version, prompt_version, result, submitted_by)
    VALUES (${id}::uuid, ${version}, ${PROMPT_VERSION}, ${JSON.stringify(parsed.data)}::jsonb,
            ${c.get('agentTokenId') ?? null}::uuid)
    ON CONFLICT (job_id, source_version) DO UPDATE SET result = EXCLUDED.result, created_at = now()
  `);
  // Merge tags into the existing page AI profile (safe, additive write).
  if (job.entity_id && parsed.data.tags.length) {
    await db.execute(sql`
      INSERT INTO page_ai_profiles (page_id, workspace_id, space_id, tags)
      SELECT id, workspace_id, space_id, ${JSON.stringify(parsed.data.tags)}::jsonb
      FROM pages WHERE id=${job.entity_id}::uuid
      ON CONFLICT (page_id) DO UPDATE SET tags = EXCLUDED.tags, updated_at = now()
    `);
  }
  await db.execute(sql`
    UPDATE jobs SET status='succeeded', progress = '{"done":1,"total":1,"stage":"external-agent"}'::jsonb,
                    updated_at=now() WHERE id=${id}::uuid
  `);
  void audit(c.get('user').id, c.get('agentTokenId'), 'ai.submit_result', { jobId: id, promptVersion: PROMPT_VERSION }, 'ok');
  return c.json({ ok: true, jobId: id, promptVersion: PROMPT_VERSION });
});

agentRoutes.post('/jobs/:id/fail', async (c) => {
  if (!requireScope(c, 'ai:submit')) return c.json({ error: 'Forbidden: ai:submit required' }, 403);
  const id = c.req.param('id');
  const body = z.object({ reason: z.string().max(500).default('agent failed') })
    .safeParse(await c.req.json().catch(() => ({})));
  await db.execute(sql`
    UPDATE jobs SET status='pending', locked_by=NULL, locked_at=NULL,
      error_message=${body.success ? body.data.reason : 'agent failed'}, updated_at=now()
    WHERE id=${id}::uuid
  `);
  return c.json({ ok: true });
});

agentRoutes.get('/jobs/:id/result', async (c) => {
  const id = c.req.param('id');
  const r = await rows(sql`SELECT * FROM agent_job_results WHERE job_id=${id}::uuid ORDER BY created_at DESC LIMIT 1`);
  return c.json({ result: r[0]?.result ?? null });
});

/** Queue LLM-Wiki jobs for pages that have no successful external result yet. */
agentRoutes.post('/reindex', async (c) => {
  if (!requireScope(c, 'ai:claim')) return c.json({ error: 'Forbidden: ai:claim required' }, 403);
  const body = z.object({ workspaceId: z.string().uuid().optional(), limit: z.number().int().min(1).max(500).default(100) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'Invalid input' }, 400);
  const bound = c.get('agentWorkspaceId') ?? body.data.workspaceId ?? null;
  const queued = await rows<{ id: string }>(sql`
    INSERT INTO jobs (workspace_id, space_id, entity_type, entity_id, type, status, priority, source_version, dedupe_key, payload)
    SELECT p.workspace_id, p.space_id, 'page', p.id, 'external.wiki_extract', 'pending', 100, p.content_version,
           'external:wiki:' || p.id::text, '{}'::jsonb
    FROM pages p
    WHERE p.status='normal'
      ${bound ? sql`AND p.workspace_id = ${bound}::uuid` : sql``}
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.dedupe_key = 'external:wiki:' || p.id::text
          AND j.status IN ('pending','running','succeeded')
      )
    LIMIT ${body.data.limit}
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return c.json({ queued: queued.length });
});

agentRoutes.get('/mode', async (c) => c.json({ mode: await getAiExecutionMode() }));

import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../env';
import type { AppEnv, SessionUser } from './auth';

/** Scopes are additive and workspace-bounded; never a blanket admin scope. */
export const AGENT_SCOPES = [
  'kb:read', 'kb:write',
  'tasks:read', 'tasks:write',
  'ai:claim', 'ai:submit',
  'calendar:read', 'calendar:write'
] as const;
export type AgentScope = typeof AGENT_SCOPES[number];

export interface AgentAuth {
  user: SessionUser;
  tokenId: string;
  scopes: string[];
  workspaceId: string | null;
}

function sha256Hex(v: string) { return createHash('sha256').update(v).digest('hex'); }
export function generateAgentToken() { return `zp_${randomBytes(32).toString('hex')}`; }

type TokenRow = {
  id: string; user_id: string; workspace_id: string | null;
  scopes: string[]; expires_at: string | null; revoked_at: string | null;
};

/** Resolve a Bearer token against agent_tokens; null when missing/expired/revoked. */
export async function resolveAgentToken(raw: string | undefined): Promise<AgentAuth | null> {
  if (!raw) return null;
  const res = await db.execute<{ rows: TokenRow[] }>(sql`
    SELECT id, user_id, workspace_id, scopes, expires_at, revoked_at
    FROM agent_tokens
    WHERE token_hash = ${sha256Hex(raw)}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `);
  const row = (res as unknown as { rows: TokenRow[] }).rows?.[0];
  if (!row) return null;

  const ures = await db.execute<{ rows: Array<{ id: string; email: string; name: string; is_instance_owner: boolean }> }>(sql`
    SELECT id, email, name, is_instance_owner FROM users WHERE id = ${row.user_id}::uuid LIMIT 1
  `);
  const u = (ures as unknown as { rows: Array<{ id: string; email: string; name: string; is_instance_owner: boolean }> }).rows?.[0];
  if (!u) return null;

  await db.execute(sql`UPDATE agent_tokens SET last_used_at = now() WHERE id = ${row.id}::uuid`);
  return {
    user: { id: u.id, email: u.email, name: u.name, isInstanceOwner: u.is_instance_owner },
    tokenId: row.id,
    scopes: row.scopes ?? [],
    workspaceId: row.workspace_id
  };
}

export async function createAgentToken(input: {
  userId: string; name: string; scopes: string[]; workspaceId: string | null; ttlDays?: number;
}): Promise<{ id: string; token: string; expiresAt: string | null }> {
  const token = generateAgentToken();
  const days = Math.min(input.ttlDays ?? env.AGENT_TOKEN_MAX_TTL_DAYS, env.AGENT_TOKEN_MAX_TTL_DAYS);
  const res = await db.execute<{ rows: Array<{ id: string; expires_at: string | null }> }>(sql`
    INSERT INTO agent_tokens (user_id, workspace_id, name, token_hash, scopes, expires_at)
    VALUES (${input.userId}::uuid, ${input.workspaceId}::uuid, ${input.name}, ${sha256Hex(token)},
            ${input.scopes}::text[], now() + (${days} || ' days')::interval)
    RETURNING id, expires_at
  `);
  const row = (res as unknown as { rows: Array<{ id: string; expires_at: string | null }> }).rows[0];
  return { id: row.id, token, expiresAt: row.expires_at };
}

export async function listAgentTokens(userId: string) {
  const res = await db.execute(sql`
    SELECT id, name, workspace_id, scopes, expires_at, last_used_at, revoked_at, created_at
    FROM agent_tokens WHERE user_id = ${userId}::uuid
    ORDER BY created_at DESC
  `);
  return (res as unknown as { rows: unknown[] }).rows;
}

export async function revokeAgentToken(userId: string, id: string) {
  await db.execute(sql`
    UPDATE agent_tokens SET revoked_at = now()
    WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
  `);
}

/** Scope gate shared by MCP tools, agent API and CalDAV. */
export function requireScope(c: Context<AppEnv>, scope: AgentScope): boolean {
  const scopes = c.get('agentScopes');
  // Browser sessions are fully trusted (they already passed session auth).
  if (!scopes) return true;
  return scopes.includes(scope);
}

export function agentWorkspaceId(c: Context<AppEnv>): string | null {
  return c.get('agentWorkspaceId') ?? null;
}

/** Redact obviously sensitive keys before writing an audit row. */
function redact(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const blocked = /token|password|apikey|api_key|secret|contentjson/i;
  for (const [k, v] of Object.entries(params ?? {})) {
    if (blocked.test(k)) { out[k] = '[redacted]'; continue; }
    if (typeof v === 'string' && v.length > 400) out[k] = v.slice(0, 400) + '…';
    else out[k] = v;
  }
  return out;
}

export async function audit(
  userId: string, tokenId: string | undefined, tool: string,
  params: Record<string, unknown>, status: 'ok' | 'error', error?: string
) {
  try {
    await db.execute(sql`
      INSERT INTO agent_audit_logs (token_id, user_id, tool, params, status, error)
      VALUES (${tokenId ?? null}::uuid, ${userId}::uuid, ${tool},
              ${JSON.stringify(redact(params))}::jsonb, ${status}, ${error ?? null})
    `);
  } catch { /* audit must never break the caller */ }
}

/** Retry-safe writes: same (key, token) returns the first stored result. */
export async function withIdempotency<T>(
  tokenId: string | undefined, key: string | undefined, fn: () => Promise<T>
): Promise<T> {
  if (!tokenId || !key) return fn();
  const existing = await db.execute(sql`
    SELECT result FROM agent_idempotency WHERE key = ${key} AND token_id = ${tokenId}::uuid LIMIT 1
  `);
  const row = (existing as unknown as { rows: Array<{ result: T }> }).rows?.[0];
  if (row) return row.result;
  const result = await fn();
  try {
    await db.execute(sql`
      INSERT INTO agent_idempotency (key, token_id, result) VALUES (${key}, ${tokenId}::uuid, ${JSON.stringify(result)}::jsonb)
      ON CONFLICT DO NOTHING
    `);
  } catch { /* best effort */ }
  return result;
}

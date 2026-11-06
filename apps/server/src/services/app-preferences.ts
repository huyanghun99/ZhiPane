import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../env';
import { encryptSecret, decryptSecret, maskSecret } from '../utils/crypto';

/**
 * Instance-level preferences exposed in 全局设置:
 *  - which engine performs LLM Wiki reasoning (server API vs WorkBuddy agent)
 *  - the embedding interface (defaults to the env-configured OpenAI-compatible endpoint)
 *  - whether the cloud MCP / CalDAV endpoints are enabled
 *
 * Embedding always stays on the server-side interface (user decision D2); the
 * external mode only offloads text reasoning / structured extraction.
 */
export type AiExecutionMode = 'internal' | 'external';

export interface EmbeddingOverride {
  baseUrl: string;
  apiKeyEncrypted: string | null;
  model: string;
  dimension: number;
}

interface StoredPreferences {
  aiExecutionMode: AiExecutionMode;
  embedding: EmbeddingOverride;
  mcpEnabled: boolean;
  caldavEnabled: boolean;
}

const KEY = 'agent_preferences';

function defaults(): StoredPreferences {
  return {
    aiExecutionMode: 'internal',
    embedding: {
      baseUrl: env.EMBEDDING_BASE_URL || env.OPENAI_API_URL,
      apiKeyEncrypted: null,
      model: env.AI_EMBEDDING_MODEL,
      dimension: env.EMBEDDING_DIMENSION
    },
    mcpEnabled: env.AGENT_MCP_ENABLED,
    caldavEnabled: env.CALDAV_ENABLED
  };
}

async function read(): Promise<StoredPreferences> {
  try {
    const res = await db.execute<{ rows: Array<{ value: Partial<StoredPreferences> }> }>(sql`
      SELECT value FROM app_settings WHERE key = ${KEY} LIMIT 1
    `);
    const v = (res as unknown as { rows: Array<{ value: Partial<StoredPreferences> }> }).rows?.[0]?.value;
    const d = defaults();
    if (!v || typeof v !== 'object') return d;
    return {
      aiExecutionMode: v.aiExecutionMode === 'external' ? 'external' : 'internal',
      embedding: { ...d.embedding, ...(v.embedding ?? {}) },
      mcpEnabled: typeof v.mcpEnabled === 'boolean' ? v.mcpEnabled : d.mcpEnabled,
      caldavEnabled: typeof v.caldavEnabled === 'boolean' ? v.caldavEnabled : d.caldavEnabled
    };
  } catch {
    return defaults();
  }
}

/** Public DTO — never exposes the API key, only a masked preview. */
export async function getAppPreferences() {
  const p = await read();
  let apiKeyMasked = '';
  if (p.embedding.apiKeyEncrypted) {
    try { apiKeyMasked = maskSecret(decryptSecret(p.embedding.apiKeyEncrypted)); } catch { apiKeyMasked = ''; }
  }
  const fallbackKey = env.EMBEDDING_API_KEY || env.OPENAI_API_KEY || '';
  return {
    aiExecutionMode: p.aiExecutionMode,
    mcpEnabled: p.mcpEnabled,
    caldavEnabled: p.caldavEnabled,
    embedding: {
      baseUrl: p.embedding.baseUrl,
      model: p.embedding.model,
      dimension: p.embedding.dimension,
      apiKeyMasked: apiKeyMasked || (fallbackKey ? maskSecret(fallbackKey) : ''),
      hasApiKey: !!p.embedding.apiKeyEncrypted || !!fallbackKey
    }
  };
}

/** Effective embedding settings for the AI provider (includes decrypted key). */
export async function getEffectiveEmbedding() {
  const p = await read();
  let apiKey = env.EMBEDDING_API_KEY || env.OPENAI_API_KEY || '';
  if (p.embedding.apiKeyEncrypted) {
    try { apiKey = decryptSecret(p.embedding.apiKeyEncrypted); } catch { /* keep env */ }
  }
  return {
    baseUrl: p.embedding.baseUrl || env.EMBEDDING_BASE_URL || env.OPENAI_API_URL,
    apiKey,
    model: p.embedding.model || env.AI_EMBEDDING_MODEL,
    dimension: p.embedding.dimension || env.EMBEDDING_DIMENSION
  };
}

export async function getAiExecutionMode(): Promise<AiExecutionMode> {
  return (await read()).aiExecutionMode;
}

export async function isMcpEnabled() { return (await read()).mcpEnabled && env.AGENT_MCP_ENABLED; }
export async function isCaldavEnabled() { return (await read()).caldavEnabled && env.CALDAV_ENABLED; }

export async function saveAppPreferences(input: {
  aiExecutionMode?: AiExecutionMode;
  mcpEnabled?: boolean;
  caldavEnabled?: boolean;
  embedding?: { baseUrl?: string; model?: string; dimension?: number; apiKey?: string };
}) {
  const current = await read();
  const next: StoredPreferences = { ...current };
  if (input.aiExecutionMode === 'internal' || input.aiExecutionMode === 'external') {
    next.aiExecutionMode = input.aiExecutionMode;
  }
  if (typeof input.mcpEnabled === 'boolean') next.mcpEnabled = input.mcpEnabled;
  if (typeof input.caldavEnabled === 'boolean') next.caldavEnabled = input.caldavEnabled;
  if (input.embedding) {
    const e = input.embedding;
    if (typeof e.baseUrl === 'string') next.embedding.baseUrl = e.baseUrl.trim();
    if (typeof e.model === 'string' && e.model.trim()) next.embedding.model = e.model.trim();
    if (typeof e.dimension === 'number' && e.dimension > 0) next.embedding.dimension = Math.round(e.dimension);
    if (e.apiKey !== undefined) {
      next.embedding.apiKeyEncrypted = e.apiKey === '' ? null : encryptSecret(e.apiKey);
    }
  }
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_at) VALUES (${KEY}, ${JSON.stringify(next)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
  return getAppPreferences();
}

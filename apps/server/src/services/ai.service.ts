import { and, eq } from 'drizzle-orm';
import { env } from '../env';
import { db } from '../db/client';
import { spaces, workspaces, aiConfigs } from '@zhipane/db';
import { decryptSecret } from '../utils/crypto';

// Re-export everything from the shared AI package so existing imports
// (`MockAiProvider`, `AiProvider`, `AiMessage`, `vectorToSqlLiteral`,
// `deterministicVector`) keep working inside the server.
export * from '@zhipane/ai';
import { MockAiProvider, OpenAICompatibleProvider, type AiProvider } from '@zhipane/ai';

export type AiPrivacyPolicy = 'cloud_allowed' | 'local_only' | 'disabled';

export interface ResolvedAiRuntime {
  /** Effective policy after resolving inherit_workspace -> workspace -> instance. */
  policy: AiPrivacyPolicy;
  embeddingDimension: number;
  driver: string;
  baseUrl: string;
  apiKey: string;
  completionModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
}

export interface AiContext {
  workspaceId?: string;
  spaceId?: string;
  userId?: string;
}

/**
 * Resolve the effective AI runtime configuration for a (workspace, space, user)
 * triple. Resolution priority (per AGENTS.md):
 *
 *   User override > Space override > Workspace default > Instance default
 *
 * The returned `policy` is one of:
 *   - `cloud_allowed`: real provider may be used.
 *   - `local_only`: LLM and Embedding MUST stay local (MockAiProvider, no network).
 *   - `disabled`: no AI / Embedding / RAG / Wiki job may run at all.
 */
export async function resolveWorkspaceRuntimeConfig(ctx: AiContext): Promise<ResolvedAiRuntime> {
  // Instance defaults (from env).
  let policy: 'inherit_workspace' | AiPrivacyPolicy = 'cloud_allowed';
  let embeddingDimension = env.EMBEDDING_DIMENSION;
  let driver: string = env.AI_DRIVER;
  let baseUrl = env.OPENAI_API_URL;
  let apiKey = env.OPENAI_API_KEY ?? '';
  let completionModel = env.AI_COMPLETION_MODEL;
  let embeddingBaseUrl = env.EMBEDDING_BASE_URL || env.OPENAI_API_URL;
  let embeddingApiKey = env.EMBEDDING_API_KEY || env.OPENAI_API_KEY || '';
  let embeddingModel = env.AI_EMBEDDING_MODEL;

  // Workspace default: pull embedding dimension/model if configured.
  // Lookups are defensive: an unresolvable / invalid id simply falls
  // through to the instance defaults rather than throwing.
  if (ctx.workspaceId) {
    try {
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
      if (ws) {
        embeddingDimension = ws.embeddingDimension || embeddingDimension;
        embeddingModel = ws.embeddingModel || embeddingModel;
      }
    } catch {
      /* invalid / unresolvable id -> keep defaults */
    }
  }

  // Space override (explicit policy only; inherit falls through to instance default).
  if (ctx.spaceId) {
    try {
      const [sp] = await db.select().from(spaces).where(eq(spaces.id, ctx.spaceId)).limit(1);
      if (sp && sp.aiPrivacyPolicy && sp.aiPrivacyPolicy !== 'inherit_workspace') {
        policy = sp.aiPrivacyPolicy as AiPrivacyPolicy;
      }
    } catch {
      /* invalid / unresolvable id -> keep defaults */
    }
  }

  // User override (personal API key / driver via ai_configs).
  if (ctx.userId) {
    try {
      const [cfg] = await db
        .select()
        .from(aiConfigs)
        .where(
          and(
            eq(aiConfigs.scope, 'user'),
            eq(aiConfigs.userId, ctx.userId),
            eq(aiConfigs.personalOverrideEnabled, true)
          )
        )
        .limit(1);
      if (cfg) {
        if (cfg.driver) driver = cfg.driver;
        if (cfg.baseUrl) baseUrl = cfg.baseUrl;
        if (cfg.encryptedApiKey) {
          try { apiKey = decryptSecret(cfg.encryptedApiKey); } catch { apiKey = ''; }
        }
        if (cfg.completionModel) completionModel = cfg.completionModel;
        // ai_configs shares baseUrl / encryptedApiKey for both chat and embedding.
        if (cfg.baseUrl) embeddingBaseUrl = cfg.baseUrl;
        if (cfg.encryptedApiKey) {
          try { embeddingApiKey = decryptSecret(cfg.encryptedApiKey); } catch { embeddingApiKey = ''; }
        }
        if (cfg.embeddingModel) embeddingModel = cfg.embeddingModel;
        if (cfg.embeddingDimension) embeddingDimension = cfg.embeddingDimension;
      }
    } catch {
      /* invalid / unresolvable id -> keep defaults */
    }
  }

  return {
    policy,
    embeddingDimension,
    driver,
    baseUrl,
    apiKey,
    completionModel,
    embeddingBaseUrl,
    embeddingApiKey,
    embeddingModel
  };
}

/** Returns the effective AI policy for a space (resolves `inherit_workspace`). */
export async function getSpacePolicy(spaceId: string): Promise<AiPrivacyPolicy> {
  const [sp] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!sp || !sp.aiPrivacyPolicy || sp.aiPrivacyPolicy === 'inherit_workspace') {
    return 'cloud_allowed';
  }
  return sp.aiPrivacyPolicy as AiPrivacyPolicy;
}

const DISABLED_ERROR = 'AI_DISABLED: space AI is disabled';
export function isAiDisabledError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(DISABLED_ERROR);
}

function buildProvider(cfg: ResolvedAiRuntime): AiProvider {
  // Tests and local dev never touch the network.
  if (process.env.NODE_ENV === 'test') return new MockAiProvider(cfg.embeddingDimension);
  if (cfg.driver === 'mock') return new MockAiProvider(cfg.embeddingDimension);

  const resolvedEmbeddingBaseUrl = cfg.embeddingBaseUrl || cfg.baseUrl;
  const resolvedEmbeddingApiKey = cfg.embeddingApiKey || cfg.apiKey;
  if (!cfg.apiKey || !resolvedEmbeddingApiKey) {
    // No credentials: fall back to the deterministic local provider rather
    // than throwing mid-pipeline.
    return new MockAiProvider(cfg.embeddingDimension);
  }
  return new OpenAICompatibleProvider({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    completionModel: cfg.completionModel,
    embeddingBaseUrl: resolvedEmbeddingBaseUrl,
    embeddingApiKey: resolvedEmbeddingApiKey,
    embeddingModel: cfg.embeddingModel,
    embeddingDimension: cfg.embeddingDimension
  });
}

/**
 * Factory that returns the active AI provider based on the runtime environment.
 * Tests and local development use the deterministic MockAiProvider. When
 * `AI_DRIVER` is `openai` / `openai-compatible` and credentials are present,
 * it talks to the configured OpenAI-compatible Chat + Embeddings endpoints.
 *
 * Per project constraint, all automated tests MUST use the mock provider - do
 * not call real LLMs from tests. We also force the mock whenever
 * `NODE_ENV === 'test'` so the test suite never reaches the network.
 */
export function createAiProvider(): AiProvider {
  return buildProvider({
    policy: 'cloud_allowed',
    embeddingDimension: env.EMBEDDING_DIMENSION,
    driver: env.AI_DRIVER,
    baseUrl: env.OPENAI_API_URL,
    apiKey: env.OPENAI_API_KEY ?? '',
    completionModel: env.AI_COMPLETION_MODEL,
    embeddingBaseUrl: env.EMBEDDING_BASE_URL || env.OPENAI_API_URL,
    embeddingApiKey: env.EMBEDDING_API_KEY || env.OPENAI_API_KEY || '',
    embeddingModel: env.AI_EMBEDDING_MODEL
  });
}

/**
 * Context-aware provider factory. Every LLM / Embedding / RAG / Wiki call must
 * go through this so the Space privacy policy is always honoured:
 *
 *  - `disabled`  -> throws (callers must skip AI entirely).
 *  - `local_only` -> MockAiProvider (no cloud access for LLM or Embedding).
 *  - `cloud_allowed` -> real provider (mock under NODE_ENV=test).
 */
export async function createAiProviderForContext(ctx: AiContext): Promise<AiProvider> {
  const cfg = await resolveWorkspaceRuntimeConfig(ctx);
  if (cfg.policy === 'disabled') {
    throw new Error(DISABLED_ERROR);
  }
  if (cfg.policy === 'local_only') {
    // Never touch the public network; use the deterministic local provider.
    return new MockAiProvider(cfg.embeddingDimension);
  }
  return buildProvider(cfg);
}

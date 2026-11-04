import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { db } from '../db/client';
import { aiConfigs } from '@zhipane/db';
import { saveAiConfigSchema } from '@zhipane/shared';
import { encryptSecret, decryptSecret, maskSecret } from '../utils/crypto';

export const settingsRoutes = new Hono<AppEnv>();
settingsRoutes.use('*', authMiddleware);

// Phase G (S1): user-level AI provider override. The client sends the API key
// in plaintext (over HTTPS in prod); the server encrypts it before persisting
// and NEVER returns plaintext or ciphertext — only a masked preview.

// GET: return the caller's personal AI override (API key masked).
settingsRoutes.get('/ai-config', async (c) => {
  const user = c.get('user');
  const [cfg] = await db
    .select()
    .from(aiConfigs)
    .where(and(eq(aiConfigs.scope, 'user'), eq(aiConfigs.userId, user.id)))
    .limit(1);
  if (!cfg) return c.json({ config: null });
  // Decrypt best-effort: legacy plaintext or tampered rows degrade to '' (treated as unset),
  // so a corrupt row never leaks raw bytes and the user is prompted to reconfigure.
  let apiKeyMasked = '';
  if (cfg.encryptedApiKey) {
    try {
      apiKeyMasked = maskSecret(decryptSecret(cfg.encryptedApiKey));
    } catch {
      apiKeyMasked = '';
    }
  }
  return c.json({
    config: {
      driver: cfg.driver,
      baseUrl: cfg.baseUrl ?? '',
      apiKeyMasked,
      hasApiKey: !!cfg.encryptedApiKey,
      completionModel: cfg.completionModel,
      embeddingModel: cfg.embeddingModel,
      embeddingDimension: cfg.embeddingDimension,
      personalOverrideEnabled: cfg.personalOverrideEnabled
    }
  });
});

// PUT: upsert the caller's personal AI override. The API key is encrypted
// before persisting. Sending apiKey === '' clears it; omitting apiKey keeps
// the stored value (so other fields can be edited without re-entering the key).
settingsRoutes.put('/ai-config', async (c) => {
  const user = c.get('user');
  let body;
  try {
    body = saveAiConfigSchema.parse(await c.req.json());
  } catch (e) {
    return c.json({ error: 'Invalid input', details: (e as Error).message }, 400);
  }

  // user-scope rows have workspaceId = NULL. Postgres unique indexes do not
  // dedup NULL tuples, so onConflictDoUpdate cannot target (scope, workspaceId,
  // userId). Use select-then-update-or-insert (low-frequency personal setting).
  const [existing] = await db
    .select()
    .from(aiConfigs)
    .where(and(eq(aiConfigs.scope, 'user'), eq(aiConfigs.userId, user.id)))
    .limit(1);

  // Resolve the persisted ciphertext:
  //  - non-empty apiKey -> (re)encrypt
  //  - apiKey === ''    -> clear (null)
  //  - apiKey undefined -> keep existing ciphertext
  let encryptedApiKey: string | null;
  if (body.apiKey && body.apiKey.length > 0) encryptedApiKey = encryptSecret(body.apiKey);
  else if (body.apiKey === '') encryptedApiKey = null;
  else encryptedApiKey = existing?.encryptedApiKey ?? null;

  const values = {
    scope: 'user' as const,
    userId: user.id,
    workspaceId: null,
    driver: body.driver,
    baseUrl: body.baseUrl || null,
    completionModel: body.completionModel,
    embeddingModel: body.embeddingModel,
    embeddingDimension: body.embeddingDimension,
    encryptedApiKey,
    personalOverrideEnabled: body.personalOverrideEnabled
  };

  if (existing) {
    await db.update(aiConfigs).set({ ...values, updatedAt: new Date() }).where(eq(aiConfigs.id, existing.id));
  } else {
    await db.insert(aiConfigs).values(values);
  }
  return c.json({ ok: true });
});

// Instance-level app settings (e.g. the hour of the nightly auto-organize run).
settingsRoutes.get('/app', async (c) => {
  const res = await db.execute<{ value: { hour?: unknown } | null }>(
    sql`SELECT value FROM app_settings WHERE key = 'auto_organize' LIMIT 1`
  );
  const raw = res.rows[0]?.value;
  const hour = raw && typeof raw === 'object' && 'hour' in raw ? Number((raw as { hour: unknown }).hour) : 3;
  return c.json({ hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3 });
});

settingsRoutes.put('/app', async (c) => {
  let body: { hour?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const hour = Number(body?.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return c.json({ error: 'hour must be an integer between 0 and 23' }, 400);
  }
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('auto_organize', ${JSON.stringify({ hour })}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify({ hour })}::jsonb, updated_at = now()
  `);
  return c.json({ ok: true, hour });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { makeApp, makeUser, sessionCookie, cleanDb, db } from './test-utils';
import { aiConfigs } from '@zhipane/db';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '../utils/crypto';

// Phase G (S1): the AI key encryption link must be wired end-to-end.
// These tests assert: PUT encrypts before persisting, GET never leaks
// plaintext or ciphertext, omitting apiKey preserves the stored key, and
// the persisted ciphertext round-trips to the original plaintext.
describe('settings/ai-config (Phase G S1)', () => {
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    await cleanDb();
    const user = await makeUser('aiconfig@example.com', 'cfg');
    userId = user.id;
    cookie = await sessionCookie(user);
  });

  it('PUT encrypts the API key; GET never returns plaintext or ciphertext', async () => {
    const app = makeApp();
    const put = await app.request('/api/settings/ai-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        driver: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-secret-1234567890',
        completionModel: 'deepseek-chat',
        embeddingModel: 'text-embedding-3-small',
        embeddingDimension: 1536,
        personalOverrideEnabled: true
      })
    });
    expect(put.status).toBe(200);

    // The persisted row must hold an encrypted value, never the plaintext.
    const [row] = await db.select().from(aiConfigs).where(eq(aiConfigs.userId, userId)).limit(1);
    expect(row).toBeDefined();
    expect(row.encryptedApiKey).toBeTruthy();
    expect(row.encryptedApiKey).not.toContain('sk-secret');
    // And the ciphertext must round-trip back to the original plaintext.
    expect(decryptSecret(row.encryptedApiKey!)).toBe('sk-secret-1234567890');

    // GET returns a masked preview and no raw bytes anywhere in the payload.
    const get = await app.request('/api/settings/ai-config', { headers: { Cookie: cookie } });
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.config.hasApiKey).toBe(true);
    expect(body.config.apiKeyMasked).not.toContain('sk-secret');
    expect(JSON.stringify(body)).not.toContain('sk-secret-1234567890');
  });

  it('omitting apiKey on PUT keeps the stored key; sending "" clears it', async () => {
    const app = makeApp();
    // seed a key
    await app.request('/api/settings/ai-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        driver: 'openai',
        apiKey: 'sk-keep-me-12345',
        completionModel: 'gpt-4o-mini',
        embeddingModel: 'text-embedding-3-small',
        embeddingDimension: 1536,
        personalOverrideEnabled: true
      })
    });
    // update a different field without apiKey -> key preserved
    await app.request('/api/settings/ai-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        driver: 'openai',
        completionModel: 'gpt-4o',
        embeddingModel: 'text-embedding-3-small',
        embeddingDimension: 1536,
        personalOverrideEnabled: true
      })
    });
    const get1 = await (await app.request('/api/settings/ai-config', { headers: { Cookie: cookie } })).json();
    expect(get1.config.hasApiKey).toBe(true);
    expect(get1.config.completionModel).toBe('gpt-4o');

    // now explicitly clear
    await app.request('/api/settings/ai-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        driver: 'openai',
        apiKey: '',
        completionModel: 'gpt-4o',
        embeddingModel: 'text-embedding-3-small',
        embeddingDimension: 1536,
        personalOverrideEnabled: true
      })
    });
    const get2 = await (await app.request('/api/settings/ai-config', { headers: { Cookie: cookie } })).json();
    expect(get2.config.hasApiKey).toBe(false);
  });

  it('rejects unauthenticated requests', async () => {
    const app = makeApp();
    const get = await app.request('/api/settings/ai-config');
    expect(get.status).toBe(401);
    const put = await app.request('/api/settings/ai-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    expect(put.status).toBe(401);
  });
});

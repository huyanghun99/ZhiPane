import { describe, expect, it } from 'vitest';
import { createApp } from '../app';

describe('server app smoke', () => {
  it('creates a Hono app with routes registered', () => {
    const app = createApp();
    expect(app).toBeDefined();
  });

  it('returns 404 for unknown routes', async () => {
    const app = createApp();
    const res = await app.request('/api/nonexistent-endpoint');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found');
  });
});

describe('M1 workspace/space/page extension routes auth', () => {
  it('rejects workspace GET by id without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/workspaces/abc');
    expect(res.status).toBe(401);
  });

  it('rejects workspace PATCH without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/workspaces/abc', { method: 'PATCH', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects space PATCH without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/spaces/abc', { method: 'PATCH', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects space DELETE without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/spaces/abc', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('rejects page DELETE without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/pages/abc', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('rejects page revisions GET without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/pages/abc/revisions');
    expect(res.status).toBe(401);
  });

  it('rejects page restore-revision POST without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/pages/abc/restore-revision', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects page tree GET without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/pages/tree');
    expect(res.status).toBe(401);
  });
});

describe('M1 group routes auth', () => {
  it('rejects group list without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/groups?workspaceId=abc');
    expect(res.status).toBe(401);
  });

  it('rejects group create without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/groups', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects group PATCH without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/groups/abc', { method: 'PATCH', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects group DELETE without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/groups/abc', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});

describe('M2B attachment routes auth', () => {
  it('rejects attachment list without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/attachments');
    expect(res.status).toBe(401);
  });

  it('rejects attachment download without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/attachments/abc/download');
    expect(res.status).toBe(401);
  });

  it('rejects attachment delete without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/attachments/abc', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});

describe('M4 RAG session routes auth', () => {
  it('rejects RAG sessions list without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/rag/sessions');
    expect(res.status).toBe(401);
  });

  it('rejects RAG session get without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/rag/sessions/abc');
    expect(res.status).toBe(401);
  });
});

describe('M5 LLM Wiki routes auth', () => {
  it('rejects inbox without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/inbox');
    expect(res.status).toBe(401);
  });

  it('rejects process-now without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/pages/abc/process-now', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects space pause without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/spaces/abc/pause', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects space resume without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/spaces/abc/resume', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects topics list without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/topics');
    expect(res.status).toBe(401);
  });

  it('rejects topic create without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/topics', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects topic accept without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/topics/abc/accept', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects suggestion accept without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/suggestions/abc/accept', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects suggestion ignore without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/suggestions/abc/ignore', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('M6 graph routes auth', () => {
  it('rejects around-page without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/graph/around-page/abc');
    expect(res.status).toBe(401);
  });

  it('rejects around-topic without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/graph/around-topic/abc');
    expect(res.status).toBe(401);
  });

  it('rejects around-entity without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/graph/around-entity/abc?workspaceId=w&spaceId=s');
    expect(res.status).toBe(401);
  });

  it('rejects space graph without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/graph/space/abc');
    expect(res.status).toBe(401);
  });

  it('rejects edge evidence without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/graph/edges/abc/evidence');
    expect(res.status).toBe(401);
  });

  it('rejects edge accept without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/graph/edges/abc/accept', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects edge reject without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/graph/edges/abc/reject', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects edge PATCH without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/graph/edges/abc', { method: 'PATCH', body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('M7 shares routes auth', () => {
  it('rejects share create without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/shares', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects share list without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/shares?targetType=page&targetId=abc');
    expect(res.status).toBe(401);
  });

  it('rejects share delete without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/shares/abc', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('rejects share regenerate-token without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/shares/abc/regenerate-token', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('public share endpoint does not require auth (no 401)', async () => {
    const app = createApp();
    const res = await app.request('/api/public/shares/nonexistent-token');
    expect(res.status).not.toBe(401);
  });
});

describe('M7 import/export routes auth', () => {
  it('rejects page export without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/io/export/page/abc', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects space export without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/io/export/space/abc', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects markdown import without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/io/import/markdown', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('M8 backup routes auth', () => {
  it('rejects backup create without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/backups?workspaceId=abc', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects backup list without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/backups');
    expect(res.status).toBe(401);
  });

  it('rejects backup get without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/backups/abc');
    expect(res.status).toBe(401);
  });

  it('rejects backup download without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/backups/abc/download');
    expect(res.status).toBe(401);
  });

  it('rejects backup restore without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/backups/restore', { method: 'POST', body: '{"backupId":"00000000-0000-0000-0000-000000000000"}' });
    expect(res.status).toBe(401);
  });
});

describe('spec §22 API completeness auth guards', () => {
  it('rejects auth logout without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects search hybrid without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/search/hybrid', { method: 'POST', body: '{"query":"x","workspaceId":"x","limit":5}' });
    expect(res.status).toBe(401);
  });

  it('rejects topic refresh-suggestions without auth', async () => {
    const app = createApp();
    const res = await app.request('/api/llm-wiki/topics/abc/refresh-suggestions', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

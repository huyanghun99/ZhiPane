import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { searchSchema } from '@zhipane/shared';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { hybridSearch } from '../services/search.service';

export const searchRoutes = new Hono<AppEnv>();
searchRoutes.use('*', authMiddleware);

searchRoutes.post('/', zValidator('json', searchSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  const results = await hybridSearch({ userId: user.id, ...input });
  return c.json({ results });
});

// Alias kept for spec §22.5 (POST /api/search/hybrid). Same hybrid behavior.
searchRoutes.post('/hybrid', zValidator('json', searchSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  const results = await hybridSearch({ userId: user.id, ...input });
  return c.json({ results });
});


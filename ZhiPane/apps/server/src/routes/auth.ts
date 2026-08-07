import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { loginSchema, registerSchema } from '@zhipane/shared';
import { db } from '../db/client';
import { users } from '@zhipane/db';
import { env } from '../env';
import { hashPassword, verifyPassword } from '../utils/password';
import {
  createSession,
  setSessionCookie,
  authMiddleware,
  listSessions,
  revokeSessionById,
  revokeAllSessions,
  type AppEnv
} from '../middleware/auth';
import { provisionDefaultWorkspace } from '../services/provision.service';

export const authRoutes = new Hono<AppEnv>();

function userAgent(c: Parameters<typeof setCookie>[0]): string | null {
  return c.req.header('user-agent') ?? null;
}
function clientIp(c: Parameters<typeof setCookie>[0]): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
}

authRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const input = c.req.valid('json');
  const count = await db.execute<{ count: string }>(sql`SELECT COUNT(*)::text FROM users`);
  const isFirst = Number(count.rows[0]?.count ?? 0) === 0;
  if (!isFirst && !env.ALLOW_SIGNUP) return c.json({ error: 'Signup is disabled' }, 403);
  const passwordHash = await hashPassword(input.password);
  const [user] = await db.insert(users).values({
    email: input.email.toLowerCase(),
    name: input.name,
    passwordHash,
    isInstanceOwner: isFirst
  }).returning();

  // Auto-provision a default workspace + space + welcome page so the user
  // can start using ZhiPane immediately after registration without having
  // to manually create scaffolding first.
  await provisionDefaultWorkspace(user.id, user.name);

  const token = await createSession(user.id, userAgent(c), clientIp(c));
  setSessionCookie(c, token);
  return c.json({ user: { id: user.id, email: user.email, name: user.name, isInstanceOwner: user.isInstanceOwner } });
});

authRoutes.post('/login', zValidator('json', loginSchema), async (c) => {
  const input = c.req.valid('json');
  const [user] = await db.select().from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
  if (!user || !(await verifyPassword(user.passwordHash, input.password))) return c.json({ error: 'Invalid email or password' }, 401);
  const token = await createSession(user.id, userAgent(c), clientIp(c));
  setSessionCookie(c, token);
  return c.json({ user: { id: user.id, email: user.email, name: user.name, isInstanceOwner: user.isInstanceOwner } });
});

authRoutes.get('/me', authMiddleware, async (c) => c.json({ user: c.get('user') }));

authRoutes.post('/logout', authMiddleware, async (c) => {
  const sessionId = c.get('sessionId');
  if (sessionId) await revokeSessionById(sessionId, c.get('user').id).catch(() => {});
  setCookie(c, 'zhipane_session', '', { httpOnly: true, sameSite: 'Lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: 0 });
  return c.json({ ok: true });
});

/* ------------------------------------------- session management ----------- */

authRoutes.get('/sessions', authMiddleware, async (c) => {
  const rows = await listSessions(c.get('user').id);
  return c.json({ sessions: rows });
});

authRoutes.post('/sessions/revoke-current', authMiddleware, async (c) => {
  const sessionId = c.get('sessionId');
  if (sessionId) await revokeSessionById(sessionId, c.get('user').id);
  setCookie(c, 'zhipane_session', '', { httpOnly: true, sameSite: 'Lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: 0 });
  return c.json({ ok: true });
});

authRoutes.post('/sessions/revoke-all', authMiddleware, async (c) => {
  await revokeAllSessions(c.get('user').id);
  setCookie(c, 'zhipane_session', '', { httpOnly: true, sameSite: 'Lax', secure: env.NODE_ENV === 'production', path: '/', maxAge: 0 });
  return c.json({ ok: true });
});

authRoutes.post('/sessions/:id/revoke', authMiddleware, async (c) => {
  const id = c.req.param('id');
  await revokeSessionById(id, c.get('user').id);
  return c.json({ ok: true });
});

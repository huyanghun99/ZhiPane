import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie } from 'hono/cookie';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { users, sessions } from '@zhipane/db';
import { env } from '../env';

const SESSION_TTL_DAYS = 14;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isInstanceOwner: boolean;
}

/** Hono env bound to every route that runs after authMiddleware. */
export type AppEnv = {
  Variables: {
    user: SessionUser;
    /** Opaque session row id (set by authMiddleware). */
    sessionId?: string;
  };
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Create a persisted session for `userId` and return the opaque bearer token.
 * Only the SHA-256 hash is stored; the raw token lives only in the user's
 * cookie, so a DB leak cannot be used to impersonate a user.
 */
export async function createSession(
  userId: string,
  userAgent?: string | null,
  ipAddress?: string | null
): Promise<string> {
  const token = generateSessionToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await db.insert(sessions).values({
    userId,
    tokenHash,
    userAgent: userAgent ?? null,
    ipAddress: ipAddress ?? null,
    expiresAt
  });
  return token;
}

export async function getSessionUserByToken(
  token: string | undefined
): Promise<{ user: SessionUser; sessionId: string } | null> {
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const [sess] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`
      )
    )
    .limit(1);
  if (!sess) return null;
  const [user] = await db.select().from(users).where(eq(users.id, sess.userId)).limit(1);
  if (!user) return null;
  // Phase K (S9): sliding session renewal. Update lastUsedAt on every request,
  // and if less than 1/3 of the TTL remains, extend expiresAt by a full TTL
  // (capped at 30 days from now) so active users are not kicked out. Idle
  // sessions still expire on schedule because they never trigger this path.
  const now = Date.now();
  const ttlMs = SESSION_TTL_DAYS * 86_400_000;
  const remainingMs = sess.expiresAt.getTime() - now;
  const shouldRenew = remainingMs < ttlMs / 3;
  const newExpiresAt = shouldRenew ? new Date(Math.min(now + ttlMs, now + 30 * 86_400_000)) : null;
  await db.update(sessions)
    .set({ lastUsedAt: new Date(now), ...(newExpiresAt ? { expiresAt: newExpiresAt } : {}) })
    .where(eq(sessions.id, sess.id))
    .catch(() => {});
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isInstanceOwner: user.isInstanceOwner
    },
    sessionId: sess.id
  };
}

export async function revokeSessionById(sessionId: string, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const conditions = [eq(sessions.userId, userId)];
  if (exceptSessionId) {
    conditions.push(sql`${sessions.id} <> ${exceptSessionId}` as any);
  }
  const res = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions));
  return (res as any).rowCount ?? 0;
}

export async function listSessions(userId: string) {
  return db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      ipAddress: sessions.ipAddress,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .orderBy(sql`${sessions.lastUsedAt} DESC`);
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const token =
    getCookie(c, 'zhipane_session') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const sess = await getSessionUserByToken(token);
  if (!sess) return c.json({ error: 'Unauthorized' }, 401);
  c.set('user', sess.user);
  c.set('sessionId', sess.sessionId);
  await next();
});

export function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, 'zhipane_session', token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * SESSION_TTL_DAYS
  });
}

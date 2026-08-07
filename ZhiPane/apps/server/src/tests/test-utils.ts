import { createApp } from '../app';
import { db, pool } from '../db/client';
import { users, workspaces, workspaceMembers, spaces, spaceMembers } from '@zhipane/db';
import { createSession } from '../middleware/auth';
import { hashPassword } from '../utils/password';
import { runMigrations } from '../db/migrate';
import { sql } from 'drizzle-orm';

let migrated = false;
export async function ensureDb(): Promise<void> {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
}

/** Truncate every table (except the migration ledger) for test isolation. */
export async function cleanDb(): Promise<void> {
  await ensureDb();
  await pool.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations')
      LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
}

export function makeApp() {
  return createApp();
}

export async function makeUser(email = `u_${Math.random().toString(36).slice(2)}@example.com`, name = 'tester') {
  const passwordHash = await hashPassword('password123');
  const [u] = await db.insert(users).values({ email, name, passwordHash }).returning();
  return u;
}

export async function makeWorkspace(user: { id: string }, name = 'ws') {
  const [ws] = await db.insert(workspaces).values({ name }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: 'owner' });
  return ws;
}

export async function makeSpace(
  ws: { id: string },
  user: { id: string },
  name = 'sp',
  aiPrivacyPolicy: 'inherit_workspace' | 'cloud_allowed' | 'local_only' | 'disabled' = 'cloud_allowed'
) {
  const [sp] = await db.insert(spaces).values({ workspaceId: ws.id, name, aiPrivacyPolicy }).returning();
  await db.insert(spaceMembers).values({ spaceId: sp.id, userId: user.id, role: 'admin' });
  return sp;
}

export async function sessionCookie(user: { id: string }): Promise<string> {
  const token = await createSession(user.id, 'test-agent', '127.0.0.1');
  return `zhipane_session=${token}`;
}

export function cookieFromResponse(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

export async function runPendingJob(): Promise<boolean> {
  const { runOneJob } = await import('../services/job-runner');
  return runOneJob();
}

export { db, sql };

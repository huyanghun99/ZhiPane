import { Hono, type Context } from 'hono';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { isCaldavEnabled } from '../services/app-preferences';
import { resolveAgentToken } from '../middleware/agent-auth';
import type { AppEnv, SessionUser } from '../middleware/auth';
import {
  calendarFeed, parseVEvent, etagFor, rootProps,
  calendarsProps, calendarProps, reportResponse, resourceProps, extractTimeRange,
  type CalTask
} from '../services/caldav';

/**
 * CalDAV (RFC 4791) endpoint for the task calendar.
 *
 * Discovery: /caldav/ -> principal -> /caldav/calendars/ -> /caldav/calendars/<workspaceId>/
 * Reads: PROPFIND, REPORT calendar-query, GET feed.ics / <uid>.ics
 * Writes: PUT <uid>.ics (create/update task), DELETE <uid>.ics
 * Auth: Basic (password = Agent Token) or Bearer; scope calendar:read / calendar:write.
 */
export const caldavRoutes = new Hono<AppEnv>();

async function rows<T = Record<string, unknown>>(q: SQL): Promise<T[]> {
  const r = await db.execute(q) as unknown as { rows: T[] };
  return r.rows ?? [];
}

async function authenticate(c: Context<AppEnv>) {
  const header = c.req.header('authorization') ?? '';
  let token: string | undefined;
  if (/^Bearer\s+/i.test(header)) token = header.replace(/^Bearer\s+/i, '');
  else if (/^Basic\s+/i.test(header)) {
    try {
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      token = decoded.slice(decoded.indexOf(':') + 1);
    } catch { token = undefined; }
  }
  const agent = await resolveAgentToken(token);
  if (!agent) return null;
  c.set('user', agent.user as SessionUser);
  c.set('agentTokenId', agent.tokenId);
  c.set('agentScopes', agent.scopes);
  c.set('agentWorkspaceId', agent.workspaceId);
  return agent;
}

caldavRoutes.use('*', async (c, next) => {
  if (!(await isCaldavEnabled())) return c.text('CalDAV disabled', 403);
  const agent = await authenticate(c);
  if (!agent) {
    c.header('WWW-Authenticate', 'Basic realm="ZhiPane CalDAV"');
    return c.text('Unauthorized', 401);
  }
  await next();
});

function scopeOk(c: Context<AppEnv>, scope: string) {
  const scopes = c.get('agentScopes');
  return !scopes || scopes.includes(scope);
}

const XML = 'application/xml; charset=utf-8';
const ICS = 'text/calendar; charset=utf-8';
function xmlResponse(body: string) { return new Response(body, { status: 207, headers: { 'Content-Type': XML } }); }

caldavRoutes.on('OPTIONS', '*', (c) => {
  c.header('DAV', '1, 2, 3, calendar-access, calendar-auto-schedule');
  c.header('Allow', 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT');
  return c.body(null, 204);
});

/** Workspace list visible to this token. */
async function visibleWorkspaces(userId: string, bound: string | null) {
  return rows<{ id: string; name: string }>(sql`
    SELECT w.id, w.name FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ${userId}::uuid
      ${bound ? sql`AND w.id = ${bound}::uuid` : sql``}
    ORDER BY w.created_at
  `);
}

async function assertCalendar(c: Context<AppEnv>, ws: string) {
  const bound = c.get('agentWorkspaceId');
  if (bound && bound !== ws) throw new Error('Forbidden: token is bound to another workspace');
  const r = await rows(sql`SELECT 1 FROM workspaces WHERE id=${ws}::uuid LIMIT 1`);
  if (!r.length) throw new Error('Workspace not found');
}

function taskQuery(ws: string, from?: string, to?: string): SQL {
  return sql`
    SELECT id, title, notes, status, start_date, end_date, due_date, is_all_day,
           recurrence_unit, recurrence_interval, recurrence_end_date,
           estimated_duration, completed_at, updated_at, tags
    FROM tasks WHERE workspace_id = ${ws}::uuid
      ${from ? sql`AND COALESCE(end_date, start_date, due_date) >= ${from}::timestamptz` : sql``}
      ${to ? sql`AND COALESCE(start_date, due_date) <= ${to}::timestamptz` : sql``}
    ORDER BY COALESCE(start_date, due_date) NULLS LAST
  `;
}

// ---------------------------------------------------------------- discovery
caldavRoutes.on('PROPFIND', '/', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.text('Forbidden', 403);
  return xmlResponse(rootProps(c.get('user').id));
});
caldavRoutes.on('PROPFIND', '/principals/:uid/', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.text('Forbidden', 403);
  return xmlResponse(rootProps(c.get('user').id));
});
caldavRoutes.on('PROPFIND', '/calendars/', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.text('Forbidden', 403);
  const ws = await visibleWorkspaces(c.get('user').id, c.get('agentWorkspaceId') ?? null);
  return xmlResponse(calendarsProps(c.get('user').id, ws));
});
caldavRoutes.on('PROPFIND', '/calendars/:ws/', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.text('Forbidden', 403);
  const ws = c.req.param('ws');
  try { await assertCalendar(c, ws); } catch (e) { return c.text((e as Error).message, 403); }
  const r = await rows<{ name: string }>(sql`SELECT name FROM workspaces WHERE id=${ws}::uuid LIMIT 1`);
  return xmlResponse(calendarProps(`/caldav/calendars/${ws}/`, r[0]?.name ?? 'ZhiPane 日历'));
});

// ---------------------------------------------------------------- read
caldavRoutes.on('REPORT', '/calendars/:ws/', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.text('Forbidden', 403);
  const ws = c.req.param('ws');
  try { await assertCalendar(c, ws); } catch (e) { return c.text((e as Error).message, 403); }
  const body = await c.req.text().catch(() => '');
  const range = extractTimeRange(body);
  const tasks = await rows<CalTask>(taskQuery(ws, range.from, range.to));
  return xmlResponse(reportResponse(`/caldav/calendars/${ws}/`, tasks));
});

caldavRoutes.get('/calendars/:ws/feed.ics', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.text('Forbidden', 403);
  const ws = c.req.param('ws');
  try { await assertCalendar(c, ws); } catch (e) { return c.text((e as Error).message, 403); }
  const from = c.req.query('from') ?? new Date(Date.now() - 30 * 86400000).toISOString();
  const to = c.req.query('to') ?? new Date(Date.now() + 180 * 86400000).toISOString();
  const tasks = await rows<CalTask>(taskQuery(ws, from, to));
  c.header('Content-Type', ICS);
  c.header('Cache-Control', 'private, max-age=900');
  c.header('Content-Disposition', 'attachment; filename="zhipane-calendar.ics"');
  return c.body(calendarFeed(tasks));
});

async function findTask(ws: string, uid: string): Promise<CalTask | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(uid)
    ? await rows<CalTask>(sql`
        SELECT id, title, notes, status, start_date, end_date, due_date, is_all_day,
               recurrence_unit, recurrence_interval, recurrence_end_date,
               estimated_duration, completed_at, updated_at, tags
        FROM tasks WHERE id=${uid}::uuid AND workspace_id=${ws}::uuid LIMIT 1`)
    : [];
  if (byId[0]) return byId[0];
  const mapped = await rows<{ task_id: string }>(sql`
    SELECT task_id FROM calendar_sync_map WHERE uid=${uid} AND workspace_id=${ws}::uuid LIMIT 1
  `);
  if (!mapped[0]) return null;
  const r = await rows<CalTask>(sql`
    SELECT id, title, notes, status, start_date, end_date, due_date, is_all_day,
           recurrence_unit, recurrence_interval, recurrence_end_date,
           estimated_duration, completed_at, updated_at, tags
    FROM tasks WHERE id=${mapped[0].task_id}::uuid AND workspace_id=${ws}::uuid LIMIT 1
  `);
  const t = r[0];
  return t ? { ...t, cal_uid: uid } : null;
}

caldavRoutes.get('/calendars/:ws/:filename', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.text('Forbidden', 403);
  const ws = c.req.param('ws');
  const uid = c.req.param('filename').replace(/\.ics$/, '');
  const t = await findTask(ws, uid);
  if (!t) return c.text('Not Found', 404);
  c.header('Content-Type', ICS);
  c.header('ETag', etagFor(t));
  return c.body(calendarFeed([t]));
});

caldavRoutes.on('PROPFIND', '/calendars/:ws/:filename', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.text('Forbidden', 403);
  const ws = c.req.param('ws');
  const uid = c.req.param('filename').replace(/\.ics$/, '');
  const t = await findTask(ws, uid);
  if (!t) return c.text('Not Found', 404);
  return xmlResponse(resourceProps(`/caldav/calendars/${ws}/${uid}.ics`, t));
});

// ---------------------------------------------------------------- write
caldavRoutes.put('/calendars/:ws/:filename', async (c) => {
  if (!scopeOk(c, 'calendar:write')) return c.text('Forbidden', 403);
  const ws = c.req.param('ws');
  const uid = c.req.param('filename').replace(/\.ics$/, '');
  try { await assertCalendar(c, ws); } catch (e) { return c.text((e as Error).message, 403); }
  const ev = parseVEvent(await c.req.text().catch(() => ''));
  if (!ev) return c.text('Invalid VEVENT', 400);
  const existing = await findTask(ws, uid);
  const iso = (d: Date | null) => d ? d.toISOString() : null;
  let taskId: string;
  if (existing) {
    taskId = existing.id;
    await db.execute(sql`
      UPDATE tasks SET title=${ev.title}, notes=${ev.notes}, status=${ev.status},
        start_date=${iso(ev.startDate)}::timestamptz, end_date=${iso(ev.endDate)}::timestamptz,
        due_date=${iso(ev.dueDate)}::timestamptz, is_all_day=${ev.allDay},
        recurrence_unit=${ev.recurrenceUnit}, recurrence_interval=${ev.recurrenceInterval},
        recurrence_end_date=${iso(ev.recurrenceEndDate)}::timestamptz, updated_at=now()
      WHERE id=${existing.id}::uuid
    `);
  } else {
    const inserted = await rows<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, created_by_id, title, notes, status,
                         start_date, end_date, due_date, is_all_day,
                         recurrence_unit, recurrence_interval, recurrence_end_date)
      VALUES (${ws}::uuid, ${c.get('user').id}::uuid, ${ev.title}, ${ev.notes}, ${ev.status},
              ${iso(ev.startDate)}::timestamptz, ${iso(ev.endDate)}::timestamptz,
              ${iso(ev.dueDate)}::timestamptz, ${ev.allDay},
              ${ev.recurrenceUnit}, ${ev.recurrenceInterval}, ${iso(ev.recurrenceEndDate)}::timestamptz)
      RETURNING id
    `);
    taskId = inserted[0].id;
    await db.execute(sql`
      INSERT INTO calendar_sync_map (uid, task_id, workspace_id, etag)
      VALUES (${uid}, ${taskId}::uuid, ${ws}::uuid, '1')
      ON CONFLICT (uid) DO UPDATE SET task_id=EXCLUDED.task_id, updated_at=now()
    `);
  }
  const t = await findTask(ws, uid);
  c.header('ETag', t ? etagFor(t) : `"${taskId}"`);
  return c.body(null, existing ? 204 : 201);
});

caldavRoutes.delete('/calendars/:ws/:filename', async (c) => {
  if (!scopeOk(c, 'calendar:write')) return c.text('Forbidden', 403);
  const ws = c.req.param('ws');
  const uid = c.req.param('filename').replace(/\.ics$/, '');
  const t = await findTask(ws, uid);
  if (!t) return c.text('Not Found', 404);
  await db.execute(sql`DELETE FROM tasks WHERE id=${t.id}::uuid`);
  return c.body(null, 204);
});

// Hono mounts a sub-app's '/' route at '/caldav' (no trailing slash), while
// CalDAV clients normally discover '/caldav/'. Handle the trailing-slash form
// explicitly; specific routes above are registered first and keep priority.
caldavRoutes.on('PROPFIND', '*', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.text('Forbidden', 403);
  const path = new URL(c.req.url).pathname.replace(/\/$/, '');
  if (path !== '/caldav') return c.text('Not Found', 404);
  return xmlResponse(rootProps(c.get('user').id));
});

// Convenience: list calendars as JSON for the settings page.
caldavRoutes.get('/calendars', async (c) => {
  if (!scopeOk(c, 'calendar:read')) return c.json({ error: 'Forbidden' }, 403);
  const ws = await visibleWorkspaces(c.get('user').id, c.get('agentWorkspaceId') ?? null);
  return c.json({ calendars: ws.map((w) => ({ id: w.id, name: w.name, url: `/caldav/calendars/${w.id}/` })) });
});

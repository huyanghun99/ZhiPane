/** RFC 4791 / RFC 5545 helpers for the ZhiPane task calendar. No dependencies. */

export interface CalTask {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  due_date: string | null;
  is_all_day: boolean | null;
  recurrence_unit: string | null;
  recurrence_interval: number | null;
  recurrence_end_date: string | null;
  estimated_duration: number | null;
  completed_at: string | null;
  updated_at: string | null;
  tags: string[] | null;
  /** Client-supplied CalDAV UID, when it differs from the task id. */
  cal_uid?: string;
}

const CRLF = '\r\n';

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function fmt(d: string | Date | null, allDay: boolean): string {
  const date = d ? new Date(d) : new Date();
  if (Number.isNaN(date.getTime())) return fmt(new Date(), allDay);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const ymd = `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`;
  return allDay ? ymd : `${ymd}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

function parseIcsDate(raw: string | undefined): { date: Date | null; allDay: boolean } {
  if (!raw) return { date: null, allDay: false };
  const value = raw.split(':').pop() ?? '';
  const allDay = /;VALUE=DATE/i.test(raw) || /^\d{8}$/.test(value);
  if (allDay) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), allDay: true } : { date: null, allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/);
  if (!m) return { date: null, allDay: false };
  return {
    date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])),
    allDay: false
  };
}

const FREQ: Record<string, string> = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };

export function taskToVEvent(t: CalTask): string {
  const allDay = !!t.is_all_day;
  const start = t.start_date ?? t.due_date;
  const end = t.end_date ?? (start && t.estimated_duration
    ? new Date(new Date(start).getTime() + t.estimated_duration * 60000).toISOString()
    : null);
  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${t.cal_uid ?? t.id}@zhipane`,
    `DTSTAMP:${fmt(t.updated_at ?? new Date(), false)}`,
    `DTSTART${allDay ? ';VALUE=DATE' : ''}:${fmt(start ?? t.updated_at, allDay)}`,
    `DTEND${allDay ? ';VALUE=DATE' : ''}:${fmt(end ?? start ?? t.updated_at, allDay)}`,
    `SUMMARY:${esc(t.title || '未命名任务')}`,
    `DESCRIPTION:${esc(t.notes || '')}`
  ];
  if (t.tags?.length) lines.push(`CATEGORIES:${t.tags.map(esc).join(',')}`);
  if (t.status === 'done') lines.push('STATUS:COMPLETED', `COMPLETED:${fmt(t.completed_at ?? t.updated_at, false)}`);
  else lines.push('STATUS:CONFIRMED');
  if (t.recurrence_unit && FREQ[t.recurrence_unit]) {
    const rrule = [`FREQ=${FREQ[t.recurrence_unit]}`, `INTERVAL=${t.recurrence_interval || 1}`];
    if (t.recurrence_end_date) rrule.push(`UNTIL=${fmt(t.recurrence_end_date, false)}`);
    lines.push(`RRULE:${rrule.join(';')}`);
  }
  lines.push('END:VEVENT');
  return lines.join(CRLF);
}

export function calendarFeed(tasks: CalTask[]): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ZhiPane//Task Calendar//CN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...tasks.map(taskToVEvent), 'END:VCALENDAR', ''
  ].join(CRLF);
}

export interface ParsedEvent {
  uid: string;
  title: string;
  notes: string | null;
  startDate: Date | null;
  endDate: Date | null;
  dueDate: Date | null;
  allDay: boolean;
  status: string;
  recurrenceUnit: string | null;
  recurrenceInterval: number | null;
  recurrenceEndDate: Date | null;
}

const FREQ_UNIT: Record<string, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };

/** Minimal VEVENT parser for CalDAV PUT (unfolds lines, ignores VTODO/VJOURNAL). */
export function parseVEvent(ics: string): ParsedEvent | null {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const props: Record<string, string> = {};
  let inEvent = false;
  for (const line of lines) {
    if (line.trim().toUpperCase() === 'BEGIN:VEVENT') { inEvent = true; continue; }
    if (line.trim().toUpperCase() === 'END:VEVENT') break;
    if (!inEvent) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).toUpperCase();
    props[key] = line.slice(idx + 1);
  }
  if (!inEvent || !props['UID']) return null;
  const unesc = (s: string | undefined) =>
    (s ?? '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  const startKey = Object.keys(props).find((k) => k.startsWith('DTSTART')) ?? 'DTSTART';
  const endKey = Object.keys(props).find((k) => k.startsWith('DTEND')) ?? 'DTEND';
  const start = parseIcsDate(`${startKey}:${props[startKey] ?? ''}`);
  let recurrenceUnit: string | null = null;
  let recurrenceInterval: number | null = null;
  let recurrenceEndDate: Date | null = null;
  if (props['RRULE']) {
    const parts = props['RRULE'].split(';');
    for (const p of parts) {
      const [k, v] = p.split('=');
      if (k === 'FREQ' && FREQ_UNIT[v]) recurrenceUnit = FREQ_UNIT[v];
      if (k === 'INTERVAL' && Number(v) > 0) recurrenceInterval = Number(v);
      if (k === 'UNTIL') recurrenceEndDate = parseIcsDate(`UNTIL:${v}`).date;
    }
  }
  return {
    uid: props['UID'].replace(/@zhipane$/, ''),
    title: unesc(props['SUMMARY']) || '未命名任务',
    notes: props['DESCRIPTION'] ? unesc(props['DESCRIPTION']) : null,
    startDate: start.date,
    endDate: props[endKey] ? parseIcsDate(`${endKey}:${props[endKey]}`).date : null,
    dueDate: props['DUE'] ? parseIcsDate(`DUE:${props['DUE']}`).date : null,
    allDay: start.allDay,
    status: props['STATUS'] === 'COMPLETED' ? 'done' : 'inbox',
    recurrenceUnit, recurrenceInterval, recurrenceEndDate
  };
}

export function etagFor(t: CalTask): string {
  const stamp = t.updated_at ? new Date(t.updated_at).getTime() : 0;
  return `"${t.id}-${stamp}"`;
}

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';

export function multistatus(responses: string[]): string {
  return `${XML_HEAD}<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">${responses.join('')}</D:multistatus>`;
}

function propResponse(href: string, props: string): string {
  return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

export function rootProps(userId: string): string {
  return multistatus([
    propResponse('/caldav/', [
      '<D:resourcetype><D:collection/></D:resourcetype>',
      `<D:current-user-principal><D:href>/caldav/principals/${userId}/</D:href></D:current-user-principal>`,
      '<D:displayname>ZhiPane</D:displayname>'
    ].join('')),
    propResponse(`/caldav/principals/${userId}/`, [
      '<D:resourcetype><D:collection/><D:principal/></D:resourcetype>',
      '<C:calendar-home-set><D:href>/caldav/calendars/</D:href></C:calendar-home-set>',
      '<D:displayname>ZhiPane 账户</D:displayname>'
    ].join(''))
  ]);
}

export function calendarsProps(userId: string, calendars: Array<{ id: string; name: string }>): string {
  const self = propResponse('/caldav/calendars/', [
    '<D:resourcetype><D:collection/></D:resourcetype>',
    '<D:displayname>日历</D:displayname>'
  ].join(''));
  const children = calendars.map((cal) => propResponse(`/caldav/calendars/${cal.id}/`, [
    '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>',
    `<D:displayname>${xmlEscape(cal.name)}</D:displayname>`,
    '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>',
    '<CS:getctag>zhipane-1</CS:getctag>',
    '<D:sync-token>zhipane-1</D:sync-token>'
  ].join('')));
  void userId;
  return multistatus([self, ...children]);
}

export function calendarProps(href: string, name: string): string {
  return multistatus([
    propResponse(href, [
      '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>',
      `<D:displayname>${xmlEscape(name)}</D:displayname>`,
      '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>',
      '<CS:getctag>zhipane-1</CS:getctag>',
      '<D:sync-token>zhipane-1</D:sync-token>'
    ].join(''))
  ]);
}

export function reportResponse(hrefPrefix: string, tasks: CalTask[]): string {
  return multistatus(tasks.map((t) => propResponse(`${hrefPrefix}${t.id}.ics`, [
    `<D:getetag>${etagFor(t)}</D:getetag>`,
    `<C:calendar-data>${xmlEscape(calendarFeed([t]))}</C:calendar-data>`
  ].join(''))));
}

export function resourceProps(href: string, t: CalTask): string {
  return multistatus([
    propResponse(href, [
      `<D:getetag>${etagFor(t)}</D:getetag>`,
      '<D:resourcetype/>',
      `<C:calendar-data>${xmlEscape(calendarFeed([t]))}</C:calendar-data>`
    ].join(''))
  ]);
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Extract time-range from a REPORT calendar-query body (best effort, no XML lib). */
export function extractTimeRange(body: string): { from?: string; to?: string } {
  const start = body.match(/(?:[A-Za-z0-9]+:)?time-range[^>]*\bstart="([^"]+)"/i);
  const end = body.match(/(?:[A-Za-z0-9]+:)?time-range[^>]*\bend="([^"]+)"/i);
  const conv = (v?: string) => {
    if (!v) return undefined;
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : undefined;
  };
  return { from: conv(start?.[1]), to: conv(end?.[1]) };
}

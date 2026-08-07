/**
 * Minimal date helpers for the tasks module.
 *
 * ZenithFlow used date-fns, but the handful of functions the calendar and
 * gantt need are small enough to implement locally rather than adding a
 * dependency. Weeks start on Monday, matching the original UI.
 */

const MS_PER_DAY = 86_400_000;

export function startOfDay(date: Date | string | number): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date | string | number): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function addDays(date: Date | string | number, amount: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + amount);
  return d;
}

export function addMonths(date: Date | string | number, amount: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + amount);
  // Clamp to the last valid day (e.g. Jan 31 + 1 month -> Feb 28).
  d.setDate(Math.min(day, daysInMonth(d)));
  return d;
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/** Monday-based start of week. */
export function startOfWeek(date: Date | string | number): Date {
  const d = startOfDay(date);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d;
}

export function endOfWeek(date: Date | string | number): Date {
  return endOfDay(addDays(startOfWeek(date), 6));
}

export function startOfMonth(date: Date | string | number): Date {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

export function endOfMonth(date: Date | string | number): Date {
  const d = new Date(date);
  return endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function isSameDay(a: Date | string | number, b: Date | string | number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

export function isSameMonth(a: Date | string | number, b: Date | string | number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth();
}

/** Whole days between two dates, ignoring time-of-day. */
export function differenceInDays(a: Date | string | number, b: Date | string | number): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / MS_PER_DAY);
}

/** Every day in [start, end], inclusive. */
export function eachDayOfInterval(start: Date | string | number, end: Date | string | number): Date[] {
  const days: Date[] = [];
  let cur = startOfDay(start);
  const last = startOfDay(end);
  while (cur.getTime() <= last.getTime()) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

export function isBefore(a: Date | string | number, b: Date | string | number): boolean {
  return new Date(a).getTime() < new Date(b).getTime();
}

export function isAfter(a: Date | string | number, b: Date | string | number): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Format a date. Supports the subset of date-fns tokens the UI uses:
 * yyyy, MM, dd, d, HH, mm.
 */
export function format(date: Date | string | number, pattern: string): string {
  const d = new Date(date);
  return pattern
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/dd/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/\bd\b/g, String(d.getDate()));
}

/** `<input type="datetime-local">` value in local time. */
export function toLocalInputValue(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Serialise for the API, which expects ISO-8601 datetimes. */
export function toIso(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const WEEK_DAYS_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

import { describe, expect, it } from 'vitest';
import { GTD_COLUMNS, PRIORITY_META, type Task, type TaskStatus } from './api';
import {
  addMonths,
  differenceInDays,
  endOfDay,
  generateRecurrenceSeries,
  startOfWeek
} from './dateUtils';

/** Minimal task fixture; only the fields the recurrence builder reads matter. */
function makeParent(overrides: Partial<Task> = {}): Task {
  return {
    id: 'parent-1',
    title: '每日站会',
    notes: '同步进度',
    projectId: 'p1',
    context: '@office',
    startDate: new Date(2026, 0, 1, 9, 0).toISOString(),
    endDate: new Date(2026, 0, 1, 9, 30).toISOString(),
    estimatedDuration: 45,
    isAllDay: false,
    tags: ['team'],
    priority: 'high',
    status: 'inbox',
    ...overrides
  } as unknown as Task;
}

describe('generateRecurrenceSeries', () => {
  const start = new Date(2026, 0, 1, 9, 0);

  it('generates one instance per day and stops on the recurrence end date', () => {
    const series = generateRecurrenceSeries(makeParent(), 'day', start, new Date(2026, 0, 5, 23, 59));
    expect(series).toHaveLength(4);
    const dates = series.map((s) => new Date(s.startDate!));
    expect(dates.map((d) => d.getDate())).toEqual([2, 3, 4, 5]);
  });

  it('steps by week / month / year', () => {
    const weekly = generateRecurrenceSeries(makeParent(), 'week', start, new Date(2026, 0, 31));
    expect(weekly.map((s) => new Date(s.startDate!).getDate())).toEqual([8, 15, 22, 29]);

    const monthly = generateRecurrenceSeries(makeParent(), 'month', start, new Date(2026, 4, 31));
    expect(monthly.map((s) => new Date(s.startDate!).getMonth())).toEqual([1, 2, 3, 4]);

    const yearly = generateRecurrenceSeries(makeParent(), 'year', start, new Date(2028, 11, 31));
    expect(yearly.map((s) => new Date(s.startDate!).getFullYear())).toEqual([2027, 2028]);
  });

  it('caps the series at 100 instances even for a distant end date', () => {
    const series = generateRecurrenceSeries(makeParent(), 'day', start, new Date(2030, 0, 1));
    expect(series).toHaveLength(100);
  });

  it('returns nothing when the recurrence end date precedes the start', () => {
    expect(generateRecurrenceSeries(makeParent(), 'day', start, new Date(2025, 11, 31))).toHaveLength(0);
  });

  it('returns nothing for an unrecognised unit instead of looping forever', () => {
    expect(generateRecurrenceSeries(makeParent(), 'hour' as never, start, new Date(2030, 0, 1))).toHaveLength(0);
  });

  it('copies parent fields and clears recurrence flags on children', () => {
    const [child] = generateRecurrenceSeries(makeParent(), 'day', start, new Date(2026, 0, 3));
    expect(child).toMatchObject({
      title: '每日站会',
      notes: '同步进度',
      projectId: 'p1',
      context: '@office',
      status: 'scheduled',
      isAllDay: false,
      tags: ['team'],
      priority: 'high',
      parentTaskId: 'parent-1',
      recurrenceUnit: null,
      recurrenceInterval: null,
      recurrenceEndDate: null
    });
  });

  it('uses the parent start/end span as the child duration when available', () => {
    const [child] = generateRecurrenceSeries(makeParent(), 'day', start, new Date(2026, 0, 3));
    expect(new Date(child.endDate!).getTime() - new Date(child.startDate!).getTime()).toBe(30 * 60 * 1000);
  });

  it('falls back to estimatedDuration, then 30 minutes, when the parent has no dates', () => {
    const noDates = makeParent({ startDate: null, endDate: null });
    const [estimated] = generateRecurrenceSeries(noDates, 'day', start, new Date(2026, 0, 3));
    expect(new Date(estimated.endDate!).getTime() - new Date(estimated.startDate!).getTime()).toBe(45 * 60 * 1000);

    const noEstimate = makeParent({ startDate: null, endDate: null, estimatedDuration: 0 });
    const [defaulted] = generateRecurrenceSeries(noEstimate, 'day', start, new Date(2026, 0, 3));
    expect(new Date(defaulted.endDate!).getTime() - new Date(defaulted.startDate!).getTime()).toBe(30 * 60 * 1000);
  });

  it('normalises a missing tags array to []', () => {
    const [child] = generateRecurrenceSeries(
      makeParent({ tags: undefined }), 'day', start, new Date(2026, 0, 3)
    );
    expect(child.tags).toEqual([]);
  });
});

describe('date helpers used by the recurrence / calendar views', () => {
  it('clamps addMonths to the last valid day of the target month', () => {
    expect(addMonths(new Date(2026, 0, 31), 1).getDate()).toBe(28);
    expect(addMonths(new Date(2024, 0, 31), 1).getDate()).toBe(29); // leap year
  });

  it('starts weeks on Monday', () => {
    const sunday = new Date(2026, 0, 4);
    expect(startOfWeek(sunday).getDay()).toBe(1);
    expect(startOfWeek(sunday).getDate()).toBe(29); // previous Monday
  });

  it('endOfDay lands at 23:59:59.999 and differenceInDays ignores time-of-day', () => {
    expect(endOfDay(new Date(2026, 0, 1, 8)).getHours()).toBe(23);
    expect(differenceInDays(new Date(2026, 0, 3, 23, 59), new Date(2026, 0, 1, 0, 1))).toBe(2);
  });
});

describe('task status / priority contracts', () => {
  it('GTD_COLUMNS covers every TaskStatus exactly once', () => {
    const all: TaskStatus[] = ['inbox', 'today', 'next', 'waiting', 'someday', 'done', 'scheduled'];
    const keys = GTD_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...all].sort());
  });

  it('PRIORITY_META covers all priorities with increasing weights', () => {
    expect(Object.keys(PRIORITY_META).sort()).toEqual(['high', 'low', 'medium', 'none']);
    expect(PRIORITY_META.low.weight).toBeLessThan(PRIORITY_META.medium.weight);
    expect(PRIORITY_META.medium.weight).toBeLessThan(PRIORITY_META.high.weight);
  });

  it('reserves the brand-green --primary for emphasis, not the low priority', () => {
    expect(PRIORITY_META.low.color).not.toBe('var(--primary)');
  });
});

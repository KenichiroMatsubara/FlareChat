import { describe, expect, it } from 'vitest';

import { nextScheduledRun, parseSchedule } from './schedule';

const at = (iso: string): Date => new Date(iso);

describe('reading a Schedule', () => {
  it('reads a daily time', () => {
    expect(parseSchedule('daily 09:00')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
  });

  it('reads a weekly day and time', () => {
    expect(parseSchedule('weekly mon 07:30')).toEqual({ kind: 'weekly', weekday: 1, hour: 7, minute: 30 });
  });

  it('reads an hourly minute', () => {
    expect(parseSchedule('hourly :15')).toEqual({ kind: 'hourly', minute: 15 });
  });

  it('refuses what it cannot run rather than guessing', () => {
    expect(parseSchedule('*/5 * * * *')).toBeNull();
    expect(parseSchedule('daily 25:00')).toBeNull();
    expect(parseSchedule('weekly funday 09:00')).toBeNull();
    expect(parseSchedule('')).toBeNull();
  });
});

describe('the next time a Schedule is due', () => {
  it('runs later the same day when the time has not passed', () => {
    expect(nextScheduledRun({ schedule: 'daily 09:00', offsetMinutes: 0, after: at('2026-08-18T07:00:00.000Z') }))
      .toBe('2026-08-18T09:00:00.000Z');
  });

  it('runs tomorrow once today’s time has passed', () => {
    expect(nextScheduledRun({ schedule: 'daily 09:00', offsetMinutes: 0, after: at('2026-08-18T09:00:00.000Z') }))
      .toBe('2026-08-19T09:00:00.000Z');
  });

  it('reads the stated time in the Account’s own offset, not the server’s', () => {
    expect(nextScheduledRun({ schedule: 'daily 09:00', offsetMinutes: 540, after: at('2026-08-18T07:00:00.000Z') }))
      .toBe('2026-08-19T00:00:00.000Z');
  });

  it('finds the next occurrence of a weekday', () => {
    expect(nextScheduledRun({ schedule: 'weekly mon 07:30', offsetMinutes: 0, after: at('2026-08-18T00:00:00.000Z') }))
      .toBe('2026-08-24T07:30:00.000Z');
  });

  it('runs at the stated minute of the next hour', () => {
    expect(nextScheduledRun({ schedule: 'hourly :15', offsetMinutes: 0, after: at('2026-08-18T09:20:00.000Z') }))
      .toBe('2026-08-18T10:15:00.000Z');
  });

  it('never schedules a run it cannot read', () => {
    expect(nextScheduledRun({ schedule: 'every so often', offsetMinutes: 0, after: at('2026-08-18T09:00:00.000Z') })).toBeNull();
  });
});

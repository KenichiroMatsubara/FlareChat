import { describe, expect, it } from 'vitest';

import { intakeOwed, latestMorning, morningNoticeDue, tokyoDay, tokyoDaysBetween } from './morning';

describe('the Morning', () => {
  it('falls at 05:00 Asia/Tokyo, the latest one at or before the instant asked about', () => {
    expect(latestMorning('2026-08-01T00:00:00.000Z')).toBe('2026-07-31T20:00:00.000Z');
    expect(latestMorning('2026-07-31T20:00:00.000Z')).toBe('2026-07-31T20:00:00.000Z');
    expect(latestMorning('2026-07-31T19:59:59.999Z')).toBe('2026-07-30T20:00:00.000Z');
    expect(latestMorning('2026-07-31T15:30:00.000Z')).toBe('2026-07-30T20:00:00.000Z');
  });

  it('counts days on the Asia/Tokyo calendar rather than in elapsed hours', () => {
    expect(tokyoDay(Date.parse('2026-07-31T15:00:00.000Z'))).toBe('2026-08-01');
    expect(tokyoDay(Date.parse('2026-07-31T14:59:59.999Z'))).toBe('2026-07-31');
    // 05:00 on the 1st to 03:00 on the 4th is under three days elapsed but three calendar days.
    expect(tokyoDaysBetween(Date.parse('2026-07-31T20:00:00.000Z'), Date.parse('2026-08-03T18:00:00.000Z'))).toBe(3);
    // A date-only deadline reads as UTC midnight, 09:00 the same day in Tokyo.
    expect(tokyoDaysBetween(Date.parse('2026-07-31T20:00:00.000Z'), Date.parse('2026-08-01'))).toBe(0);
    expect(tokyoDaysBetween(Date.parse('2026-07-31T20:00:00.000Z'), Date.parse('2026-07-31'))).toBe(-1);
    expect(tokyoDaysBetween(Date.parse('2026-07-31T20:00:00.000Z'), Date.parse('未定'))).toBeNaN();
  });

  it('owes an intake until one completes at or after this Morning', () => {
    const morning = '2026-07-31T20:00:00.000Z';
    expect(intakeOwed({ lastSyncedAt: null, morning })).toBe(true);
    expect(intakeOwed({ lastSyncedAt: '2026-07-31T12:00:00.000Z', morning })).toBe(true);
    expect(intakeOwed({ lastSyncedAt: '2026-07-31T20:00:00.000Z', morning })).toBe(false);
    expect(intakeOwed({ lastSyncedAt: '2026-08-01T03:00:00.000Z', morning })).toBe(false);
  });

  it('sends the Morning Notice once, when the intake finishes or at the end of the grace', () => {
    const morning = '2026-07-31T20:00:00.000Z';
    expect(morningNoticeDue({ at: '2026-07-31T20:00:00.000Z', morning, sentFor: null, intakeComplete: true })).toBe(true);
    expect(morningNoticeDue({ at: '2026-07-31T20:00:00.000Z', morning, sentFor: '2026-07-30T20:00:00.000Z', intakeComplete: true })).toBe(true);
    expect(morningNoticeDue({ at: '2026-07-31T20:30:00.000Z', morning, sentFor: morning, intakeComplete: true })).toBe(false);
    expect(morningNoticeDue({ at: '2026-07-31T21:30:00.000Z', morning, sentFor: null, intakeComplete: false })).toBe(false);
    expect(morningNoticeDue({ at: '2026-07-31T22:00:00.000Z', morning, sentFor: null, intakeComplete: false })).toBe(true);
  });
});

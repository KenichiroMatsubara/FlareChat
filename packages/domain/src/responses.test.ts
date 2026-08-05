import { describe, expect, it } from 'vitest';

import { DEFAULT_RESPONSE_WINDOW_DAYS, readResponseWindowDays } from './responses';

describe('Event Response Window', () => {
  it('defaults to sixty days', () => {
    expect(DEFAULT_RESPONSE_WINDOW_DAYS).toBe(60);
  });

  it('accepts a whole number of days inside the supported range, typed or numeric', () => {
    expect(readResponseWindowDays(14)).toEqual({ accepted: true, days: 14 });
    expect(readResponseWindowDays(' 90 ')).toEqual({ accepted: true, days: 90 });
    expect(readResponseWindowDays(1)).toEqual({ accepted: true, days: 1 });
    expect(readResponseWindowDays(365)).toEqual({ accepted: true, days: 365 });
  });

  it('refuses zero rather than reading it as switching the correlation off', () => {
    expect(readResponseWindowDays(0)).toEqual({ accepted: false, reason: 'out_of_range' });
  });

  it('refuses a window beyond a year and anything that is not a whole number', () => {
    expect(readResponseWindowDays(366)).toEqual({ accepted: false, reason: 'out_of_range' });
    expect(readResponseWindowDays(-30)).toEqual({ accepted: false, reason: 'out_of_range' });
    expect(readResponseWindowDays(7.5)).toEqual({ accepted: false, reason: 'not_a_number' });
    expect(readResponseWindowDays('two weeks')).toEqual({ accepted: false, reason: 'not_a_number' });
    expect(readResponseWindowDays(null)).toEqual({ accepted: false, reason: 'not_a_number' });
  });
});

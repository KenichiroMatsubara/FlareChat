import { describe, expect, it } from 'vitest';

import {
  lockedCalendarFields,
  mergedCalendarFields,
  responseSearchWindow,
  withinResponseWindow,
} from './event-merge';
import type { RecordedEventFields } from './event-merge';
import type { CalendarEventFields, DesiredCalendarFields } from './event-refresh';

const recorded: RecordedEventFields = {
  title: '例会',
  description: '<p>毎月の例会です。</p>',
  location: '本部会館',
  startsAt: '2026-08-03T19:00:00+09:00',
  endsAt: '2026-08-03T21:00:00+09:00',
};

const current = (overrides: Partial<CalendarEventFields> = {}): CalendarEventFields => ({
  id: 'calendar-event-1',
  etag: 'etag-1',
  title: recorded.title,
  description: recorded.description,
  location: recorded.location,
  startsAt: recorded.startsAt,
  endsAt: recorded.endsAt,
  timeZone: 'Asia/Tokyo',
  ...overrides,
});

const desired: DesiredCalendarFields = {
  title: '例会（会場変更）',
  description: '<p>会場が変わりました。</p>',
  location: '市民ホール',
  startsAt: '2026-08-03T19:00:00+09:00',
  endsAt: '2026-08-03T21:00:00+09:00',
  timeZone: 'Asia/Tokyo',
};

describe('Scheduled Event merge', () => {
  it('locks only the fields whose Calendar value has drifted from the recorded one', () => {
    expect(lockedCalendarFields(current({ startsAt: '2026-08-03T18:30:00+09:00' }), recorded)).toEqual(['startsAt']);
  });

  it('reads the same moment written in another offset as unchanged', () => {
    expect(lockedCalendarFields(current({ startsAt: '2026-08-03T10:00:00Z' }), recorded)).toEqual([]);
  });

  it('locks nothing for a Scheduled Event written before the field was recorded', () => {
    expect(lockedCalendarFields(current(), { ...recorded, description: '' })).toEqual([]);
    expect(lockedCalendarFields(current(), null)).toEqual([]);
  });

  it('keeps a human edit and still applies every other field', () => {
    const target = current({ startsAt: '2026-08-03T18:30:00+09:00' });
    const merged = mergedCalendarFields({ current: target, desired, locked: ['startsAt'] });

    expect(merged.startsAt).toBe('2026-08-03T18:30:00+09:00');
    expect(merged.location).toBe('市民ホール');
    expect(merged.title).toBe('例会（会場変更）');
  });

  it('locates the answered event far beyond the window a merge may write in', () => {
    expect(withinResponseWindow('2026-08-03T19:00:00+09:00', '2026-07-05T19:00:00+09:00')).toBe(true);
    expect(withinResponseWindow('2026-08-03T19:00:00+09:00', '2026-04-01T19:00:00+09:00')).toBe(false);
  });

  it('narrows and widens with the window the Organization configured', () => {
    expect(withinResponseWindow('2026-08-03T19:00:00+09:00', '2026-07-05T19:00:00+09:00', 14)).toBe(false);
    expect(withinResponseWindow('2026-08-03T19:00:00+09:00', '2026-04-01T19:00:00+09:00', 180)).toBe(true);
  });

  it('searches the span its configured window reaches', () => {
    expect(responseSearchWindow([{
      title: '例会', startsAt: '2026-08-03T00:00:00Z', endsAt: '2026-08-03T02:00:00Z',
      timeZone: 'Asia/Tokyo', location: '', description: '', summary: '',
    }], 10)).toEqual({
      timeMin: '2026-07-24T00:00:00.000Z',
      timeMax: '2026-08-13T00:00:00.000Z',
    });
  });

  it('has no search window when no candidate carries a usable start time', () => {
    expect(responseSearchWindow([])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { canUpdateAttendance } from './attendance';

describe('attendance Registration Links', () => {
  it('allows updates only for an unrevoked Link before its Event deadline', () => {
    const deadline = '2026-08-03T10:00:00.000Z';
    expect(canUpdateAttendance({ eventId: 'event-1', linkEventId: 'event-1', revokedAt: null, deadline, now: '2026-08-03T09:59:59.000Z' })).toBe(true);
    expect(canUpdateAttendance({ eventId: 'event-1', linkEventId: 'event-2', revokedAt: null, deadline, now: '2026-08-03T09:00:00.000Z' })).toBe(false);
    expect(canUpdateAttendance({ eventId: 'event-1', linkEventId: 'event-1', revokedAt: '2026-08-01T00:00:00.000Z', deadline, now: '2026-08-03T09:00:00.000Z' })).toBe(false);
    expect(canUpdateAttendance({ eventId: 'event-1', linkEventId: 'event-1', revokedAt: null, deadline, now: deadline })).toBe(false);
  });
});

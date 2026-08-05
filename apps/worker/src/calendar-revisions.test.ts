import { describe, expect, it } from 'vitest';
import { canApplyCalendarUpdate } from './calendar-revisions';

describe('Calendar revisions', () => {
  it('applies a change to an unlocked field when the revision still matches', () => {
    expect(canApplyCalendarUpdate({
      storedRevision: 'etag-1', incomingRevision: 'etag-1', changedFields: ['location'], lockedFields: [],
    })).toBe(true);
  });

  it('refuses a write whose revision has moved on', () => {
    expect(canApplyCalendarUpdate({
      storedRevision: 'etag-1', incomingRevision: 'etag-0', changedFields: ['location'], lockedFields: [],
    })).toBe(false);
  });

  it('refuses a write that touches a field a human has taken over', () => {
    expect(canApplyCalendarUpdate({
      storedRevision: 'etag-1', incomingRevision: 'etag-1', changedFields: ['startsAt'], lockedFields: ['startsAt'],
    })).toBe(false);
  });

  it('still applies the fields a human has not taken over', () => {
    expect(canApplyCalendarUpdate({
      storedRevision: 'etag-1', incomingRevision: 'etag-1', changedFields: ['location'], lockedFields: ['title'],
    })).toBe(true);
  });

  it('refuses a write that would change nothing', () => {
    expect(canApplyCalendarUpdate({
      storedRevision: 'etag-1', incomingRevision: 'etag-1', changedFields: [], lockedFields: [],
    })).toBe(false);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { app } from './api';
import { createTestApp, type TestApp } from '../test/app';
import { seedScheduledEvent } from '../test/seed';
import { canApplyCalendarUpdate, recordCalendarDeletion } from './calendar';

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

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

describe('Calendar deletion', () => {
  it('raises an Operations Exception and does not keep a deleted event scheduled', async () => {
    fixture = createTestApp();
    seedScheduledEvent(fixture.account, { id: 'event-1' });

    await recordCalendarDeletion(fixture.account.binding, {
      eventId: 'event-1',
      sourceMessageId: null,
      now: '2026-07-25T00:00:00.000Z',
    });

    const exceptions = await app.fetch(
      fixture.request('/api/organizations/organization-1/operations/exceptions'),
      fixture.environment,
    );
    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );

    await expect(exceptions.json()).resolves.toMatchObject({
      data: [{ code: 'calendar_event_deleted', state: 'open' }],
    });
    await expect(dashboard.json()).resolves.toMatchObject({
      data: { upcomingEvents: 0, exceptions: 1 },
    });
  });
});

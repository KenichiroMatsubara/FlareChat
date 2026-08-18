import { afterEach, describe, expect, it } from 'vitest';

import { app } from './api';
import { recordCalendarDeletion } from './calendar-sync';
import { createTestApp, type TestApp } from '../test/app';
import { seedScheduledEvent } from '../test/seed';

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

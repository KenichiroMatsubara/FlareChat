import { describe, expect, it, vi } from 'vitest';

import { deliverCalendarInvitation, recordDeliveryAttempt } from './delivery';

describe('Delivery Records', () => {
  it('records each recipient delivery outcome independently so partial success is preserved', async () => {
    const writes: unknown[][] = [];
    const database = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;

    const record = await recordDeliveryAttempt(database, { eventId: 'event-1', destination: 'recipient@example.com', channel: 'calendar', outcome: 'succeeded', externalId: 'google-event-1' });

    expect(record).toMatchObject({ eventId: 'event-1', destination: 'recipient@example.com', outcome: 'succeeded' });
    expect(writes[0]).toContain('recipient@example.com');
  });

  it('sends one Calendar invitation and records its external result without hiding another recipient failure', async () => {
    const writes: unknown[][] = [];
    const database = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'calendar-event-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const record = await deliverCalendarInvitation({ database, accessToken: 'token', eventId: 'event-1', calendarEventId: 'calendar-event-1', recipientEmail: 'guest@example.com' });

    expect(record).toMatchObject({ eventId: 'event-1', destination: 'guest@example.com', channel: 'calendar', outcome: 'succeeded', externalId: 'calendar-event-1' });
    expect(fetchMock).toHaveBeenCalledWith('https://www.googleapis.com/calendar/v3/calendars/primary/events/calendar-event-1?sendUpdates=all', expect.objectContaining({ method: 'PATCH' }));
    expect(writes[0]).toContain('succeeded');
    vi.unstubAllGlobals();
  });

  it('records a failed Calendar invitation independently for bounded retry', async () => {
    const writes: unknown[][] = [];
    const database = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 })));

    const record = await deliverCalendarInvitation({ database, accessToken: 'token', eventId: 'event-1', calendarEventId: 'calendar-event-1', recipientEmail: 'guest@example.com' });

    expect(record).toMatchObject({ outcome: 'failed', externalId: null });
    expect(writes[0]).toContain('failed');
    vi.unstubAllGlobals();
  });
});

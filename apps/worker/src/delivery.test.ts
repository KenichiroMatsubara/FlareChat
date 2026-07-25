import { describe, expect, it, vi } from 'vitest';

import { deliverCalendarInvitation, deliverLineBatch, recordDeliveryAttempt } from './delivery';

describe('Delivery Records', () => {
  it('records each recipient delivery outcome independently so partial success is preserved', async () => {
    const writes: unknown[][] = [];
    const database = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;

    const record = await recordDeliveryAttempt(database, { eventId: 'event-1', destination: 'recipient@example.com', channel: 'calendar', outcome: 'succeeded', externalId: 'google-event-1' });

    expect(record).toMatchObject({ eventId: 'event-1', destination: 'recipient@example.com', outcome: 'succeeded' });
    expect(writes[0]).toContain('recipient@example.com');
  });

  it('adds one Calendar invitee without replacing existing attendees, then records its external result', async () => {
    const writes: unknown[][] = [];
    const database = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ attendees: [{ email: 'existing@example.com' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'calendar-event-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const record = await deliverCalendarInvitation({ database, accessToken: 'token', eventId: 'event-1', calendarEventId: 'calendar-event-1', recipientEmail: 'guest@example.com' });

    expect(record).toMatchObject({ eventId: 'event-1', destination: 'guest@example.com', channel: 'calendar', outcome: 'succeeded', externalId: 'calendar-event-1' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://www.googleapis.com/calendar/v3/calendars/primary/events/calendar-event-1', expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://www.googleapis.com/calendar/v3/calendars/primary/events/calendar-event-1?sendUpdates=all', expect.objectContaining({ method: 'PATCH' }));
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body as string)).toEqual({ attendees: [{ email: 'existing@example.com' }, { email: 'guest@example.com' }] });
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

  it('sends at most five ordered LINE messages to one destination and preserves one record per message', async () => {
    const writes: unknown[][] = [];
    const database = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200, headers: { 'x-line-request-id': 'line-request-1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const records = await deliverLineBatch({ database, accessToken: 'line-token', eventId: 'event-1', destinationId: 'user-1', messages: ['first', 'second'] });

    expect(records).toHaveLength(2);
    expect(records.every((record) => record.outcome === 'succeeded' && record.externalId === 'line-request-1')).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string) as { to: string; messages: Array<{ text: string }> };
    expect(body).toEqual({ to: 'user-1', messages: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] });
    expect(writes).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});

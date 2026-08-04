import { afterEach, describe, expect, it, vi } from 'vitest';

import { archiveExpiredDeliveryRecords } from './delivery-archive';
import { activeMemberInvitees, deliverCalendarInvitation, deliverLineBatch, recordDeliveryAttempt, recordEventInvitations } from './delivery';
import { masterKey } from './cryptography';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { createMemoryR2, seedMember, seedScheduledEvent } from '../test/seed';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of openDatabases.splice(0)) database.close();
});

const deliveryDatabase = (): TestD1Database => {
  const database = createMigratedTestD1('organization');
  seedScheduledEvent(database, { id: 'event-1' });
  openDatabases.push(database);
  return database;
};

const archivedRecordCount = async (database: TestD1Database): Promise<number> =>
  archiveExpiredDeliveryRecords({
    database: database.binding,
    bucket: createMemoryR2().bucket,
    organizationKey: await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    organizationId: 'organization-1',
    before: '2099-01-01T00:00:00.000Z',
  });

describe('Delivery Records', () => {
  it('makes each recipient outcome independently durable', async () => {
    const database = deliveryDatabase();

    const succeeded = await recordDeliveryAttempt(database.binding, {
      eventId: 'event-1',
      destination: 'first@example.com',
      channel: 'calendar',
      outcome: 'succeeded',
      externalId: 'google-event-1',
    });
    const failed = await recordDeliveryAttempt(database.binding, {
      eventId: 'event-1',
      destination: 'second@example.com',
      channel: 'calendar',
      outcome: 'failed',
      externalId: null,
    });

    expect(succeeded).toMatchObject({ destination: 'first@example.com', outcome: 'succeeded' });
    expect(failed).toMatchObject({ destination: 'second@example.com', outcome: 'failed' });
    await expect(archivedRecordCount(database)).resolves.toBe(2);
  });

  it('adds one Calendar invitee without replacing existing attendees and records success', async () => {
    const database = deliveryDatabase();
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (!init?.method) {
        return new Response(JSON.stringify({ attendees: [{ email: 'existing@example.com' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'calendar-event-1' }), { status: 200 });
    }));

    const result = await deliverCalendarInvitation({
      database: database.binding,
      accessToken: 'token',
      eventId: 'event-1',
      calendarEventId: 'calendar-event-1',
      recipientEmail: 'guest@example.com',
    });

    expect(result).toMatchObject({
      destination: 'guest@example.com',
      outcome: 'succeeded',
      externalId: 'calendar-event-1',
    });
    expect(requests.map(({ url }) => url)).toEqual([
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/calendar-event-1',
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/calendar-event-1?sendUpdates=all',
    ]);
    expect(JSON.parse(requests[1]!.init?.body as string)).toEqual({
      attendees: [{ email: 'existing@example.com' }, { email: 'guest@example.com' }],
    });
    await expect(archivedRecordCount(database)).resolves.toBe(1);
  });

  it('records a failed Calendar invitation as independently retryable work', async () => {
    const database = deliveryDatabase();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 }),
    ));

    const result = await deliverCalendarInvitation({
      database: database.binding,
      accessToken: 'token',
      eventId: 'event-1',
      calendarEventId: 'calendar-event-1',
      recipientEmail: 'guest@example.com',
    });

    expect(result).toMatchObject({ destination: 'guest@example.com', outcome: 'failed', externalId: null });
    await expect(archivedRecordCount(database)).resolves.toBe(1);
  });

  it('invites every active Member that carries a usable address, once', async () => {
    const database = deliveryDatabase();
    seedMember(database, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    seedMember(database, { id: 'member-2', name: '二郎', email: 'FIRST@example.com' });
    seedMember(database, { id: 'member-3', name: '三郎', email: '' });
    seedMember(database, { id: 'member-4', name: '四郎', email: 'not-an-address' });
    seedMember(database, { id: 'member-5', name: '五郎', email: 'fifth@example.com' });
    database.execute("UPDATE members SET state = 'inactive' WHERE id = 'member-5'");

    await expect(activeMemberInvitees(database.binding)).resolves.toEqual([
      { memberId: 'member-1', name: '一郎', email: 'first@example.com' },
    ]);
  });

  it('snapshots each invited Member and records one Delivery Record per invitation', async () => {
    const database = deliveryDatabase();
    seedMember(database, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    seedMember(database, { id: 'member-2', name: '二郎', email: 'second@example.com' });

    const results = await recordEventInvitations({
      database: database.binding,
      eventId: 'event-1',
      googleEventId: 'calendar-event-1',
      invitees: await activeMemberInvitees(database.binding),
      outcome: 'succeeded',
    });

    expect(results.map(({ destination, outcome, externalId }) => ({ destination, outcome, externalId }))).toEqual([
      { destination: 'first@example.com', outcome: 'succeeded', externalId: 'calendar-event-1' },
      { destination: 'second@example.com', outcome: 'succeeded', externalId: 'calendar-event-1' },
    ]);
    expect(database.rows('SELECT member_id, name_snapshot, email_snapshot FROM event_recipients ORDER BY member_id')).toEqual([
      { member_id: 'member-1', name_snapshot: '一郎', email_snapshot: 'first@example.com' },
      { member_id: 'member-2', name_snapshot: '二郎', email_snapshot: 'second@example.com' },
    ]);
  });

  it('records a withheld invitation as pending work rather than a delivered one', async () => {
    const database = deliveryDatabase();
    seedMember(database, { id: 'member-1', name: '一郎', email: 'first@example.com' });

    const results = await recordEventInvitations({
      database: database.binding,
      eventId: 'event-1',
      googleEventId: 'calendar-event-1',
      invitees: await activeMemberInvitees(database.binding),
      outcome: 'pending',
    });

    expect(results).toMatchObject([{ destination: 'first@example.com', outcome: 'pending', externalId: null }]);
    expect(database.rows('SELECT member_id FROM event_recipients')).toEqual([{ member_id: 'member-1' }]);
  });

  it('sends one ordered LINE batch and leaves one durable outcome per intended message', async () => {
    const database = deliveryDatabase();
    let requestBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(init?.body as string);
      return new Response('', { status: 200, headers: { 'x-line-request-id': 'line-request-1' } });
    }));

    const results = await deliverLineBatch({
      database: database.binding,
      accessToken: 'line-token',
      eventId: 'event-1',
      destinationId: 'user-1',
      messages: ['first', 'second'],
    });

    expect(requestBody).toEqual({
      to: 'user-1',
      messages: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
    });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.outcome === 'succeeded' && result.externalId === 'line-request-1')).toBe(true);
    await expect(archivedRecordCount(database)).resolves.toBe(2);
  });

  it('rejects a LINE batch larger than the provider limit without creating Delivery Records', async () => {
    const database = deliveryDatabase();

    await expect(deliverLineBatch({
      database: database.binding,
      accessToken: 'line-token',
      eventId: 'event-1',
      destinationId: 'user-1',
      messages: ['1', '2', '3', '4', '5', '6'],
    })).rejects.toThrow('between one and five');
    await expect(archivedRecordCount(database)).resolves.toBe(0);
  });
});

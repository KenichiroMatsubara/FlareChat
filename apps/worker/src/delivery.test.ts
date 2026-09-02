import { afterEach, describe, expect, it } from 'vitest';

import { archiveExpiredDeliveryRecords } from './delivery-archive';
import { activeContactInvitees, recordDeliveryAttempt, recordEventInvitations } from './delivery';
import { masterKey } from './cryptography';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { createMemoryR2, seedContact, seedScheduledEvent } from '../test/seed';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
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
    accountKey: await masterKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    accountId: 'organization-1',
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

  it('invites every active Contact that carries a usable address, once', async () => {
    const database = deliveryDatabase();
    seedContact(database, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    seedContact(database, { id: 'member-2', name: '二郎', email: 'FIRST@example.com' });
    seedContact(database, { id: 'member-3', name: '三郎', email: '' });
    seedContact(database, { id: 'member-4', name: '四郎', email: 'not-an-address' });
    seedContact(database, { id: 'member-5', name: '五郎', email: 'fifth@example.com' });
    database.execute("UPDATE members SET state = 'inactive' WHERE id = 'member-5'");

    await expect(activeContactInvitees(database.binding)).resolves.toEqual([
      { contactId: 'member-1', name: '一郎', email: 'first@example.com' },
    ]);
  });

  it('snapshots each invited Contact and records one Delivery Record per invitation', async () => {
    const database = deliveryDatabase();
    seedContact(database, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    seedContact(database, { id: 'member-2', name: '二郎', email: 'second@example.com' });

    const results = await recordEventInvitations({
      database: database.binding,
      eventId: 'event-1',
      googleEventId: 'calendar-event-1',
      invitees: await activeContactInvitees(database.binding),
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
    seedContact(database, { id: 'member-1', name: '一郎', email: 'first@example.com' });

    const results = await recordEventInvitations({
      database: database.binding,
      eventId: 'event-1',
      googleEventId: 'calendar-event-1',
      invitees: await activeContactInvitees(database.binding),
      outcome: 'pending',
    });

    expect(results).toMatchObject([{ destination: 'first@example.com', outcome: 'pending', externalId: null }]);
    expect(database.rows('SELECT member_id FROM event_recipients')).toEqual([{ member_id: 'member-1' }]);
  });
});

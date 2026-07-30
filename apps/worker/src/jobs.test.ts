import { afterEach, describe, expect, it } from 'vitest';

import organizationInitialMigration from '../migrations/organization/0000_initial.sql';
import { claimDueJobs, completeJob, enqueueJob, recoverDueOrganizationJobs, retryJob } from './jobs';
import { createMigratedTestD1, createTestD1Database, type TestD1Database } from '../test/d1';
import { seedOrganizationRoute } from '../test/seed';

const openDatabases: TestD1Database[] = [];

const organizationDatabase = (): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  return database;
};

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Durable Jobs', () => {
  it('makes one due Job claimable when the same idempotency key is enqueued twice', async () => {
    const database = organizationDatabase();

    await enqueueJob(database.binding, {
      kind: 'calendar_delivery',
      payload: { eventId: 'event-1' },
      idempotencyKey: 'calendar:event-1:recipient-1',
    });
    await enqueueJob(database.binding, {
      kind: 'calendar_delivery',
      payload: { eventId: 'event-1' },
      idempotencyKey: 'calendar:event-1:recipient-1',
    });

    const firstClaim = await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z');
    const duplicateClaim = await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z');

    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({
      kind: 'calendar_delivery',
      idempotencyKey: 'calendar:event-1:recipient-1',
    });
    expect(JSON.parse(firstClaim[0]!.payload)).toEqual({ eventId: 'event-1' });
    expect(duplicateClaim).toEqual([]);
  });

  it('recovers due Jobs from every active Organization after Queue hints are lost', async () => {
    const control = createMigratedTestD1('control');
    const first = organizationDatabase();
    const second = organizationDatabase();
    openDatabases.push(control);
    seedOrganizationRoute(control, { id: 'organization-1', bindingName: 'ORG_ONE' });
    seedOrganizationRoute(control, { id: 'organization-2', bindingName: 'ORG_TWO' });
    await enqueueJob(first.binding, { kind: 'calendar_delivery', payload: { eventId: 'event-1' }, idempotencyKey: 'job-1' });
    await enqueueJob(second.binding, { kind: 'line_delivery', payload: { eventId: 'event-2' }, idempotencyKey: 'job-2' });

    const recovered = await recoverDueOrganizationJobs({
      CONTROL_DB: control.binding,
      ORG_ONE: first.binding,
      ORG_TWO: second.binding,
    } as unknown as Parameters<typeof recoverDueOrganizationJobs>[0], '2099-01-01T00:00:00.000Z');

    expect(recovered.map((job) => job.idempotencyKey).sort()).toEqual(['job-1', 'job-2']);
  });

  it('upgrades an active Organization before scheduled Job recovery queries it', async () => {
    const control = createMigratedTestD1('control');
    const organization = createTestD1Database();
    openDatabases.push(control, organization);
    for (const statement of organizationInitialMigration
      .split('--> statement-breakpoint')
      .map((value) => value.trim())
      .filter(Boolean)) {
      organization.execute(statement);
    }
    organization.execute(
      'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    );
    organization.execute('INSERT INTO d1_migrations (name) VALUES (?)', '0000_initial.sql');
    seedOrganizationRoute(control, { id: 'organization-1', bindingName: 'ORG_ONE' });

    await expect(recoverDueOrganizationJobs({
      CONTROL_DB: control.binding,
      ORG_ONE: organization.binding,
    } as unknown as Parameters<typeof recoverDueOrganizationJobs>[0], '2099-01-01T00:00:00.000Z'))
      .resolves.toEqual([]);
    expect(organization.rows<{ display_name: string }>(
      'SELECT display_name FROM line_destinations',
    )).toEqual([]);
  });

  it('keeps completed work unclaimable and makes retryable work claimable only when due', async () => {
    const database = organizationDatabase();
    await enqueueJob(database.binding, { kind: 'calendar_delivery', payload: {}, idempotencyKey: 'completed' });
    const [completed] = await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z');
    await completeJob(database.binding, completed!.id, '2026-07-25T00:00:00.000Z');

    await enqueueJob(database.binding, { kind: 'calendar_delivery', payload: {}, idempotencyKey: 'retryable' });
    const [retryable] = await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z');
    const retry = await retryJob(database.binding, retryable!, 'temporary failure', '2026-07-25T00:00:00.000Z');
    if (retry.state !== 'pending') throw new Error('Expected a retryable Job.');

    expect(await claimDueJobs(database.binding, '2026-07-25T00:00:59.999Z')).toEqual([]);
    await expect(claimDueJobs(database.binding, retry.availableAt)).resolves.toHaveLength(1);
    expect((await claimDueJobs(database.binding, '2099-01-01T00:00:00.000Z')).map((job) => job.idempotencyKey)).not.toContain('completed');
  });
});

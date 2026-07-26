import { afterEach, describe, expect, it, vi } from 'vitest';

import { provisionOrganizationDatabase } from './organization-db';
import { claimDueJobs, enqueueJob } from './jobs';
import type { Bindings } from './types';
import {
  applyTestMigrations,
  createMigratedTestD1,
  createTestD1Database,
  type TestD1Database,
} from '../test/d1';
import { seedOrganizationRoute } from '../test/seed';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of openDatabases.splice(0)) database.close();
});

const localEnvironment = (): {
  control: TestD1Database;
  first: TestD1Database;
  second: TestD1Database;
  environment: Bindings;
} => {
  const control = createMigratedTestD1('control');
  const first = createTestD1Database();
  const second = createTestD1Database();
  openDatabases.push(control, first, second);
  return {
    control,
    first,
    second,
    environment: {
      CONTROL_DB: control.binding,
      LOCAL_ORGANIZATION_DB_1: first.binding,
      LOCAL_ORGANIZATION_DB_2: second.binding,
    } as unknown as Bindings,
  };
};

describe('Organization database resolver', () => {
  it('allocates a local Organization database without contacting Cloudflare', async () => {
    const { environment, first } = localEnvironment();
    const cloudflare = vi.fn();
    vi.stubGlobal('fetch', cloudflare);

    const location = await provisionOrganizationDatabase(environment, {
      organizationId: 'organization-1',
      setupId: 'setup-1',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: null,
    });

    expect(location).toMatchObject({
      databaseId: 'local:LOCAL_ORGANIZATION_DB_1',
      bindingName: 'LOCAL_ORGANIZATION_DB_1',
      database: first.binding,
    });
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it('keeps different Organizations durable in different local databases', async () => {
    const { control, environment } = localEnvironment();
    const first = await provisionOrganizationDatabase(environment, {
      organizationId: 'organization-1',
      setupId: 'setup-1',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: null,
    });
    applyTestMigrations(openDatabases[1]!, 'organization');
    seedOrganizationRoute(control, {
      id: 'organization-1',
      bindingName: first.bindingName,
      databaseId: first.databaseId,
    });
    const second = await provisionOrganizationDatabase(environment, {
      organizationId: 'organization-2',
      setupId: 'setup-2',
      bindingName: 'ORG_ORGANIZATION2',
      databaseId: null,
    });
    applyTestMigrations(openDatabases[2]!, 'organization');

    await enqueueJob(first.database, {
      kind: 'calendar_delivery',
      payload: { eventId: 'event-1' },
      idempotencyKey: 'organization-1-job',
    });

    await expect(claimDueJobs(second.database, '2099-01-01T00:00:00.000Z')).resolves.toEqual([]);
    await expect(claimDueJobs(first.database, '2099-01-01T00:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: 'organization-1-job' }),
    ]);
  });
});

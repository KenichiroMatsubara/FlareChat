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

  it('records the schema versions it installs for a new local Organization database', async () => {
    const { environment, first } = localEnvironment();
    const provisioned = await provisionOrganizationDatabase(environment, {
      organizationId: 'organization-1',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: null,
    });

    await provisioned.initialize();

    expect(first.rows<{ name: string }>('SELECT name FROM d1_migrations ORDER BY name')).toEqual([
      { name: '0000_initial.sql' },
      { name: '0001_tasks.sql' },
    ]);
  });

  it('initializes a partially applied production database through one batch seam', async () => {
    const control = createMigratedTestD1('control');
    openDatabases.push(control);
    const requests: Array<{ batch?: Array<{ sql: string; params: unknown[] }>; sql?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        batch?: Array<{ sql: string; params: unknown[] }>;
        sql?: string;
      };
      requests.push(body);
      if (body.batch) {
        return new Response(JSON.stringify({
          success: true,
          result: body.batch.map(() => ({ success: true, results: [], meta: {} })),
        }));
      }
      return new Response(JSON.stringify({
        success: true,
        result: [{
          success: true,
          results: [{ name: 'recipient_profiles' }, { name: 'event_recipients' }],
          meta: {},
        }],
      }));
    }));
    const environment = {
      CONTROL_DB: control.binding,
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      CLOUDFLARE_API_TOKEN: 'token-1',
    } as unknown as Bindings;

    const provisioned = await provisionOrganizationDatabase(environment, {
      organizationId: 'organization-1',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: 'database-1',
    });
    await provisioned.initialize();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.batch?.map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      'PRAGMA defer_foreign_keys = on',
      'DROP TABLE IF EXISTS "recipient_profiles"',
      'DROP TABLE IF EXISTS "event_recipients"',
      expect.stringContaining('CREATE TABLE `recipient_profiles`'),
      'PRAGMA defer_foreign_keys = off',
    ]));
  });
});

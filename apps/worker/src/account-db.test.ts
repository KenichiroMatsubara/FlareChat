import { afterEach, describe, expect, it, vi } from 'vitest';

import { accountDatabaseIdentity, provisionAccountDatabase } from './account-db';
import { claimDueJobs, enqueueJob } from './jobs';
import type { Bindings } from './types';
import {
  applyTestMigrations,
  createMigratedTestD1,
  createTestD1Database,
  type TestD1Database,
} from '../test/d1';
import { seedAccountRoute } from '../test/seed';

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

describe('Account database resolver', () => {
  it('derives a readable FlareChat database identity from the Automation Inbox', async () => {
    const first = await accountDatabaseIdentity(' Okazaki.RAC+Ops@Gmail.com ');
    const second = await accountDatabaseIdentity('okazaki.rac+ops@gmail.com');

    expect(first).toEqual(second);
    expect(first.databaseName).toMatch(
      /^flarechat-organization-okazaki-rac-ops-at-gmail-com-[a-f0-9]{12}$/u,
    );
    expect(first.bindingName).toMatch(/^ORG_[A-F0-9]{24}$/u);
  });

  it('allocates a local Account database without contacting Cloudflare', async () => {
    const { environment, first } = localEnvironment();
    const cloudflare = vi.fn();
    vi.stubGlobal('fetch', cloudflare);

    const location = await provisionAccountDatabase(environment, {
      accountId: 'organization-1',
      inboxAddress: 'first@example.com',
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

  it('keeps different Accounts durable in different local databases', async () => {
    const { control, environment } = localEnvironment();
    const first = await provisionAccountDatabase(environment, {
      accountId: 'organization-1',
      inboxAddress: 'first@example.com',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: null,
    });
    applyTestMigrations(openDatabases[1]!, 'organization');
    seedAccountRoute(control, {
      id: 'organization-1',
      bindingName: first.bindingName,
      databaseId: first.databaseId,
    });
    const second = await provisionAccountDatabase(environment, {
      accountId: 'organization-2',
      inboxAddress: 'second@example.com',
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

  it('records the schema versions it installs for a new local Account database', async () => {
    const { environment, first } = localEnvironment();
    const provisioned = await provisionAccountDatabase(environment, {
      accountId: 'organization-1',
      inboxAddress: 'first@example.com',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: null,
    });

    await provisioned.initialize();

    expect(first.rows<{ name: string }>('SELECT name FROM d1_migrations ORDER BY name')).toEqual([
      { name: '0000_initial.sql' },
      { name: '0001_tasks.sql' },
      { name: '0002_line_destination_roster.sql' },
      { name: '0003_release_safe_line_destination_index.sql' },
      { name: '0004_manual_line_destination_source.sql' },
      { name: '0005_optional_recipient_email.sql' },
      { name: '0006_operational_task_roles.sql' },
      { name: '0007_source_message_deliveries.sql' },
      { name: '0008_rule_permitted_lists.sql' },
      { name: '0009_prompts.sql' },
      { name: '0010_agent_rules.sql' },
      { name: '0011_agent_runs.sql' },
      { name: '0012_event_agent_owners.sql' },
      { name: '0013_agent_rule_writes.sql' },
      { name: '0014_members.sql' },
      { name: '0015_attachment_folders.sql' },
      { name: '0016_member_task_assignments.sql' },
      { name: '0017_member_portal.sql' },
      { name: '0018_automation_inbox_health.sql' },
      { name: '0019_task_role_revisions.sql' },
      { name: '0020_event_responses_and_guests.sql' },
      { name: '0021_rule_execution.sql' },
      { name: '0022_operator_chat.sql' },
    ]);
  });

  it('applies only missing migrations without dropping a reused production database', async () => {
    const control = createMigratedTestD1('control');
    openDatabases.push(control);
    const requests: Array<{ batch?: Array<{ sql: string; params: unknown[] }>; sql?: string }> = [];
    const applied = new Map<string, string | null>([['0000_initial.sql', null]]);
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        batch?: Array<{ sql: string; params: unknown[] }>;
        sql?: string;
        params?: unknown[];
      };
      requests.push(body);
      if (body.batch) {
        for (const query of body.batch) {
          if (query.sql.startsWith('INSERT INTO d1_migrations')) {
            applied.set(String(query.params[0]), String(query.params[1]));
          }
        }
        return new Response(JSON.stringify({
          success: true,
          result: body.batch.map(() => ({ success: true, results: [], meta: {} })),
        }));
      }
      const results = body.sql === 'PRAGMA table_info(d1_migrations)'
        ? ['id', 'name', 'checksum', 'applied_at'].map((name) => ({ name }))
        : body.sql === 'SELECT name, checksum FROM d1_migrations'
          ? [...applied].map(([name, checksum]) => ({ name, checksum }))
          : body.sql === 'SELECT checksum FROM d1_migrations WHERE name = ?'
            ? applied.has(String(body.params?.[0]))
              ? [{ checksum: applied.get(String(body.params?.[0])) }]
              : []
            : [];
      return new Response(JSON.stringify({
        success: true,
        result: [{
          success: true,
          results,
          meta: {},
        }],
      }));
    }));
    const environment = {
      CONTROL_DB: control.binding,
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      CLOUDFLARE_API_TOKEN: 'token-1',
    } as unknown as Bindings;

    const provisioned = await provisionAccountDatabase(environment, {
      accountId: 'organization-1',
      inboxAddress: 'first@example.com',
      bindingName: 'ORG_ORGANIZATION1',
      databaseId: 'database-1',
    });
    await provisioned.initialize();

    const statements = requests.flatMap(({ batch }) => batch?.map(({ sql }) => sql) ?? []);
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining('CREATE TABLE `tasks`'),
      expect.stringContaining('ALTER TABLE `line_destinations` ADD `display_name`'),
      'INSERT INTO d1_migrations (name, checksum) VALUES (?, ?)',
    ]));
    expect(statements.some((statement) => statement.includes('DROP TABLE `source_messages`'))).toBe(false);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import accountInitialMigration from '../../migrations/organization/0000_initial.sql';
import { createMigratedTestD1, createTestD1Database, type TestD1Database } from '../../test/d1';
import { seedAccountContact, seedAccountRoute } from '../../test/seed';
import type { Bindings } from '../types';
import { createRequestContext } from './request-context';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Request Context database access', () => {
  it('upgrades an Account database before an authenticated route can query it', async () => {
    const control = createMigratedTestD1('control');
    const account = createTestD1Database();
    openDatabases.push(control, account);
    for (const statement of accountInitialMigration
      .split('--> statement-breakpoint')
      .map((value) => value.trim())
      .filter(Boolean)) {
      account.execute(statement);
    }
    account.execute(
      'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    );
    account.execute('INSERT INTO d1_migrations (name) VALUES (?)', '0000_initial.sql');
    seedAccountRoute(control, {
      id: 'organization-1',
      bindingName: 'ORG_ONE',
      databaseId: 'database-one',
    });
    seedAccountContact(control, {
      accountId: 'organization-1',
      identityId: 'identity-1',
      email: 'owner@example.com',
      sessionId: 'session-1',
    });
    const context = createRequestContext(new Request('https://example.test', {
      headers: { Cookie: 'mail_session=session-1' },
    }), {
      CONTROL_DB: control.binding,
      ORG_ONE: account.binding,
    } as unknown as Bindings);

    const access = await context.account('organization-1');

    await expect(access.database?.prepare(
      'SELECT display_name FROM line_destinations',
    ).all()).resolves.toMatchObject({ success: true });
  });
});

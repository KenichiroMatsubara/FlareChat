import { afterEach, describe, expect, it } from 'vitest';

import organizationInitialMigration from '../../migrations/organization/0000_initial.sql';
import { createMigratedTestD1, createTestD1Database, type TestD1Database } from '../../test/d1';
import { seedOrganizationMember, seedOrganizationRoute } from '../../test/seed';
import type { Bindings } from '../types';
import { createRequestContext } from './request-context';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Request Context database access', () => {
  it('upgrades an Organization database before an authenticated route can query it', async () => {
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
    seedOrganizationRoute(control, {
      id: 'organization-1',
      bindingName: 'ORG_ONE',
      databaseId: 'database-one',
    });
    seedOrganizationMember(control, {
      organizationId: 'organization-1',
      identityId: 'identity-1',
      email: 'owner@example.com',
      sessionId: 'session-1',
    });
    const context = createRequestContext(new Request('https://example.test', {
      headers: { Cookie: 'mail_session=session-1' },
    }), {
      CONTROL_DB: control.binding,
      ORG_ONE: organization.binding,
    } as unknown as Bindings);

    const access = await context.organization('organization-1');

    await expect(access.database?.prepare(
      'SELECT display_name FROM line_destinations',
    ).all()).resolves.toMatchObject({ success: true });
  });
});

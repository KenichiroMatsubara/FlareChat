import { afterEach, describe, expect, it } from 'vitest';

import accountInitialMigration from '../migrations/organization/0000_initial.sql';
import { createTestD1Database, type TestD1Database } from '../test/d1';
import { createDatabaseAccess } from './database-access';
import type { Bindings } from './types';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Database Access', () => {
  it('returns an Account database only after making its schema current', async () => {
    const database = createTestD1Database();
    openDatabases.push(database);
    for (const statement of accountInitialMigration
      .split('--> statement-breakpoint')
      .map((value) => value.trim())
      .filter(Boolean)) {
      database.execute(statement);
    }
    database.execute(
      'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    );
    database.execute('INSERT INTO d1_migrations (name) VALUES (?)', '0000_initial.sql');
    const access = createDatabaseAccess({
      ORG_EXAMPLE: database.binding,
    } as unknown as Bindings);

    const ready = await access.open({
      kind: 'organization',
      bindingName: 'ORG_EXAMPLE',
      databaseId: 'database-example',
    });

    expect(ready.schema.currentMigration).toBe('0024_automations.sql');
    await expect(ready.raw.prepare(
      'SELECT display_name FROM line_destinations',
    ).all()).resolves.toMatchObject({ success: true });
  });
});

import { SchemaReadinessError, schemaLifecycle, type SchemaReceipt } from './schema-lifecycle';
import type { Bindings } from './types';

export interface ReadyOrganizationDatabase {
  kind: 'organization';
  raw: D1Database;
  schema: SchemaReceipt;
}

export interface ReadyControlDatabase {
  kind: 'control';
  raw: D1Database;
  schema: SchemaReceipt;
}

export type ReadyDatabase = ReadyControlDatabase | ReadyOrganizationDatabase;

type ControlDatabaseLocator = {
  kind: 'control';
};

type OrganizationDatabaseLocator = {
  kind: 'organization';
  bindingName: string;
  databaseId: string | null;
};

export type DatabaseLocator = ControlDatabaseLocator | OrganizationDatabaseLocator;

export class DatabaseBindingUnavailableError extends Error {
  constructor(bindingName: string) {
    super(`Organization database binding ${bindingName} is unavailable.`);
    this.name = 'DatabaseBindingUnavailableError';
  }
}

export const createDatabaseAccess = (env: Bindings) => ({
  async open(locator: DatabaseLocator): Promise<ReadyDatabase> {
    const bindingName = locator.kind === 'control' ? 'CONTROL_DB' : locator.bindingName;
    const bound = (env as unknown as Record<string, unknown>)[bindingName];
    if (!bound || typeof bound !== 'object') {
      throw new DatabaseBindingUnavailableError(bindingName);
    }
    const raw = bound as D1Database;
    let schema: SchemaReceipt;
    try {
      schema = await schemaLifecycle.ensureCurrent({
        kind: locator.kind,
        database: raw,
      });
    } catch (error) {
      if (!(error instanceof SchemaReadinessError)) throw error;
      throw new SchemaReadinessError({
        category: error.category,
        kind: error.kind,
        currentMigration: error.currentMigration,
        expectedMigration: error.expectedMigration,
        databaseId: locator.kind === 'organization' ? locator.databaseId : null,
        bindingName,
        cause: error,
      });
    }
    return { kind: locator.kind, raw, schema } as ReadyDatabase;
  },
});

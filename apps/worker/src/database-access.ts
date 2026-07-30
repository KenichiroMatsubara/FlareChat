import { schemaLifecycle, type SchemaReceipt } from './schema-lifecycle';
import type { Bindings } from './types';

export interface ReadyOrganizationDatabase {
  kind: 'organization';
  raw: D1Database;
  schema: SchemaReceipt;
}

type OrganizationDatabaseLocator = {
  kind: 'organization';
  bindingName: string;
  databaseId: string | null;
};

export class DatabaseBindingUnavailableError extends Error {
  constructor(bindingName: string) {
    super(`Organization database binding ${bindingName} is unavailable.`);
    this.name = 'DatabaseBindingUnavailableError';
  }
}

export const createDatabaseAccess = (env: Bindings) => ({
  async open(locator: OrganizationDatabaseLocator): Promise<ReadyOrganizationDatabase> {
    const bound = (env as unknown as Record<string, unknown>)[locator.bindingName];
    if (!bound || typeof bound !== 'object') {
      throw new DatabaseBindingUnavailableError(locator.bindingName);
    }
    const raw = bound as D1Database;
    const schema = await schemaLifecycle.ensureCurrent({
      kind: 'organization',
      database: raw,
    });
    return { kind: 'organization', raw, schema };
  },
});

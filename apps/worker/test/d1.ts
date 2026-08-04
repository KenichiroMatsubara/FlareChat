import BetterSqlite3 from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;
const TEST_QUERY = Symbol('test-query');

interface TestPreparedQuery {
  query: string;
  parameters: unknown[];
}

const d1Result = <T>(results: T[], changes = 0): D1Result<T> => ({
  success: true,
  results,
  meta: {
    served_by: 'test',
    duration: 0,
    changes,
    last_row_id: 0,
    changed_db: changes > 0,
    size_after: 0,
    rows_read: results.length,
    rows_written: changes,
  },
});

const createStatement = (database: SqliteDatabase, query: string, parameters: unknown[] = []): D1PreparedStatement => ({
  [TEST_QUERY]: { query, parameters },
  bind: (...values: unknown[]) => createStatement(database, query, values),
  first: async <T>(column?: string): Promise<T | null> => {
    const row = database.prepare(query).get(...parameters) as Record<string, T> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  },
  all: async <T>(): Promise<D1Result<T>> =>
    d1Result(database.prepare(query).all(...parameters) as T[]),
  run: async <T>(): Promise<D1Result<T>> => {
    const result = database.prepare(query).run(...parameters);
    return d1Result<T>([], result.changes);
  },
  raw: async <T>(): Promise<T[][]> =>
    database.prepare(query).raw(true).all(...parameters) as T[][],
} as unknown as D1PreparedStatement);

export interface TestD1Database {
  binding: D1Database;
  execute: (query: string, ...parameters: unknown[]) => void;
  rows: <T>(query: string, ...parameters: unknown[]) => T[];
  row: <T>(query: string, ...parameters: unknown[]) => T | undefined;
  close: () => void;
}

export const createTestD1Database = (): TestD1Database => {
  const database = new BetterSqlite3(':memory:');
  database.pragma('foreign_keys = ON');
  const binding = {
    prepare: (query: string) => createStatement(database, query),
    batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      database.exec('BEGIN');
      try {
        const results = statements.map((statement) => {
          const prepared = (statement as unknown as {
            [TEST_QUERY]?: TestPreparedQuery;
          })[TEST_QUERY];
          if (!prepared) throw new Error('Test D1 received an unsupported prepared statement.');
          const result = database.prepare(prepared.query).run(...prepared.parameters);
          return d1Result<T>([], result.changes);
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    exec: async (query: string): Promise<D1ExecResult> => {
      database.exec(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
  return {
    binding,
    execute: (query, ...parameters) => { database.prepare(query).run(...parameters); },
    rows: <T>(query: string, ...parameters: unknown[]) => database.prepare(query).all(...parameters) as T[],
    row: <T>(query: string, ...parameters: unknown[]) => database.prepare(query).get(...parameters) as T | undefined,
    close: () => database.close(),
  };
};

const migrationDirectory = (kind: 'control' | 'organization'): string =>
  resolve(import.meta.dirname, `../migrations/${kind}`);

export const applyTestMigrations = (
  database: TestD1Database,
  kind: 'control' | 'organization',
  through?: string,
): void => {
  const names = readdirSync(migrationDirectory(kind))
    .filter((file) => file.endsWith('.sql') && (through === undefined || file <= through))
    .sort();
  for (const name of names) {
    const migration = readFileSync(resolve(migrationDirectory(kind), name), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) {
      database.execute(statement);
    }
  }
  database.execute(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
  for (const name of names) {
    database.execute('INSERT INTO d1_migrations (name) VALUES (?)', name);
  }
};

export const createMigratedTestD1 = (
  kind: 'control' | 'organization',
  through?: string,
): TestD1Database => {
  const database = createTestD1Database();
  applyTestMigrations(database, kind, through);
  return database;
};

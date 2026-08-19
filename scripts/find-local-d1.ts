import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controlMigrationsDir = resolve(root, 'apps/worker/migrations/control');
const localD1Dir = resolve(root, 'apps/worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject');

type TextRow = { name: string };

export interface StudioDatabase {
  id: string;
  name: string;
  path: string;
}

interface Statement {
  all(...parameters: unknown[]): unknown[];
}

interface Database {
  prepare(sql: string): Statement;
  close(): void;
}

type DatabaseConstructor = new (path: string, options?: { readonly?: boolean }) => Database;

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as DatabaseConstructor;

const migrationNames = new Set(
  readdirSync(controlMigrationsDir).filter((file) => file.endsWith('.sql')),
);

type DatabaseKind = 'control' | 'organization';

interface DatabaseInfo {
  path: string;
  score: number;
  kind: DatabaseKind;
}

const readDatabaseInfo = (path: string): DatabaseInfo | undefined => {
  let database: Database | undefined;
  try {
    database = new BetterSqlite3(path, { readonly: true });
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as TextRow[])
        .map((row) => row.name),
    );
    const kind = tables.has('organizations') && tables.has('organization_setups')
      ? 'control'
      : tables.has('google_connections') && tables.has('connections') && tables.has('settings')
        ? 'organization'
        : undefined;
    if (!kind) return undefined;

    const appliedMigrations = tables.has('d1_migrations')
      ? new Set(
        (database.prepare('SELECT name FROM d1_migrations').all() as unknown as TextRow[])
          .map((row) => row.name),
      )
      : new Set<string>();
    const score = [...migrationNames].filter((name) => appliedMigrations.has(name)).length;
    return { path, score, kind };
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
};

const configuredPaths = (): string[] => {
  const configuredPaths = process.env.DB_STUDIO_PATHS;
  if (configuredPaths) return configuredPaths.split(',').map((path) => path.trim()).filter(Boolean);

  const configuredPath = process.env.DB_STUDIO_PATH;
  return configuredPath ? [configuredPath] : [];
};

const toStudioDatabases = (paths: string[], prefix: string): StudioDatabase[] => paths.map((path, index) => ({
  id: `${prefix}-${index + 1}`,
  name: paths.length === 1 ? 'Selected D1' : `Database ${index + 1}: ${basename(path)}`,
  path,
}));

/** Finds recognizable Control and Account D1 databases in a local state directory. */
export const findStudioDatabasesIn = (directory: string): StudioDatabase[] => {
  const candidates = readdirSync(directory)
    .filter((file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite')
    .map((file) => readDatabaseInfo(resolve(directory, file)))
    .filter((info): info is DatabaseInfo => info !== undefined)
    .sort((left, right) => (
      Number(right.kind === 'control') - Number(left.kind === 'control')
      || right.score - left.score
      || left.path.localeCompare(right.path)
    ));

  let accountNumber = 0;
  return candidates.map((candidate) => {
    if (candidate.kind === 'control') {
      return { id: 'control', name: 'Control D1', path: candidate.path };
    }
    accountNumber += 1;
    return {
      id: `organization-${accountNumber}`,
      name: `Account D1 ${accountNumber}`,
      path: candidate.path,
    };
  });
};

/** Finds the local D1 databases available to the read-only development browser. */
export const findStudioDatabases = (): StudioDatabase[] => {
  const configured = configuredPaths();
  if (configured.length > 0) {
    const paths = configured.map((path) => resolve(root, path));
    paths.forEach((path) => {
      if (!existsSync(path)) throw new Error(`DB_STUDIO_PATHS entry does not exist: ${path}`);
    });
    return toStudioDatabases(paths, 'configured');
  }

  if (!existsSync(localD1Dir)) {
    throw new Error('Local D1 state was not found. Run `npm run db:local` first.');
  }

  const databases = findStudioDatabasesIn(localD1Dir);
  if (databases.length === 0) {
    throw new Error('No local D1 databases were found. Run `npm run db:local` first.');
  }
  return databases;
};

export const findControlDatabase = (): string => {
  const databases = findStudioDatabases();
  const selected = databases.find((database) => database.id === 'control') ?? databases[0];
  if (!selected) {
    throw new Error('The local Control D1 database was not found. Run `npm run db:local` first.');
  }
  return selected.path;
};

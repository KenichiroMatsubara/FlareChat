import { readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { defineConfig } from 'drizzle-kit';

const root = dirname(fileURLToPath(import.meta.url));
const controlMigrationsDir = resolve(root, 'apps/worker/migrations/control');
const localD1Dir = resolve(root, 'apps/worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject');

type TextRow = { name: string };

const migrationNames = new Set(
  readdirSync(controlMigrationsDir)
    .filter((file) => file.endsWith('.sql')),
);

const readDatabaseInfo = (path: string): { path: string; score: number } | undefined => {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as TextRow[])
        .map((row) => row.name),
    );
    if (!tables.has('organizations') || !tables.has('organization_setups')) return undefined;

    const appliedMigrations = new Set(
      (database.prepare('SELECT name FROM d1_migrations').all() as unknown as TextRow[])
        .map((row) => row.name),
    );
    const score = [...migrationNames].filter((name) => appliedMigrations.has(name)).length;
    return { path, score };
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
};

const findControlDatabase = (): string => {
  const configuredPath = process.env.DB_STUDIO_PATH;
  if (configuredPath) {
    const path = resolve(root, configuredPath);
    if (!existsSync(path)) {
      throw new Error(`DB_STUDIO_PATH does not exist: ${path}`);
    }
    return path;
  }

  if (!existsSync(localD1Dir)) {
    throw new Error('Local D1 state was not found. Run `npm run db:local` first.');
  }

  const candidates = readdirSync(localD1Dir)
    .filter((file) => file.endsWith('.sqlite'))
    .map((file) => readDatabaseInfo(resolve(localD1Dir, file)))
    .filter((info): info is { path: string; score: number } => info !== undefined)
    .sort((left, right) => right.score - left.score);
  const selected = candidates[0];
  if (!selected) {
    throw new Error('The local Control D1 database was not found. Run `npm run db:local` first.');
  }
  return selected.path;
};

export default defineConfig({
  dialect: 'sqlite',
  dbCredentials: {
    url: findControlDatabase(),
  },
});

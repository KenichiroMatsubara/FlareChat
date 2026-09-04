/**
 * Rehearses every pending migration against a copy of production before a
 * release touches production (ADR 0174).
 *
 * Every D1 database the deployment owns is exported, replayed into an
 * in-memory SQLite, and taken to the current schema target by the same Schema
 * Lifecycle the Worker and the fleet release use. A migration that fails here
 * fails on the rows production actually holds, which is the failure the
 * release barrier of ADR 0100 can only report after the fact.
 *
 * Usage:
 *   rehearse-migrations.ts            export production, then replay
 *   rehearse-migrations.ts <dumpDir>  replay the <name>.sql dumps in a directory
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import JSON5 from 'json5';

import { createTestD1Database } from '../apps/worker/test/d1';
import { SchemaReadinessError, schemaLifecycle } from '../apps/worker/src/schema-lifecycle';

type SchemaKind = 'control' | 'organization';

interface Dump {
  name: string;
  kind: SchemaKind;
  sql: string;
}

interface Rehearsal {
  name: string;
  kind: SchemaKind;
  before: string;
  after: string;
  applied: string[];
  failure?: string;
}

const CONTROL_DATABASE_NAME = process.env.CONTROL_DATABASE_NAME?.trim() || 'flarechat-control-db';
const ORGANIZATION_DATABASE_PREFIX = 'flarechat-organization-';
const WRANGLER_CONFIG = resolve(import.meta.dirname, '../apps/worker/wrangler.jsonc');

const kindOf = (name: string): SchemaKind | null => {
  if (name === CONTROL_DATABASE_NAME) return 'control';
  if (name.startsWith(ORGANIZATION_DATABASE_PREFIX)) return 'organization';
  return null;
};

const wrangler = (args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync('npx', ['wrangler', ...args, '--config', WRANGLER_CONFIG], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const exportProduction = (): Dump[] => {
  const config = JSON5.parse(readFileSync(WRANGLER_CONFIG, 'utf8')) as { vars?: Record<string, unknown> };
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || config.vars?.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (typeof accountId !== 'string' || !accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is missing from the environment and wrangler.jsonc.');
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required to export the production databases for rehearsal.');
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token };
  const listed = JSON.parse(wrangler(['d1', 'list', '--json'], env)) as { name: string }[];
  const owned = listed.map(({ name }) => name).filter((name) => kindOf(name) !== null).sort();
  if (!owned.includes(CONTROL_DATABASE_NAME)) {
    throw new Error(`The Control database ${CONTROL_DATABASE_NAME} is not among the account's D1 databases.`);
  }
  const directory = mkdtempSync(join(tmpdir(), 'flarechat-rehearsal-'));
  return owned.map((name) => {
    const output = join(directory, `${name}.sql`);
    wrangler(['d1', 'export', name, '--remote', '--output', output, '--skip-confirmation'], env);
    return { name, kind: kindOf(name) as SchemaKind, sql: readFileSync(output, 'utf8') };
  });
};

const readDumps = (directory: string): Dump[] =>
  readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((file) => {
      const name = basename(file, '.sql');
      const kind = kindOf(name);
      return kind === null ? [] : [{ name, kind, sql: readFileSync(join(directory, file), 'utf8') }];
    });

const lastApplied = (rows: { name: string }[]): string => rows.at(-1)?.name ?? '';

const rehearse = async (dump: Dump): Promise<Rehearsal> => {
  const database = createTestD1Database();
  try {
    database.execute('PRAGMA foreign_keys = OFF');
    await database.binding.exec(dump.sql);
    database.execute('PRAGMA foreign_keys = ON');
    const ledger = database.row<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'");
    const before = ledger ? lastApplied(database.rows<{ name: string }>('SELECT name FROM d1_migrations ORDER BY id')) : '';
    try {
      const receipt = await schemaLifecycle.ensureCurrent({ kind: dump.kind, database: database.binding });
      const violations = database.rows('PRAGMA foreign_key_check');
      const rehearsal = { name: dump.name, kind: dump.kind, before, after: receipt.currentMigration, applied: receipt.appliedMigrations };
      if (violations.length > 0) {
        return { ...rehearsal, failure: `foreign_key_check reports ${violations.length} violation(s) after migration` };
      }
      return rehearsal;
    } catch (error) {
      const failure = error instanceof SchemaReadinessError
        ? `${error.category}: ${error.message}${error.cause instanceof Error ? ` Cause: ${error.cause.message}` : ''}`
        : error instanceof Error ? error.message : String(error);
      return { name: dump.name, kind: dump.kind, before, after: before, applied: [], failure };
    }
  } finally {
    database.close();
  }
};

const dumpDirectory = process.argv[2];
const dumps = dumpDirectory ? readDumps(resolve(dumpDirectory)) : exportProduction();
if (dumps.length === 0) throw new Error('No database dumps to rehearse.');
const results: Rehearsal[] = [];
for (const dump of dumps) results.push(await rehearse(dump));
const failures = results.filter((result) => result.failure !== undefined);
process.stdout.write(`${JSON.stringify({ rehearsed: results.length, failed: failures.length, results }, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = results.map((result) =>
    `| ${result.name} | ${result.kind} | ${result.before || '(none)'} | ${result.after || '(none)'} | ${result.applied.length} | ${result.failure ?? 'ok'} |`);
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '## Migration rehearsal',
    '',
    '| Database | Kind | Before | After | Applied | Result |',
    '|---|---|---|---|---|---|',
    ...lines,
    '',
  ].join('\n'), { flag: 'a' });
}
if (failures.length > 0) {
  process.stderr.write(`Migration rehearsal failed for ${failures.length} database(s); the release must not proceed.\n`);
  process.exit(1);
}

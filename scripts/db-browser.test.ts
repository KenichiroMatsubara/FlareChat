import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

interface Database {
  exec(sql: string): void;
  close(): void;
}

type DatabaseConstructor = new (path: string) => Database;

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as DatabaseConstructor;
const root = resolve(import.meta.dirname, '..');
const processes: ChildProcess[] = [];
const directories: string[] = [];

const freePort = async (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('Could not allocate a test port.'));
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

const createDatabase = (directory: string, name: string, value: string): string => {
  const path = join(directory, name);
  const database = new BetterSqlite3(path);
  database.exec(`CREATE TABLE entries (value TEXT NOT NULL); INSERT INTO entries (value) VALUES ('${value}');`);
  database.close();
  return path;
};

const waitFor = async (url: string): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw lastError;
};

afterEach(() => {
  processes.forEach((child) => child.kill());
  processes.length = 0;
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe('local D1 browser', () => {
  it('lists and reads each database configured with DB_STUDIO_PATHS', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mail-automation-db-browser-'));
    directories.push(directory);
    const controlPath = createDatabase(directory, 'control.sqlite', 'control row');
    const organizationPath = createDatabase(directory, 'organization.sqlite', 'organization row');
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/db-browser.ts'], {
      cwd: root,
      env: {
        ...process.env,
        DB_BROWSER_NO_OPEN: '1',
        DB_BROWSER_PORT: String(port),
        DB_STUDIO_PATHS: `${controlPath},${organizationPath}`,
      },
      stdio: 'ignore',
    });
    processes.push(child);

    const baseUrl = `http://127.0.0.1:${port}`;
    const databasesResponse = await waitFor(`${baseUrl}/api/databases`);
    expect(databasesResponse.ok).toBe(true);
    const databases = await databasesResponse.json() as Array<{ id: string }>;
    expect(databases).toHaveLength(2);

    const pageResponse = await fetch(baseUrl);
    await expect(pageResponse.text()).resolves.toContain('データベースを選択してください');

    const organization = databases[1];
    expect(organization).toBeDefined();
    const tableResponse = await fetch(`${baseUrl}/api/table?database=${encodeURIComponent(organization!.id)}&name=entries`);
    expect(tableResponse.ok).toBe(true);
    await expect(tableResponse.json()).resolves.toMatchObject({ rows: [{ value: 'organization row' }] });
  });
});

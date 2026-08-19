import { createRequire } from 'node:module';
import { join } from 'node:path';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): { run(value: string): void };
  close(): void;
}

type DatabaseConstructor = new (path: string) => Database;

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as DatabaseConstructor;

const createDatabase = (directory: string, name: string, schema: string): Database => {
  const database = new BetterSqlite3(join(directory, name));
  database.exec(schema);
  return database;
};

export const createBrowsableDatabase = (
  directory: string,
  name: string,
  value: string,
): string => {
  const database = createDatabase(directory, name, 'CREATE TABLE entries (value TEXT NOT NULL)');
  database.prepare('INSERT INTO entries (value) VALUES (?)').run(value);
  database.close();
  return join(directory, name);
};

export const createDiscoverableControlDatabase = (directory: string, name: string): void => {
  const database = createDatabase(directory, name, `
    CREATE TABLE d1_migrations (name TEXT NOT NULL);
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE organization_setups (id TEXT PRIMARY KEY);
  `);
  database.close();
};

export const createDiscoverableAccountDatabase = (directory: string, name: string): void => {
  const database = createDatabase(directory, name, `
    CREATE TABLE settings (key TEXT PRIMARY KEY);
    CREATE TABLE google_connections (id TEXT PRIMARY KEY);
    CREATE TABLE connections (id TEXT PRIMARY KEY);
  `);
  database.close();
};

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findStudioDatabasesIn } from './find-local-d1';
import {
  createDiscoverableControlDatabase,
  createDiscoverableAccountDatabase,
} from './test/sqlite';
const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe('local D1 discovery', () => {
  it('finds runtime-provisioned Account D1 without Wrangler migration records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mail-automation-d1-discovery-'));
    directories.push(directory);
    createDiscoverableControlDatabase(directory, 'control.sqlite');
    createDiscoverableAccountDatabase(directory, 'organization.sqlite');

    const databases = findStudioDatabasesIn(directory);

    expect(databases.map(({ name }) => name)).toEqual(['Control D1', 'Account D1 1']);
  });
});

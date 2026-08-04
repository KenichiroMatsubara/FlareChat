import { afterEach, describe, expect, it } from 'vitest';

import { createMigratedTestD1, type TestD1Database } from '../../test/d1';
import type { Bindings } from '../types';
import { runBackgroundWork } from './runner';

let control: TestD1Database | undefined;

afterEach(() => {
  control?.close();
  control = undefined;
});

describe('background runner', () => {
  it('makes the Control database ready before scheduled work queries it', async () => {
    control = createMigratedTestD1('control', '0000_initial.sql');

    await runBackgroundWork({ CONTROL_DB: control.binding } as Bindings);

    expect(control.rows<{ name: string }>(
      'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    )).toEqual([{ name: '0005_member_logins.sql' }]);
  });
});

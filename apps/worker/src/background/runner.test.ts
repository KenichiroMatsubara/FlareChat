import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAutomationTestApp, type AutomationTestApp } from '../../test/automation';
import { createMigratedTestD1, type TestD1Database } from '../../test/d1';
import type { Bindings } from '../types';
import { runBackgroundWork } from './runner';

let control: TestD1Database | undefined;
let fixture: AutomationTestApp | undefined;

const mailboxRequests = (): string[] => {
  const stub = globalThis.fetch as unknown as { mock: { calls: [string][] } };
  return stub.mock.calls.map(([url]) => url).filter((url) => url.includes('gmail.googleapis.com'));
};

afterEach(() => {
  control?.close();
  control = undefined;
  fixture?.close();
  fixture = undefined;
  vi.unstubAllGlobals();
});

describe('background runner', () => {
  it('makes the Control database ready before scheduled work queries it', async () => {
    control = createMigratedTestD1('control', '0000_initial.sql');

    await runBackgroundWork({ CONTROL_DB: control.binding } as Bindings);

    expect(control.rows<{ name: string }>(
      'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
    )).toEqual([{ name: '0005_member_logins.sql' }]);
  });

  it('reads an Automation Inbox that still owes this Morning its intake', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    // 2026-08-01T00:00Z is 09:00 in Tokyo; the last read was before that day's 05:00.
    fixture.account.execute("UPDATE google_connections SET last_synced_at = '2026-07-31T19:00:00.000Z'");
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ historyId: 'history-1' }), { status: 200 })));

    await runBackgroundWork(fixture.environment);

    expect(mailboxRequests().some((url) => url.includes('/history'))).toBe(true);
  });

  it('leaves an Automation Inbox unread once it has finished this Morning\'s intake', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute("UPDATE google_connections SET last_synced_at = '2026-07-31T20:00:00.000Z'");
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ historyId: 'history-1' }), { status: 200 })));

    await runBackgroundWork(fixture.environment);

    expect(mailboxRequests()).toEqual([]);
  });
});

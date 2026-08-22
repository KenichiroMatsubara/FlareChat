import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAutomationTestApp, type AutomationTestApp } from '../../test/automation';
import { createMigratedTestD1, type TestD1Database } from '../../test/d1';
import type { Bindings } from '../types';
import { DUE_WORK_CRON, MAIL_POLL_CRON, runBackgroundWork } from './runner';

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

  it('leaves the Automation Inbox unread on the frequent tick', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ historyId: 'history-1' }), { status: 200 })));

    await runBackgroundWork(fixture.environment, DUE_WORK_CRON);

    expect(mailboxRequests()).toEqual([]);
  });

  it('reads the Automation Inbox on the cron that wakes the poll', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ historyId: 'history-1' }), { status: 200 })));

    await runBackgroundWork(fixture.environment, MAIL_POLL_CRON);

    expect(mailboxRequests().some((url) => url.includes('/history'))).toBe(true);
  });
});

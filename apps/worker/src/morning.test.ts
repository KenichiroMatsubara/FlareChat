import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAutomation, INTAKE_READS_PER_TICK } from './automation';
import { keepMorningEntry, MORNING_ENTRY_ATTEMPTS } from './morning';
import { createAutomationTestApp, type AutomationTestApp } from '../test/automation';
import { invitationExtraction, memoryProviders, type MemoryProviders } from '../test/providers';
import { seedContact } from '../test/seed';

let fixture: AutomationTestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

// TEST_NOW is 09:00 on Saturday 1 August in Tokyo; its Morning was 05:00.
const MORNING = '2026-07-31T20:00:00.000Z';
const LATER_THAT_MORNING = '2026-07-31T20:30:00.000Z';
const NEXT_MORNING = '2026-08-01T20:00:00.000Z';
const HEADING = '【8/1(土)のお知らせ】';

/** One LINE-only reader named as the Rule's send-to (ADR 0166). */
const seedLineReader = (account: AutomationTestApp['account'], id = 'contact-room', destination = 'Croom-1'): void => {
  seedContact(account, { id, name: '連絡ルーム', lineDestinationId: destination });
  account.execute(
    "INSERT OR IGNORE INTO contact_lists (id, account_id, name, description, created_at, updated_at) VALUES ('notice-list-1', 'organization-1', '要約の送り先', '', '2026-08-01', '2026-08-01')",
  );
  account.execute('INSERT INTO contact_list_members (list_id, contact_id) VALUES (?, ?)', 'notice-list-1', id);
  account.execute("UPDATE rules SET notice_contact_list_id = 'notice-list-1' WHERE id = 'rule-1'");
};

const automationWith = (setup?: (providers: MemoryProviders) => void) => {
  const providers = memoryProviders();
  setup?.(providers);
  return { providers, automation: createAutomation(fixture!.environment, providers) };
};

const mail = (id: string, subject: string) => ({ id, subject, sender: 'club@example.com', body: `${subject}の本文` });

const lineSends = (providers: MemoryProviders) => providers.transport.sends.filter(({ url }) => url.includes('api.line.me'));

const lineTexts = (providers: MemoryProviders): string[][] => lineSends(providers)
  .map(({ body }) => (body as { messages: Array<{ text: string }> }).messages.map(({ text }) => text));

describe('the Morning Notice', () => {
  it('tells one address about every mail of the day in one LINE message, keeping a Delivery Record per mail', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    seedLineReader(fixture.account);
    const { automation, providers } = automationWith(({ google, ai, transport }) => {
      google.addMessage(mail('gmail-1', '総会のお知らせ'));
      google.addMessage(mail('gmail-2', '会費のお願い'));
      ai.extractions = [
        invitationExtraction({ summary: '総会を開きます。', events: [] }),
        invitationExtraction({ summary: '会費を集めます。', events: [] }),
      ];
      transport.answers.push({ match: 'api.line.me', respond: () => new Response('', { status: 200, headers: { 'x-line-request-id': 'line-morning-1' } }) });
    });

    await automation.runEnabledAccounts();

    expect(lineSends(providers)).toHaveLength(1);
    expect(lineTexts(providers)).toEqual([[[
      HEADING,
      '',
      '■ 総会のお知らせ',
      '総会を開きます。',
      '',
      '■ 会費のお願い',
      '会費を集めます。',
    ].join('\n')]]);
    const records = fixture.account.rows<{ source_message_id: string; channel: string; outcome: string; external_id: string }>(
      "SELECT source_message_id, channel, outcome, external_id FROM deliveries WHERE channel = 'line'",
    );
    expect(records).toHaveLength(2);
    expect(new Set(records.map(({ source_message_id }) => source_message_id)).size).toBe(2);
    expect(records.every(({ outcome, external_id }) => outcome === 'succeeded' && external_id === 'line-morning-1')).toBe(true);
  });

  it('speaks once a Morning, and keeps what a run by hand finds later for the next one', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    seedLineReader(fixture.account);
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(mail('gmail-1', '総会のお知らせ'));
      ai.extractions = [invitationExtraction({ summary: 'お知らせです。', events: [] })];
    });

    await automation.runEnabledAccounts();
    providers.google.addMessage(mail('gmail-2', '昼に届いたお知らせ'));
    await automation.runAccount({ accountId: 'organization-1', database: fixture.account.binding });
    await automation.runEnabledAccounts('2026-08-01T03:00:00.000Z');

    expect(lineSends(providers)).toHaveLength(1);

    await automation.runEnabledAccounts(NEXT_MORNING);

    expect(lineSends(providers)).toHaveLength(2);
    expect(lineTexts(providers)[1]?.[0]).toContain('■ 昼に届いたお知らせ');
    expect(lineTexts(providers)[1]?.[0]).not.toContain('総会のお知らせ');
  });

  it('attempts a refused Morning Notice again on later ticks and records it failed after the last attempt', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    fixture.account.execute("UPDATE google_connections SET enabled = 0");
    const { automation, providers } = automationWith(({ transport }) => { transport.lineStatus = 500; });
    await keepMorningEntry(fixture.account.binding, { channel: 'line', destination: 'Croom-1', body: '練習は中止です。' });

    for (const minutes of [0, 30, 60, 90]) {
      await automation.runEnabledAccounts(new Date(Date.parse(MORNING) + minutes * 60_000).toISOString());
    }

    expect(lineSends(providers)).toHaveLength(MORNING_ENTRY_ATTEMPTS);
    expect(fixture.account.rows<{ state: string; attempts: number }>('SELECT state, attempts FROM morning_entries'))
      .toEqual([{ state: 'failed', attempts: MORNING_ENTRY_ATTEMPTS }]);
    expect(fixture.account.rows<{ outcome: string }>('SELECT outcome FROM deliveries')).toEqual(
      Array.from({ length: MORNING_ENTRY_ATTEMPTS }, () => ({ outcome: 'failed' })),
    );
  });

  it('marks every entry of a busy address sent, however many one Morning holds', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    fixture.account.execute("UPDATE google_connections SET enabled = 0");
    const { automation, providers } = automationWith();
    for (let index = 1; index <= 150; index += 1) {
      await keepMorningEntry(fixture.account.binding, { channel: 'line', destination: 'Croom-1', body: `お知らせ${index}` });
    }

    await automation.runEnabledAccounts(MORNING);

    expect(lineSends(providers)).toHaveLength(1);
    expect(fixture.account.rows<{ state: string; count: number }>('SELECT state, count(*) AS count FROM morning_entries GROUP BY state'))
      .toEqual([{ state: 'sent', count: 150 }]);
    expect(fixture.account.rows('SELECT id FROM deliveries')).toHaveLength(150);
  });

  it('waits for an unfinished intake until 07:00, then speaks without it', async () => {
    // No AI Connection: every intake fails, as an Inbox that cannot be read does.
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    const { automation, providers } = automationWith();
    await keepMorningEntry(fixture.account.binding, { channel: 'line', destination: 'Croom-1', body: '昨日のお知らせです。' });

    await automation.runEnabledAccounts(MORNING);
    await automation.runEnabledAccounts('2026-07-31T21:30:00.000Z');

    expect(lineSends(providers)).toHaveLength(0);

    await automation.runEnabledAccounts('2026-07-31T22:00:00.000Z');

    expect(lineTexts(providers)).toEqual([[`${HEADING}\n\n昨日のお知らせです。`]]);
  });

  it('carries the reminders due that day in the same message, once', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    seedLineReader(fixture.account, 'member-1', 'Umember-1');
    fixture.account.execute("INSERT INTO settings (key, value, updated_at) VALUES ('task_reminders_enabled', 'true', '2026-08-01')");
    fixture.account.execute(
      `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES ('source-earlier', 'gmail-earlier', 'history-1', 'club@example.com', '年次行事', '2026-07-20', 'processed')`,
    );
    fixture.account.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline,
         assignee_member_id, assignee_name, description, completed, created_at, updated_at)
       VALUES ('task-1', 'organization-1', 'source-earlier', '年次行事', '参加費を振り込む', '2026-08-04', 'member-1', '連絡ルーム', '', 0, '2026-07-20', '2026-07-20')`,
    );
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(mail('gmail-1', '総会のお知らせ'));
      ai.extractions = [invitationExtraction({ summary: '総会を開きます。', events: [] })];
    });

    await automation.runEnabledAccounts();
    await automation.runEnabledAccounts('2026-08-01T00:30:00.000Z');

    expect(lineTexts(providers)).toHaveLength(1);
    expect(lineTexts(providers)[0]?.[0]).toContain('■ 総会のお知らせ');
    expect(lineTexts(providers)[0]?.[0]).toContain('【リマインド】締め切りまであと3日');
    expect(fixture.account.rows<{ idempotency_key: string | null }>('SELECT idempotency_key FROM morning_entries WHERE idempotency_key IS NOT NULL'))
      .toEqual([{ idempotency_key: 'reminder:task:task-1:member-1:3' }]);
  });

  it('does not repeat a reminder milestone the Job path already queued', async () => {
    fixture = await createAutomationTestApp({ lineSecret: 'line-secret' });
    fixture.account.execute("UPDATE google_connections SET enabled = 0");
    seedContact(fixture.account, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember-1' });
    fixture.account.execute("INSERT INTO settings (key, value, updated_at) VALUES ('task_reminders_enabled', 'true', '2026-08-01')");
    fixture.account.execute(
      `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES ('source-earlier', 'gmail-earlier', 'history-1', 'club@example.com', '年次行事', '2026-07-20', 'processed')`,
    );
    fixture.account.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline,
         assignee_member_id, assignee_name, description, completed, created_at, updated_at)
       VALUES ('task-1', 'organization-1', 'source-earlier', '年次行事', '参加費を振り込む', '2026-08-04', 'member-1', '山田花子', '', 0, '2026-07-20', '2026-07-20')`,
    );
    fixture.account.execute(
      `INSERT INTO jobs (id, kind, payload, state, attempts, available_at, idempotency_key, created_at, updated_at)
       VALUES ('job-1', 'reminder', '{}', 'succeeded', 1, '2026-07-31T21:00:00.000Z', 'reminder:task:task-1:member-1:3', '2026-07-31', '2026-07-31')`,
    );
    const { automation, providers } = automationWith();

    await automation.runEnabledAccounts();

    expect(lineSends(providers)).toHaveLength(0);
    expect(fixture.account.rows('SELECT id FROM morning_entries')).toEqual([]);
  });
});

describe('the morning intake', () => {
  it('reads no more than one invocation\'s budget and resumes from the last history record it finished', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const total = INTAKE_READS_PER_TICK + 2;
    const { automation, providers } = automationWith(({ google, ai }) => {
      for (let index = 1; index <= total; index += 1) google.addMessage(mail(`gmail-${index}`, `お知らせ${index}`));
      ai.extractions = [invitationExtraction({ summary: 'お知らせです。', events: [] })];
    });
    const inbox = () => fixture!.account.row<{ gmail_history_id: string; last_synced_at: string | null }>(
      'SELECT gmail_history_id, last_synced_at FROM google_connections',
    );

    await automation.runEnabledAccounts(MORNING);

    expect(fixture.account.rows('SELECT id FROM source_messages')).toHaveLength(INTAKE_READS_PER_TICK);
    expect(inbox()).toEqual({ gmail_history_id: `history-of-gmail-${INTAKE_READS_PER_TICK}`, last_synced_at: null });

    await automation.runEnabledAccounts(LATER_THAT_MORNING);

    expect(providers.google.mailbox.historyRequests).toEqual(['history-before-connection', `history-of-gmail-${INTAKE_READS_PER_TICK}`]);
    expect(fixture.account.rows('SELECT id FROM source_messages')).toHaveLength(total);
    expect(inbox()?.last_synced_at).not.toBeNull();
  });

  it('holds the Morning Notice until an intake the budget interrupted has finished', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    seedLineReader(fixture.account);
    const total = INTAKE_READS_PER_TICK + 1;
    const { automation, providers } = automationWith(({ google, ai }) => {
      for (let index = 1; index <= total; index += 1) google.addMessage(mail(`gmail-${index}`, `お知らせ${index}`));
      ai.extractions = [invitationExtraction({ summary: 'お知らせです。', events: [] })];
    });

    await automation.runEnabledAccounts(MORNING);

    expect(lineSends(providers)).toHaveLength(0);

    await automation.runEnabledAccounts(LATER_THAT_MORNING);

    expect(lineSends(providers)).toHaveLength(1);
    const texts = lineTexts(providers)[0] ?? [];
    expect(texts.join('\n\n').match(/■ お知らせ\d+/gu)).toHaveLength(total);
  });
});

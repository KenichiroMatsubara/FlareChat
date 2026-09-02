import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './app';
import { extractAiEventDetails, type EventDetails, type MailExtraction } from './event-details';
import { createAutomation } from './automation';
import { decodedBody, receivedAtOf, selectActiveRule, sourceAttachments, sourceAttachmentSizes } from './source';
import { createAutomationTestApp, type AutomationTestApp } from '../test/automation';
import { encrypt, masterKey, unwrapAccountKey } from './cryptography';
import { createMemoryR2, seedAttendanceRegistration, seedContact, seedScheduledEvent } from '../test/seed';
import { gmailBody, invitationExtraction, memoryProviders, type MemoryProviders } from '../test/providers';
import { AGENT_TOKEN_CEILING, MAX_AGENT_TOOL_CALLS } from './agent-runs';
import { GoogleApiError } from './providers';

let fixture: AutomationTestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

/**
 * Points a Rule's one destination setting at the given Contacts (ADR 0166).
 *
 * The Contacts are the whole configuration: there is no list of addresses to
 * keep in step with them.
 */
const seedNoticeContacts = (
  account: AutomationTestApp['account'],
  readers: Array<{ id: string; name: string; email?: string; lineDestinationId?: string }>,
): void => {
  for (const reader of readers) seedContact(account, reader);
  account.execute(
    "INSERT INTO contact_lists (id, account_id, name, description, created_at, updated_at) VALUES ('notice-list-1', 'organization-1', '要約の送り先', '', '2026-08-01', '2026-08-01')",
  );
  for (const reader of readers) {
    account.execute('INSERT INTO contact_list_members (list_id, contact_id) VALUES (?, ?)', 'notice-list-1', reader.id);
  }
  account.execute("UPDATE rules SET notice_contact_list_id = 'notice-list-1' WHERE id = 'rule-1'");
};

/** An Automation built on in-memory providers, with one dated Source Message waiting in Gmail unless told otherwise. */
const automationWith = (setup?: (providers: MemoryProviders) => void) => {
  const providers = memoryProviders();
  setup?.(providers);
  return { providers, automation: createAutomation(fixture!.environment, providers) };
};

const runAccount = (automation: ReturnType<typeof createAutomation>) =>
  automation.runAccount({ accountId: 'organization-1', database: fixture!.account.binding });

const invitation = (id: string, overrides: { subject?: string; sender?: string; body?: string } = {}) => ({
  id,
  subject: overrides.subject ?? '例会のお知らせ',
  sender: overrides.sender ?? 'member@example.com',
  body: overrides.body ?? '日時: 2026年8月3日 19:00〜21:30',
});

const lineSends = (providers: MemoryProviders) => providers.transport.sends.filter(({ url }) => url.includes('api.line.me'));

const inboxHealth = (): { status: string; last_error: string | null; failing_since: string | null; alerted_at: string | null } | null =>
  fixture?.account.row<{ status: string; last_error: string | null; failing_since: string | null; alerted_at: string | null }>(
    "SELECT status, last_error, failing_since, alerted_at FROM google_connections WHERE kind = 'automation_inbox'",
  ) ?? null;

describe('Source Message processing primitives', () => {
  it('selects the highest-priority matching active Automation Rule', () => {
    const rules = [
      { id: 'low', revision: 1, priority: 1, executionMode: 'unattended' as const, selectionPolicy: {} },
      { id: 'domain', revision: 1, priority: 5, executionMode: 'unattended' as const, selectionPolicy: { domain: 'example.com' } },
      { id: 'other', revision: 1, priority: 9, executionMode: 'unattended' as const, selectionPolicy: { sender: 'other@example.org' } },
    ];
    expect(selectActiveRule(rules, { sender: 'member@example.com', subject: '例会', body: '本文' })?.id).toBe('domain');
    expect(selectActiveRule(rules, { sender: 'someone@example.org', subject: '例会', body: '本文' })?.id).toBe('low');
  });

  it('reads a multipart/alternative body once instead of sending both representations', () => {
    expect(decodedBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: gmailBody('本文') } },
        { mimeType: 'text/html', body: { data: gmailBody('<p>本文</p>') } },
      ],
    })).toBe('本文');
  });

  it('falls back to the HTML representation when Gmail supplies no plain text', () => {
    expect(decodedBody({
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/html', body: { data: gmailBody('<p>本文</p>') } }],
    })).toBe('本文');
  });

  it('states the Gmail delivery time in the time zone this product schedules in', () => {
    expect(receivedAtOf('1775520720000')).toBe('2026-04-07T09:12:00+09:00');
    expect(receivedAtOf(undefined)).toBeUndefined();
    expect(receivedAtOf('not-a-number')).toBeUndefined();
  });

  it('counts and retains only attached file parts', () => {
    const payload = {
      body: { data: gmailBody('本文'), size: 4 },
      parts: [
        { mimeType: 'text/plain', body: { data: gmailBody('本文'), size: 4 } },
        { filename: 'agenda.pdf', mimeType: 'application/pdf', body: { attachmentId: 'attachment-1', size: 9 } },
      ],
    };
    expect(sourceAttachmentSizes(payload)).toEqual([9]);
    expect(sourceAttachments(payload)).toEqual([{ attachmentId: 'attachment-1', filename: 'agenda.pdf', mimeType: 'application/pdf', size: 9 }]);
  });
});

describe('Account Automation Inbox scheduling', () => {
  it('ignores a message sent by the Automation Inbox and still advances Gmail history', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedContact(fixture.account, { id: 'member-1', name: '一郎', email: 'member@example.com' });
    const { automation, providers } = automationWith(({ google }) => {
      google.mailbox.historyId = 'history-after-sent-reply';
      google.addMessage({
        ...invitation('sent-reply', { subject: 'Re: Volunteer activity', body: '説明会は2026年8月5日19:30から20:30です。', sender: '"Automation Inbox" <automation@example.com>' }),
        labelIds: ['SENT'],
      });
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 0, created: 0, skipped: 0, exceptions: 0 });

    expect(providers.ai.extractionRequests).toEqual([]);
    expect(providers.google.eventWrites).toEqual([]);
    expect(fixture.account.rows('SELECT * FROM source_messages')).toEqual([]);
    expect(fixture.account.row<{ gmail_history_id: string }>(
      "SELECT gmail_history_id FROM google_connections WHERE kind = 'automation_inbox'",
    )).toEqual({ gmail_history_id: 'history-after-sent-reply' });
  });

  it('ignores promotions and calendar transport before Source Message or AI work', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation, providers } = automationWith(({ google }) => {
      google.mailbox.historyId = 'history-after-ignored-mail';
      google.addMessage({
        ...invitation('promotion-message', { subject: '7月29日開催 特別ご招待', body: '期間限定キャンペーンです。' }),
        labelIds: ['CATEGORY_PROMOTIONS', 'INBOX'],
      });
      google.addMessage({
        id: 'calendar-message',
        labelIds: ['CATEGORY_PERSONAL', 'INBOX'],
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'Subject', value: '招待: 地区大会' },
            { name: 'From', value: 'organizer@example.com' },
          ],
          parts: [{ filename: 'invite.ics', mimeType: 'text/calendar', body: { data: gmailBody('BEGIN:VCALENDAR') } }],
        },
      });
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 0, created: 0, skipped: 0, exceptions: 0 });

    expect(providers.ai.extractionRequests).toEqual([]);
    expect(fixture.account.rows('SELECT * FROM source_messages')).toEqual([]);
    expect(fixture.account.row<{ gmail_history_id: string }>(
      "SELECT gmail_history_id FROM google_connections WHERE kind = 'automation_inbox'",
    )).toEqual({ gmail_history_id: 'history-after-ignored-mail' });
  });

  it('repairs a rule-less Account with a catch-all Schema Rule and sends ordinary mail through AI', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute('DELETE FROM rules');
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('ordinary-message', { subject: '次回例会について', body: '詳細は添付の案内をご確認ください。' }));
      ai.extractions = [invitationExtraction({
        summary: '次回例会の案内です。',
        events: [{ title: '次回例会', startsAt: '2026-08-10T19:00:00+09:00', endsAt: '2026-08-10T21:00:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '詳細は案内を参照', summary: '次回例会' }],
      })];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 1, skipped: 0, exceptions: 0 });

    expect(providers.ai.extractionRequests).toHaveLength(1);
    expect(fixture.account.rows<{ name: string; status: string }>('SELECT name, status FROM rules')).toEqual([
      { name: 'All incoming mail', status: 'active' },
    ]);
  });

  it('keeps selective rules while adding a lower-priority catch-all for otherwise unmatched mail', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute("UPDATE rules SET selection_policy = '{\"sender\":\"trusted@example.com\"}' WHERE id = 'rule-1'");
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('unmatched-ordinary-message', { subject: '一般のお知らせ', body: '今月のお知らせです。' }));
      ai.extractions = [invitationExtraction({ summary: '今月のお知らせです。', events: [] })];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(providers.ai.extractionRequests).toHaveLength(1);
    expect(fixture.account.rows<{ name: string; priority: number }>(
      'SELECT name, priority FROM rules ORDER BY priority DESC',
    )).toEqual([
      { name: 'All dated Source Messages', priority: 0 },
      { name: 'All incoming mail', priority: -1 },
    ]);
  });

  it('reprocesses messages that legacy Automation previously marked as skipped', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute(
      `INSERT INTO source_messages
        (id, gmail_message_id, gmail_history_id, sender, subject, received_at, processed_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped')`,
      'source-previously-skipped', 'previously-skipped-message', 'history-before-connection', 'member@example.com',
      '会員向けのお知らせ', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
    );
    const { automation } = automationWith(({ google, ai }) => {
      google.mailbox.historyId = 'history-after-repair';
      google.mailbox.messages.set('previously-skipped-message', invitation('previously-skipped-message', { subject: '会員向けのお知らせ', body: '今月のお知らせです。' }));
      ai.extractions = [invitationExtraction({ summary: '今月のお知らせです。', events: [] })];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(fixture.account.row<{ state: string }>(
      "SELECT state FROM source_messages WHERE id = 'source-previously-skipped'",
    )).toEqual({ state: 'processed' });
    const baseline = fixture.account.row<{ value: string }>("SELECT value FROM settings WHERE key = 'baseline-schema-rule:v1'");
    expect(JSON.parse(baseline?.value ?? '{}')).toMatchObject({ repairSkipped: false });
  });

  it('does not silently use literal date parsing when an AI Connection is missing', async () => {
    fixture = await createAutomationTestApp();
    const { automation, providers } = automationWith(({ google }) => {
      google.addMessage(invitation('dated-message-without-ai'));
    });

    await expect(runAccount(automation)).rejects.toThrow('自動化を実行する前に OpenAI 互換 API を設定してください。');
    await automation.runEnabledAccounts();
    expect(providers.google.mailbox.historyRequests).toEqual([]);
    expect(fixture.account.rows('SELECT * FROM source_messages')).toEqual([]);
    expect(inboxHealth()).toMatchObject({
      status: 'active',
      last_error: '自動化を実行する前に OpenAI 互換 API を設定してください。',
    });
  });

  it('continues past a Gmail history entry whose message was deleted and persists the new boundary', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation } = automationWith(({ google, ai }) => {
      google.mailbox.historyId = 'history-after-deleted-message';
      google.addMessage(invitation('deleted-message'));
      google.mailbox.missing.add('deleted-message');
      google.addMessage(invitation('ordinary-message-after-delete', { subject: '会員向けのお知らせ', body: '今月のお知らせです。' }));
      ai.extractions = [invitationExtraction({ summary: '今月のお知らせです。', events: [] })];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(fixture.account.row<{ gmail_history_id: string }>(
      "SELECT gmail_history_id FROM google_connections WHERE kind = 'automation_inbox'",
    )).toEqual({ gmail_history_id: 'history-after-deleted-message' });
  });

  const seedAgentRule = async (input: {
    name: string;
    executionMode?: 'read_only' | 'approval' | 'unattended';
    selectionPolicy?: Record<string, unknown>;
    lineDestinations?: string[];
    recipientDestinations?: string[];
    instructions?: string;
  }): Promise<{ agentRuleId: string; promptId: string }> => {
    const lists: Record<string, string[]> = {};
    for (const [kind, values] of [['line', input.lineDestinations], ['recipient', input.recipientDestinations]] as const) {
      if (!values) continue;
      const list = await app.fetch(fixture!.jsonRequest('/api/organizations/organization-1/lists', { kind, name: `${input.name} ${kind}` }), fixture!.environment);
      const listId = (await list.json() as { data: { id: string } }).data.id;
      for (const value of values) {
        await app.fetch(fixture!.jsonRequest(`/api/organizations/organization-1/lists/${listId}/items`, { value, label: value }), fixture!.environment);
      }
      lists[kind] = [listId];
    }
    const prompt = await app.fetch(fixture!.jsonRequest('/api/organizations/organization-1/prompts', { name: input.name, instructions: input.instructions ?? 'Act.' }), fixture!.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;
    const created = await app.fetch(fixture!.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: input.name,
      promptId,
      state: 'active',
      executionMode: input.executionMode ?? 'unattended',
      selectionPolicy: input.selectionPolicy ?? {},
      ...(lists.line ? { permittedLineListIds: lists.line } : {}),
      ...(lists.recipient ? { permittedRecipientListIds: lists.recipient } : {}),
    }), fixture!.environment);
    expect(created.status).toBe(201);
    return { agentRuleId: (await created.json() as { data: { id: string } }).data.id, promptId };
  };

  const toolCall = (name: 'send_line_message' | 'create_scheduled_event' | 'send_email_summary' | 'read_source_message' | 'query_scheduled_events' | 'query_tasks' | 'query_attendance', args: Record<string, unknown> = {}) =>
    ({ id: `${name}-${crypto.randomUUID()}`, name, arguments: JSON.stringify(args) });

  it('executes an unattended Agent Rule LINE write once and records a failed delivery without retry work', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    fixture.account.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    await seedAgentRule({ name: 'Writer', lineDestinations: ['line-user-1'], instructions: 'Notify.' });
    const { automation, providers } = automationWith(({ google, ai, transport }) => {
      google.addMessage(invitation('gmail-write', { subject: 'Notice', body: 'Moved.' }));
      ai.agentTurns = [
        { model: 'test-model', content: '', toolCalls: [toolCall('send_line_message', { destination: 'line-user-1', message: 'Practice moved.' })], totalTokens: 10 },
        { model: 'test-model', content: 'done', toolCalls: [], totalTokens: 5 },
      ];
      transport.lineStatus = 429;
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(lineSends(providers)).toHaveLength(1);
    expect(fixture.account.rows<{ destination: string; outcome: string }>('SELECT destination, outcome FROM deliveries')).toEqual([{ destination: 'line-user-1', outcome: 'failed' }]);
    expect(fixture.account.rows('SELECT * FROM jobs')).toHaveLength(0);
    const run = fixture.account.row<{ id: string }>('SELECT id FROM agent_runs')!;
    const transcript = await app.fetch(fixture.request(`/api/organizations/organization-1/agent-runs/${run.id}/transcript`), fixture.environment);
    const transcriptText = await transcript.text();
    expect(transcriptText).toContain('line-user-1');
    expect(transcriptText).toContain('planned');
    await expect(runAccount(automation)).resolves.toEqual({ scanned: 0, created: 0, skipped: 0, exceptions: 0 });
    expect(lineSends(providers)).toHaveLength(1);
  });

  it('approves one frozen Rule Run batch without invoking the Agent again', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    fixture.account.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    await seedAgentRule({ name: 'Approver', executionMode: 'approval', lineDestinations: ['line-user-1'], instructions: 'Propose.' });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-approval', { subject: 'Notice', body: 'Review.' }));
      ai.agentTurns = [
        { model: 'test-model', content: '', toolCalls: [toolCall('send_line_message', { destination: 'line-user-1', message: 'Exact approved text' })], totalTokens: 10 },
        { model: 'test-model', content: 'Proposal recorded.', toolCalls: [], totalTokens: 5 },
      ];
    });
    // The approval route reaches LINE through the production transport.
    const linePush = vi.fn().mockResolvedValue(new Response('', { status: 200, headers: { 'x-line-request-id': 'line-approved' } }));
    vi.stubGlobal('fetch', linePush);

    await runAccount(automation);
    expect(lineSends(providers)).toHaveLength(0);
    expect(linePush).not.toHaveBeenCalled();
    const run = fixture.account.row<{ id: string }>('SELECT id FROM rule_runs')!;
    const runResponse = await app.fetch(fixture.request(`/api/organizations/organization-1/rule-runs/${run.id}`), fixture.environment);
    await expect(runResponse.json()).resolves.toMatchObject({ data: {
      sourceMessage: { subject: 'Notice', sender: 'member@example.com' },
      status: 'pending_approval',
      effects: [{ kind: 'agent.send_line_message', arguments: { destination: 'line-user-1', message: 'Exact approved text' }, status: 'pending' }],
    } });

    const approved = await app.fetch(fixture.jsonRequest(`/api/organizations/organization-1/rule-runs/${run.id}/decision`, { decision: 'approve' }), fixture.environment);

    expect(approved.status).toBe(200);
    expect(linePush).toHaveBeenCalledTimes(1);
    expect(providers.ai.agentRequests).toHaveLength(2);
    expect(fixture.account.rows<{ destination: string; outcome: string }>('SELECT destination, outcome FROM deliveries')).toEqual([{ destination: 'line-user-1', outcome: 'succeeded' }]);
  });

  it('creates a Scheduled Event only for a permitted recipient destination in unattended mode', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    const { agentRuleId } = await seedAgentRule({ name: 'Scheduler', recipientDestinations: ['guest@example.com'], instructions: 'Schedule.' });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-event-write', { subject: 'Practice', body: 'Schedule.' }));
      ai.agentTurns = [
        { model: 'test-model', content: '', totalTokens: 10, toolCalls: [toolCall('create_scheduled_event', {
          destination: 'guest@example.com', title: 'Practice', startsAt: '2026-08-10T09:00:00+09:00', endsAt: '2026-08-10T10:00:00+09:00',
        })] },
        { model: 'test-model', content: 'done', toolCalls: [], totalTokens: 5 },
      ];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 1, skipped: 0, exceptions: 0 });
    expect(providers.google.eventWrites).toMatchObject([{ operation: 'create', body: { summary: 'Practice', attendees: [{ email: 'guest@example.com' }] } }]);
    expect(fixture.account.rows<{ agent_rule_id: string; title: string; status: string }>('SELECT agent_rule_id, title, status FROM events')).toEqual([{ agent_rule_id: agentRuleId, title: 'Practice', status: 'scheduled' }]);
    expect(fixture.account.rows<{ destination: string; outcome: string }>('SELECT destination, outcome FROM deliveries')).toEqual([{ destination: 'guest@example.com', outcome: 'succeeded' }]);
  });

  it('runs each matching read-only Agent Rule once with only Account query tools', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    fixture.account.execute(
      "INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-existing', 'gmail-existing', 'history-existing', 'member@example.com', '既存行事', '2026-08-01', 'processed')",
    );
    seedScheduledEvent(fixture.account, { id: 'event-existing', title: '既存行事' });
    seedAttendanceRegistration(fixture.account, {
      eventId: 'event-existing', contactId: 'recipient-existing', destination: 'reader@example.com', status: 'attending',
    });
    fixture.account.execute(
      "INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_name, description, created_at, updated_at) VALUES ('task-existing', 'organization-1', 'source-existing', '既存行事', '資料確認', '2026-08-10', '未割り当て', '資料を確認する', '2026-08-01', '2026-08-01')",
    );
    await seedAgentRule({ name: 'Example.com analyst', executionMode: 'read_only', selectionPolicy: { domain: 'example.com' }, instructions: 'Inspect the Source Message and Account records.' });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-agent'));
      ai.agentTurns = [
        { model: 'test-model', content: '', totalTokens: 400, toolCalls: [
          toolCall('read_source_message'), toolCall('query_scheduled_events'), toolCall('query_tasks'), toolCall('query_attendance'),
        ] },
        { model: 'test-model', content: 'Read-only review complete.', toolCalls: [], totalTokens: 120 },
      ];
      ai.extractions = [invitationExtraction({ events: [] })];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(providers.ai.agentRequests).toHaveLength(2);
    expect(providers.ai.agentRequests[0]?.tools.map((tool) => tool.function.name)).toEqual(['read_source_message', 'query_scheduled_events', 'query_tasks', 'query_attendance']);
    const toolResults = providers.ai.agentRequests[1]?.messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n') ?? '';
    expect(toolResults).toContain('例会のお知らせ');
    expect(toolResults).toContain('既存行事');
    expect(toolResults).toContain('資料確認');
    expect(toolResults).toContain('attending');
    expect(providers.google.eventWrites).toEqual([]);
  });

  it('fetches and converts one Source Message once for its Primary Schema Rule and every matching Agent Rule', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    for (const suffix of ['one', 'two']) {
      await seedAgentRule({ name: `Agent ${suffix}`, selectionPolicy: { domain: 'example.com' }, instructions: `Review ${suffix}.` });
    }
    const toMarkdown = vi.fn(async () => ({ format: 'markdown' as const, name: 'agenda.pdf', mimetype: 'application/pdf', tokens: 4, data: 'Converted agenda' }));
    fixture.environment.AI = { toMarkdown };
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage({ ...invitation('gmail-shared'), attachments: [{ filename: 'agenda.pdf', mimeType: 'application/pdf', data: btoa('agenda') }] });
      ai.extract = vi.fn(async (input) => extractAiEventDetails({
        ...input,
        fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({
          summary: '例会です。',
          events: [{ title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '例会です' }],
          tasks: [],
        }) } }] }),
      }));
      ai.agentTurns = [(request) => request.messages.some((message) => message.role === 'tool')
        ? { model: 'test-model', content: 'Reviewed.', toolCalls: [], totalTokens: 20 }
        : { model: 'test-model', content: '', toolCalls: [toolCall('read_source_message')], totalTokens: 20 }];
    });
    const readAttachments = vi.spyOn(providers.google.gmail, 'readAttachments');
    const readMessage = vi.spyOn(providers.google.gmail, 'readMessage');

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 1, skipped: 0, exceptions: 0 });
    expect(readMessage).toHaveBeenCalledTimes(1);
    expect(readAttachments).toHaveBeenCalledTimes(1);
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    expect(providers.ai.extract).toHaveBeenCalledTimes(1);
    expect(providers.ai.agentRequests).toHaveLength(4);
    expect(providers.ai.agentRequests.flatMap((request) => request.messages).filter((message) => message.role === 'tool').map((message) => message.content).join('\n'))
      .toContain('Converted agenda');
    expect(providers.google.drive.files.map(({ filename }) => filename)).toEqual(['agenda.pdf']);
    const runs = await app.fetch(fixture.request('/api/organizations/organization-1/agent-runs'), fixture.environment);
    const runsBody = await runs.json() as { data: Array<{ id: string }> };
    expect(runsBody.data).toHaveLength(2);
    const transcript = await app.fetch(fixture.request(`/api/organizations/organization-1/agent-runs/${runsBody.data[0]?.id}/transcript`), fixture.environment);
    await expect(transcript.json()).resolves.toMatchObject({ data: { source: {
      attachments: [{ filename: 'agenda.pdf', text: 'Converted agenda' }],
    } } });
  });

  it('turns an Agent Rule tool-call limit failure into one non-retried Automation Exception', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    await seedAgentRule({ name: 'Bounded Agent', instructions: 'Inspect the Source Message.' });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-bounded', { subject: 'お知らせ', body: '確認してください。' }));
      ai.agentTurns = [{
        model: 'test-model', content: '', totalTokens: 10,
        toolCalls: Array.from({ length: MAX_AGENT_TOOL_CALLS + 1 }, () => toolCall('read_source_message')),
      }];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 1 });
    await expect(runAccount(automation)).resolves.toEqual({ scanned: 0, created: 0, skipped: 0, exceptions: 0 });
    const exceptions = await app.fetch(fixture.request('/api/organizations/organization-1/operations/exceptions'), fixture.environment);
    await expect(exceptions.json()).resolves.toMatchObject({ data: [{
      code: 'agent_rule_run_failed',
      message: `Agent Rule tool-call maximum of ${MAX_AGENT_TOOL_CALLS} was exceeded.`,
      state: 'open',
    }] });
    const runs = await app.fetch(fixture.request('/api/organizations/organization-1/agent-runs'), fixture.environment);
    const runsBody = await runs.json() as { data: Array<{ id: string }> };
    expect(runsBody).toMatchObject({ data: [{ outcome: 'failed', toolCallCount: MAX_AGENT_TOOL_CALLS + 1, tokens: 10 }] });
    const transcript = await app.fetch(fixture.request(`/api/organizations/organization-1/agent-runs/${runsBody.data[0]?.id}/transcript`), fixture.environment);
    await expect(transcript.json()).resolves.toMatchObject({ data: { error: `Agent Rule tool-call maximum of ${MAX_AGENT_TOOL_CALLS} was exceeded.` } });
    expect(providers.ai.agentRequests).toHaveLength(1);
  });

  it('stops an Agent Rule at its token ceiling', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    await seedAgentRule({ name: 'Talkative Agent' });
    const { automation } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-ceiling'));
      ai.agentTurns = [{ model: 'test-model', content: '', totalTokens: AGENT_TOKEN_CEILING + 1, toolCalls: [toolCall('read_source_message')] }];
    });

    await expect(runAccount(automation)).resolves.toMatchObject({ exceptions: 1 });
    expect(fixture.account.rows<{ message: string }>('SELECT message FROM exceptions')).toEqual([{ message: `Agent Rule token ceiling of ${AGENT_TOKEN_CEILING} was exceeded.` }]);
  });

  it('indexes every Agent Rule run in D1 and exposes its encrypted R2 Run Transcript', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    const r2 = createMemoryR2();
    fixture.environment.RECOVERY_RECEIPTS = r2.bucket;
    const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', {
      name: 'Transcript analyst', instructions: 'Explain what you read.',
    }), fixture.environment);
    const promptBody = await prompt.json() as { data: { id: string; revision: number } };
    await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/prompts/${promptBody.data.id}`,
      { instructions: 'Explain the current Source Message carefully.' },
      'PATCH',
    ), fixture.environment);
    const agentRule = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: 'Transcript Agent', promptId: promptBody.data.id, state: 'active', selectionPolicy: {},
    }), fixture.environment);
    const agentRuleId = (await agentRule.json() as { data: { id: string } }).data.id;
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-transcript', { subject: 'Confidential notice', body: 'Secret Source Message body' }));
      ai.agentTurns = [{ model: 'audited-model', content: 'No action required.', toolCalls: [], totalTokens: 321 }];
    });

    await runAccount(automation);
    expect(providers.ai.agentRequests[0]?.messages[0]?.content).toContain('Explain the current Source Message carefully.');
    const runs = await app.fetch(fixture.request('/api/organizations/organization-1/agent-runs'), fixture.environment);
    const runsBody = await runs.json() as { data: Array<{ id: string }> };
    const transcript = await app.fetch(fixture.request(`/api/organizations/organization-1/agent-runs/${runsBody.data[0]?.id}/transcript`), fixture.environment);

    expect(runs.status).toBe(200);
    expect(runsBody).toMatchObject({ data: [{
      agentRuleId,
      promptId: promptBody.data.id,
      promptRevision: 2,
      model: 'audited-model',
      outcome: 'succeeded',
      toolCallCount: 0,
      tokens: 321,
      expiresAt: expect.any(String),
    }] });
    expect(transcript.status).toBe(200);
    await expect(transcript.json()).resolves.toMatchObject({ data: {
      source: { subject: 'Confidential notice', body: 'Secret Source Message body' },
      finalOutput: 'No action required.',
    } });
    expect(r2.keys()).toHaveLength(1);
    expect(r2.object(r2.keys()[0]!) ?? '').not.toContain('Secret Source Message body');
  });

  it('keeps events and tasks when the extraction names a Contact this Account does not hold, and raises an Automation Warning', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const createdContact = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/members', {
      name: '山田花子', email: 'hanako@example.com', description: '出欠と申込期限を見ている人',
    }), fixture.environment);
    expect(createdContact.status).toBe(201);
    const contact = (await createdContact.json() as { data: { id: string } }).data;
    const { automation } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-warning'));
      ai.extractions = [invitationExtraction({
        summary: '例会と二つの期限の案内です。',
        tasks: [
          { title: '出席登録を確認する', deadline: '2026-07-31', assigneeContactId: contact.id, description: '登録状況を確認する' },
          { title: '資料を確認する', deadline: '2026-08-01', assigneeContactId: 'unassigned', description: '資料を確認する' },
        ],
        warnings: [{ code: 'task_assignee_unmatched', requestedContactId: 'removed-contact', message: 'The extraction named a Contact this Account does not hold.' }],
      })];
    });

    await automation.runEnabledAccounts();

    const tasks = await app.fetch(fixture.request('/api/organizations/organization-1/tasks'), fixture.environment);
    await expect(tasks.json()).resolves.toMatchObject({ data: [
      { assigneeContactId: contact.id, assigneeName: '山田花子' },
      { assigneeContactId: null, assigneeName: '未割り当て' },
    ] });
    const unassignedTasks = await app.fetch(fixture.request('/api/organizations/organization-1/tasks?assignee=unassigned'), fixture.environment);
    await expect(unassignedTasks.json()).resolves.toMatchObject({ data: [{ title: '資料を確認する', assigneeContactId: null }] });
    const warnings = await app.fetch(fixture.request('/api/organizations/organization-1/automation-warnings'), fixture.environment);
    expect(warnings.status).toBe(200);
    await expect(warnings.json()).resolves.toMatchObject({ data: [{ code: 'task_assignee_unmatched' }] });
    const dashboard = await app.fetch(fixture.request('/api/organizations/organization-1/dashboard'), fixture.environment);
    await expect(dashboard.json()).resolves.toMatchObject({ data: { upcomingEvents: 1 } });
  });

  it('creates one named Task from a Source Message and does not duplicate it when the inbox run is retried', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const createdContact = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/members', {
      name: '山田花子', email: 'hanako@example.com', description: '出欠と申込期限を見ている人',
    }), fixture.environment);
    const contactId = (await createdContact.json() as { data: { id: string } }).data.id;
    const { automation } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-task-1'));
      ai.extractions = [invitationExtraction({
        tasks: [{ title: '出席を取りまとめる', deadline: '2026-07-31', assigneeContactId: contactId, description: '出席登録を確認する' }],
      })];
    });

    await automation.runEnabledAccounts();
    await automation.runEnabledAccounts();
    const response = await app.fetch(fixture.request('/api/organizations/organization-1/tasks'), fixture.environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [{
        title: '出席を取りまとめる',
        deadline: '2026-07-31',
        assigneeName: '山田花子',
        completed: false,
        sourceMessageSubject: '例会のお知らせ',
      }],
    });
    expect(fixture.account.rows('SELECT id FROM tasks')).toHaveLength(1);
  });

  it('creates a Scheduled Event through the Automation interface with an injected Google adapter', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-port'));
      ai.extractions = [invitationExtraction()];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 1, skipped: 0, exceptions: 0 });
    const dashboard = await app.fetch(fixture.request('/api/organizations/organization-1/dashboard'), fixture.environment);
    await expect(dashboard.json()).resolves.toMatchObject({ data: { upcomingEvents: 1 } });
    expect(fixture.account.rows<{ status: string; execution_mode: string }>('SELECT status, execution_mode FROM rule_runs'))
      .toEqual([{ status: 'completed', execution_mode: 'unattended' }]);
    expect(fixture.account.rows<{ state: string }>('SELECT state FROM source_messages')).toEqual([{ state: 'processed' }]);
  });

  it.each([
    ['read_only', 'read_only', 'planned'],
    ['approval', 'pending_approval', 'pending'],
  ] as const)('plans a Schema Rule in %s mode without business mutations', async (executionMode, runStatus, effectStatus) => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute('UPDATE rules SET execution_mode = ? WHERE id = ?', executionMode, 'rule-1');
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation(`gmail-${executionMode}`, { subject: '例会', body: '日時: 2026年8月3日 19:00〜21:00' }));
      ai.extractions = [invitationExtraction({
        summary: '例会です。',
        tasks: [{ title: '準備', deadline: '2026-08-02', assigneeContactId: 'unassigned', description: '準備する' }],
      })];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });

    expect(providers.google.eventWrites).toEqual([]);
    expect(fixture.account.rows('SELECT * FROM events')).toHaveLength(0);
    expect(fixture.account.rows('SELECT * FROM tasks')).toHaveLength(0);
    expect(fixture.account.rows<{ status: string }>('SELECT status FROM rule_runs')).toEqual([{ status: runStatus }]);
    const effects = fixture.account.rows<{ kind: string; status: string }>('SELECT kind, status FROM rule_effects ORDER BY created_at, kind');
    expect(effects.map(({ kind }) => kind).sort()).toEqual(['schema.apply_events', 'schema.create_tasks', 'schema.deliver_summary']);
    expect(effects.every(({ status }) => status === effectStatus)).toBe(true);
    expect(fixture.account.rows<{ state: string }>('SELECT state FROM source_messages')).toEqual([{ state: 'processed' }]);
  });

  const meetingExtraction = (overrides: Partial<MailExtraction> = {}): MailExtraction => invitationExtraction({
    events: [{
      title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00',
      timeZone: 'Asia/Tokyo', location: '本部会館', description: '例会です。', summary: '毎月の例会です。',
    }],
    ...overrides,
  });

  /** Two runs about the same meeting: the first creates it, the second is told it already exists. */
  const upsertFixture = (extractions: MailExtraction[]) => {
    const { automation, providers } = automationWith(({ ai }) => {
      ai.correspondences = [[{ candidateIndex: 0, eventId: 'calendar-event-1' }]];
    });
    const runOnce = async (index: number) => {
      providers.google.mailbox.inbox = [];
      providers.google.addMessage(invitation(`gmail-message-upsert-${index}`, { sender: 'chair@example.com', body: '日時: 2026年8月3日 19:00〜21:00' }));
      providers.google.mailbox.historyId = `history-${index}`;
      providers.ai.extractions = [extractions[index]!];
      return runAccount(automation);
    };
    return { providers, runOnce };
  };

  it('merges a later message about the same meeting instead of creating a second Scheduled Event', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { providers, runOnce } = upsertFixture([
      meetingExtraction(),
      meetingExtraction({
        summary: '会場が変わりました。',
        events: [{
          title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00',
          timeZone: 'Asia/Tokyo', location: '市民ホール', description: '例会です。', summary: '会場が変わりました。',
        }],
      }),
    ]);

    await runOnce(0);
    await runOnce(1);

    const created = providers.google.eventWrites.filter(({ operation }) => operation === 'create');
    const patched = providers.google.eventWrites.filter(({ operation }) => operation === 'patch');
    expect(created).toHaveLength(1);
    expect(patched).toHaveLength(1);
    expect(patched[0]?.body.location).toBe('市民ホール');
    expect(fixture.account.rows('SELECT count(*) AS total FROM events')).toEqual([{ total: 1 }]);
  });

  it('records the guests an Event Response returned without creating a Scheduled Event for it', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { providers, runOnce } = upsertFixture([
      meetingExtraction(),
      meetingExtraction({
        kind: 'response',
        summary: '北クラブから2名の参加申込です。',
        guests: [
          { name: '山田太郎', affiliation: '北クラブ', attending: true },
          { name: '鈴木花子', affiliation: '北クラブ', attending: true },
        ],
      }),
    ]);

    await runOnce(0);
    await runOnce(1);

    const patched = providers.google.eventWrites.filter(({ operation }) => operation === 'patch');
    expect(providers.google.eventWrites.filter(({ operation }) => operation === 'create')).toHaveLength(1);
    expect(fixture.account.rows('SELECT count(*) AS total FROM events')).toEqual([{ total: 1 }]);
    expect(fixture.account.rows('SELECT name, affiliation FROM guest_registrations ORDER BY name')).toEqual([
      { name: '山田太郎', affiliation: '北クラブ' },
      { name: '鈴木花子', affiliation: '北クラブ' },
    ]);
    expect(String(patched[0]?.body.description)).toContain('外部からの参加登録: 1団体 2名（北クラブ 2名）');
    expect(String(patched[0]?.body.description)).not.toContain('山田太郎');
  });

  it('creates nothing for an Event Response that locates no Scheduled Event', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { providers, runOnce } = upsertFixture([meetingExtraction({ kind: 'response', summary: 'OKです。' })]);

    await expect(runOnce(0)).resolves.toMatchObject({ created: 0, exceptions: 0 });
    expect(providers.google.eventWrites).toEqual([]);
    expect(fixture.account.rows('SELECT count(*) AS total FROM events')).toEqual([{ total: 0 }]);
  });

  it('runs an Automation Inbox only after an authorized member enables it', async () => {
    fixture = await createAutomationTestApp({ enabled: false, ai: true });
    const { automation, providers } = automationWith();

    await automation.runEnabledAccounts();
    const enabled = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/automation/enabled', { enabled: true }), fixture.environment);
    await automation.runEnabledAccounts();

    expect(enabled.status).toBe(200);
    expect(providers.google.mailbox.historyRequests).toHaveLength(1);
  });

  it('resumes each Gmail read from the last successfully persisted history boundary', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation, providers } = automationWith(({ google }) => { google.mailbox.historyId = 'history-after-first-run'; });

    await automation.runEnabledAccounts();
    providers.google.mailbox.historyId = 'history-after-second-run';
    await automation.runEnabledAccounts();

    expect(providers.google.mailbox.historyRequests).toEqual(['history-before-connection', 'history-after-first-run']);
    const status = await app.fetch(fixture.request('/api/organizations/organization-1/automation'), fixture.environment);
    await expect(status.json()).resolves.toMatchObject({ data: { email: 'automation@example.com', lastError: null } });
  });

  it('re-anchors a Gmail cursor Gmail no longer recognises instead of failing every later run', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation, providers } = automationWith(({ google }) => {
      google.mailbox.historyExpired = true;
      google.mailbox.historyId = 'history-current';
    });

    await automation.runEnabledAccounts();
    providers.google.mailbox.historyExpired = false;
    providers.google.mailbox.historyId = 'history-after-recovery';
    await automation.runEnabledAccounts();

    expect(providers.google.mailbox.historyRequests).toEqual(['history-before-connection', 'history-current']);
    const status = await app.fetch(fixture.request('/api/organizations/organization-1/automation'), fixture.environment);
    await expect(status.json()).resolves.toMatchObject({ data: { email: 'automation@example.com', lastError: null } });
  });

  it('turns one newly discovered dated Source Message into one upcoming Scheduled Event', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-1'));
      ai.extractions = [invitationExtraction()];
    });

    await automation.runEnabledAccounts();

    expect(providers.google.eventWrites).toMatchObject([{ operation: 'create', body: { summary: '例会' } }]);
    const dashboard = await app.fetch(fixture.request('/api/organizations/organization-1/dashboard'), fixture.environment);
    await expect(dashboard.json()).resolves.toMatchObject({ data: { upcomingEvents: 1, exceptions: 0 } });
  });

  it('invites every active Contact of the roster to the Scheduled Event it creates', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedContact(fixture.account, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    seedContact(fixture.account, { id: 'member-2', name: '二郎', email: 'second@example.com' });
    seedContact(fixture.account, { id: 'member-3', name: '三郎' });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-1'));
      ai.extractions = [invitationExtraction()];
    });

    await automation.runEnabledAccounts();

    const [created] = providers.google.eventWrites;
    expect(created?.body.attendees).toEqual([{ email: 'first@example.com' }, { email: 'second@example.com' }]);
    expect(fixture.account.rows(
      "SELECT destination, outcome, external_id FROM deliveries WHERE channel = 'calendar' ORDER BY destination",
    )).toEqual([
      { destination: 'first@example.com', outcome: 'succeeded', external_id: created?.id },
      { destination: 'second@example.com', outcome: 'succeeded', external_id: created?.id },
    ]);
    expect(fixture.account.rows('SELECT member_id, email_snapshot FROM event_recipients ORDER BY member_id')).toEqual([
      { member_id: 'member-1', email_snapshot: 'first@example.com' },
      { member_id: 'member-2', email_snapshot: 'second@example.com' },
    ]);
  });

  it('delivers a Message Summary for a matched Source Message with no Event Candidate', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedNoticeContacts(fixture.account, [{ id: 'contact-reader', name: '読者', email: 'reader@example.com' }]);
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-summary'));
      ai.extractions = [invitationExtraction({ summary: '次年度の活動方針を共有するお知らせです。', events: [] })];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });

    expect(providers.google.mailbox.sent).toEqual([{ destination: 'reader@example.com', subject: 'Message Summary: 例会のお知らせ', body: '次年度の活動方針を共有するお知らせです。' }]);
    expect(providers.ai.extractionRequests).toHaveLength(1);
    const audit = await app.fetch(fixture.request('/api/organizations/organization-1/audit/deliveries'), fixture.environment);
    await expect(audit.json()).resolves.toMatchObject({
      data: [{
        sourceMessageId: expect.any(String),
        eventId: null,
        channel: 'email',
        destination: 'reader@example.com',
        outcome: 'succeeded',
        externalId: 'sent-1',
      }],
    });
  });

  it('emails the notice to every Contact chosen as the Rule’s send-to, and to nobody else', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedContact(fixture.account, { id: 'contact-unchosen', name: '三郎', email: 'unchosen@example.com' });
    seedNoticeContacts(fixture.account, [
      { id: 'contact-member', name: '一郎', email: 'member@example.com' },
      { id: 'contact-guest', name: '二郎', email: 'guest@example.com' },
    ]);
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-permitted-summaries'));
      ai.extractions = [invitationExtraction({ summary: '選ばれた読者へ送る要約です。', events: [] })];
    });

    await runAccount(automation);

    expect(providers.google.mailbox.sent.map(({ destination }) => destination).sort()).toEqual(['guest@example.com', 'member@example.com']);
    expect(providers.google.mailbox.sent.every(({ body }) => body === '選ばれた読者へ送る要約です。')).toBe(true);
  });

  it('skips Message Summary channels with no permitted lists without failing the Source Message', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-no-destinations'));
      ai.extractions = [invitationExtraction({ summary: '宛先なしの要約です。', events: [] })];
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(providers.google.mailbox.sent).toEqual([]);
    expect(lineSends(providers)).toEqual([]);
  });

  it('delivers exactly one Message Summary when one Source Message produces multiple Scheduled Events', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    // A room holds no email address, so the one notice reaches it on LINE.
    seedNoticeContacts(fixture.account, [{ id: 'contact-line-reader', name: 'LINE Reader', lineDestinationId: 'Usummary-reader-1' }]);
    const { automation, providers } = automationWith(({ google, ai, transport }) => {
      google.addMessage(invitation('gmail-message-multiple-events'));
      ai.extractions = [invitationExtraction({
        summary: '会議と懇親会を同日に開催します。',
        events: [
          { title: '会議', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T20:00:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '会議', summary: '会議' },
          { title: '懇親会', startsAt: '2026-08-03T20:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '懇親会', summary: '懇親会' },
        ],
      })];
      transport.answers.push({ match: 'api.line.me', respond: () => new Response('', { status: 200, headers: { 'x-line-request-id': 'line-summary-delivery-1' } }) });
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 2, skipped: 0, exceptions: 0 });

    const sends = lineSends(providers);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toEqual({
      to: 'Usummary-reader-1',
      messages: [{ type: 'text', text: [
        '会議と懇親会を同日に開催します。',
        '',
        '【予定】',
        '・8/3(月) 19:00〜20:00 会議',
        '・8/3(月) 20:00〜21:30 懇親会',
      ].join('\n') }],
    });
    expect(providers.ai.extractionRequests).toHaveLength(1);
    const audit = await app.fetch(fixture.request('/api/organizations/organization-1/audit/deliveries'), fixture.environment);
    const delivered = (await audit.json() as { data: Array<{ channel: string; externalId: string | null }> }).data;
    expect(delivered.filter(({ channel }) => channel === 'line')).toMatchObject([{
      sourceMessageId: expect.any(String),
      eventId: null,
      channel: 'line',
      outcome: 'succeeded',
      externalId: 'line-summary-delivery-1',
    }]);
  });

  it('states the Scheduled Events and the Tasks a Source Message produced in the one notice', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    // The group room is the chosen send-to and holds no email address, so the
    // one notice reaches it on LINE. 山田花子 is named only as the Task assignee.
    seedNoticeContacts(fixture.account, [{ id: 'contact-group', name: '連絡グループ', lineDestinationId: 'Cnotice-group-1' }]);
    seedContact(fixture.account, { id: 'contact-hanako', name: '山田花子', email: 'hanako@example.com' });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-notice'));
      ai.extractions = [invitationExtraction({
        summary: '例会の案内と会場手配のお願いです。',
        events: [{ title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00', timeZone: 'Asia/Tokyo', location: '第一会議室', description: '例会です', summary: '例会です' }],
        tasks: [{ title: '会場を予約する', deadline: '2026-07-31', assigneeContactId: 'contact-hanako', description: '第一会議室を押さえる' }],
      })];
    });

    await automation.runEnabledAccounts();

    const sends = lineSends(providers);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toEqual({
      to: 'Cnotice-group-1',
      messages: [{ type: 'text', text: [
        '例会の案内と会場手配のお願いです。',
        '',
        '【予定】',
        '・8/3(月) 19:00〜21:30 例会（第一会議室）',
        '',
        '【タスク】',
        '・7/31(金)まで 会場を予約する（山田花子）',
      ].join('\n') }],
    });
  });

  it('reaches the Contacts a Rule names with its notice, resolving each handle from the Contact', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    seedNoticeContacts(fixture.account, [{ id: 'contact-group', name: '要約送信グループ', lineDestinationId: 'Csummary-group-1' }]);
    const { automation, providers } = automationWith(({ google, ai, transport }) => {
      google.addMessage(invitation('gmail-message-contact-notice'));
      ai.extractions = [invitationExtraction({ summary: '会費納入のお願いです。', events: [] })];
      transport.answers.push({ match: 'api.line.me', respond: () => new Response('', { status: 200, headers: { 'x-line-request-id': 'line-contact-notice-1' } }) });
    });

    await automation.runEnabledAccounts();

    const sends = lineSends(providers);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toEqual({ to: 'Csummary-group-1', messages: [{ type: 'text', text: '会費納入のお願いです。' }] });
    const audit = await app.fetch(fixture.request('/api/organizations/organization-1/audit/deliveries'), fixture.environment);
    await expect(audit.json()).resolves.toMatchObject({ data: [{
      channel: 'line', outcome: 'succeeded', externalId: 'line-contact-notice-1', sourceMessageId: expect.any(String),
    }] });
  });

  it('creates an Automation Exception and no Scheduled Event for unsafe AI output', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-message-1'));
      ai.extractions = [null];
    });

    await automation.runEnabledAccounts();

    const dashboard = await app.fetch(fixture.request('/api/organizations/organization-1/dashboard'), fixture.environment);
    const exceptions = await app.fetch(fixture.request('/api/organizations/organization-1/operations/exceptions'), fixture.environment);
    await expect(dashboard.json()).resolves.toMatchObject({ data: { upcomingEvents: 0, exceptions: 1 } });
    await expect(exceptions.json()).resolves.toMatchObject({ data: [{ code: 'ai_event_details_invalid', state: 'open' }] });
  });

  it('delivers an Intake Notice containing only sender and subject when intake fails before extraction', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedNoticeContacts(fixture.account, [{ id: 'contact-intake', name: '取り込み担当', email: 'intake-reader@example.com' }]);
    const { automation, providers } = automationWith(({ google }) => {
      google.addMessage({
        id: 'gmail-message-intake-failure',
        payload: {
          headers: [
            { name: 'Subject', value: '容量超過のお知らせ' },
            { name: 'From', value: 'sender@example.com' },
          ],
          body: { data: gmailBody('読者へ送ってはいけない本文です。') },
          parts: [{ filename: 'secret.pdf', mimeType: 'application/pdf', body: { attachmentId: 'oversized', size: 20 * 1024 * 1024 + 1 } }],
        },
      });
    });

    await expect(runAccount(automation)).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 1 });

    expect(providers.google.mailbox.sent).toEqual([{
      destination: 'intake-reader@example.com',
      subject: 'Intake Notice: 容量超過のお知らせ',
      body: '差出人: sender@example.com\r\n件名: 容量超過のお知らせ',
    }]);
    expect(providers.ai.extractionRequests).toEqual([]);
    const audit = await app.fetch(fixture.request('/api/organizations/organization-1/audit/deliveries'), fixture.environment);
    await expect(audit.json()).resolves.toMatchObject({
      data: [{ sourceMessageId: expect.any(String), eventId: null, channel: 'email', destination: 'intake-reader@example.com', outcome: 'succeeded', externalId: 'sent-1' }],
    });
  });

  it('extracts a Scheduled Event from a DOCX attachment in normal Automation Inbox processing', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const markdown = { toMarkdown: vi.fn().mockResolvedValue({
      format: 'markdown',
      name: '式典案内.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      tokens: 30,
      data: '# FILE-PROBE-001\n日時: 2026-08-18 14:30-16:00\n会場: 名古屋',
    }) };
    (fixture.environment as unknown as { AI: typeof markdown }).AI = markdown;
    const docx = await readFile(new URL('../../../fixtures/ai-file-probe/event-invitation.docx', import.meta.url));
    let aiRequest: { messages?: Array<{ role?: string; content?: string }> } = {};
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage({
        id: 'gmail-message-docx',
        internalDate: '1775520720000',
        subject: '式典のお知らせ',
        body: '日時は添付ファイルをご確認ください。',
        attachments: [{ attachmentId: 'attachment-docx', filename: '式典案内.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx.toString('base64') }],
      });
      ai.extract = async (input) => extractAiEventDetails({
        ...input,
        fetch: async (_url, init) => {
          aiRequest = JSON.parse(init?.body as string) as typeof aiRequest;
          const normalizedText = aiRequest.messages?.[1]?.content ?? '';
          if (!normalizedText.includes('FILE-PROBE-001') || !normalizedText.includes('2026-08-18') || !normalizedText.includes('14:30') || !normalizedText.includes('16:00')) {
            return Response.json({ error: { message: 'Normalized DOCX content was not provided.' } }, { status: 400 });
          }
          return Response.json({ choices: [{ message: { content: JSON.stringify({
            title: '式典',
            startsAt: '2026-09-12T14:00:00+09:00',
            endsAt: '2026-09-12T16:00:00+09:00',
            timeZone: 'Asia/Tokyo',
            location: '名古屋',
            description: '添付DOCXから抽出',
            summary: '式典の案内です。受付は開始30分前からです。',
          }) } }] });
        },
      });
    });

    await automation.runEnabledAccounts();

    expect(aiRequest.messages?.[1]?.content).toContain('FILE-PROBE-001');
    expect(aiRequest.messages?.[0]?.content).toContain('{"receivedAt":"2026-04-07T09:12:00+09:00","timeZone":"Asia/Tokyo"}');
    expect(markdown.toMarkdown).toHaveBeenCalledWith(expect.objectContaining({ name: '式典案内.docx', blob: expect.any(Blob) }), { conversionOptions: { pdf: { metadata: false } } });
    expect(aiRequest.messages?.[1]?.content).not.toContain(docx.toString('base64'));
    const [created] = providers.google.eventWrites;
    expect(created?.body.attachments).toEqual([{
      fileUrl: 'https://drive.example/%E5%BC%8F%E5%85%B8%E6%A1%88%E5%86%85.docx',
      title: '式典案内.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }]);
    expect(created?.body.description).toBe([
      '式典の案内です。受付は開始30分前からです。',
      '<br><br>添付ファイル:',
      '<br><a href="https://drive.example/%E5%BC%8F%E5%85%B8%E6%A1%88%E5%86%85.docx">式典案内.docx</a>',
      '<br><br>FlareChat が Gmail メッセージ gmail-message-docx から作成しました。',
    ].join(''));
    const dashboard = await app.fetch(fixture.request('/api/organizations/organization-1/dashboard'), fixture.environment);
    await expect(dashboard.json()).resolves.toMatchObject({ data: { upcomingEvents: 1, exceptions: 0 } });
  });

  it('creates an Automation Exception when Gmail attachment retrieval fails', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation, providers } = automationWith(({ google }) => {
      google.addMessage({
        id: 'gmail-message-failed-attachment',
        subject: '添付をご確認ください',
        attachments: [{ attachmentId: 'attachment-pdf', filename: '案内.pdf', mimeType: 'application/pdf', data: 'cGRm' }],
      });
      google.failNext('readAttachments', new GoogleApiError('attachment unavailable', 503, '/attachments/attachment-pdf'));
    });

    await expect(runAccount(automation)).resolves.toMatchObject({ created: 0, exceptions: 1 });
    expect(providers.google.eventWrites).toEqual([]);
    expect(fixture.account.rows<{ code: string }>('SELECT code FROM exceptions')).toEqual([{ code: 'gmail_attachment_download_failed' }]);
  });

  it('keeps the Calendar event as a draft when Drive publication fails', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedContact(fixture.account, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage({
        ...invitation('gmail-message-drive-failure'),
        attachments: [{ attachmentId: 'attachment-pdf', filename: '式次第.pdf', mimeType: 'application/pdf', data: 'cGRmLWJ5dGVz' }],
      });
      google.drive.publishFails = true;
      ai.extractions = [invitationExtraction()];
    });

    await expect(runAccount(automation)).resolves.toMatchObject({ created: 0, exceptions: 1 });
    const [created] = providers.google.eventWrites;
    expect(created?.body.attachments).toEqual([]);
    expect(created?.body.attendees).toEqual([]);
    expect(fixture.account.rows("SELECT destination, outcome, external_id FROM deliveries WHERE channel = 'calendar'"))
      .toEqual([{ destination: 'first@example.com', outcome: 'pending', external_id: null }]);
    expect(fixture.account.rows<{ status: string }>('SELECT status FROM events')).toEqual([{ status: 'draft' }]);
    expect(fixture.account.rows<{ state: string }>('SELECT state FROM source_messages')).toEqual([{ state: 'exception' }]);
  });

  it('resumes an approved run whose email summary was interrupted, through the same effect adapter', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    await seedAgentRule({ name: 'Mailer', executionMode: 'approval', recipientDestinations: ['reader@example.com'] });
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.addMessage(invitation('gmail-email-summary'));
      ai.agentTurns = [
        { model: 'test-model', content: '', totalTokens: 10, toolCalls: [toolCall('send_email_summary', { destination: 'reader@example.com', subject: '要約', body: '本文' })] },
        { model: 'test-model', content: 'done', toolCalls: [], totalTokens: 5 },
      ];
    });

    await runAccount(automation);
    const run = fixture.account.row<{ id: string }>('SELECT id FROM rule_runs')!;
    // An operator approves; the approval route applies through production providers, which this test cannot reach,
    // so the run is left applying and the next scheduled sweep resumes it through the in-memory providers.
    fixture.account.execute("UPDATE rule_runs SET status = 'applying' WHERE id = ?", run.id);
    fixture.account.execute("UPDATE rule_effects SET status = 'planned' WHERE rule_run_id = ?", run.id);

    await runAccount(automation);

    expect(providers.google.mailbox.sent).toEqual([{ destination: 'reader@example.com', subject: '要約', body: '本文' }]);
    expect(fixture.account.row<{ status: string }>('SELECT status FROM rule_runs WHERE id = ?', run.id)).toEqual({ status: 'completed' });
    expect(fixture.account.rows<{ kind: string; status: string }>('SELECT kind, status FROM rule_effects')).toEqual([{ kind: 'agent.send_email_summary', status: 'succeeded' }]);
  });
});

describe('Manual mailbox test', () => {
  it('previews a selected Source Message through the active Primary Rule without consuming it', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    let calendarRequest: { summary?: string; description?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/messages/mailbox-active-preview')) {
        return Response.json({
          id: 'mailbox-active-preview',
          internalDate: '1786000000000',
          payload: {
            headers: [{ name: 'Subject', value: '常設メールテスト' }, { name: 'From', value: 'member@example.com' }],
            body: { data: gmailBody('2026年8月18日 14:30から16:00まで例会を開催します。') },
          },
        });
      }
      if (url.includes('ai.example.com')) {
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          summary: '例会の予定です。',
          events: [{ title: '例会', startsAt: '2026-08-18T14:30:00+09:00', endsAt: '2026-08-18T16:00:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '常設メールテスト', summary: '例会の予定です。' }],
          tasks: [],
        }) } }] });
      }
      if (url.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
        calendarRequest = JSON.parse(init.body as string) as typeof calendarRequest;
        return Response.json({ id: 'mailbox-test-event' });
      }
      if (url.includes('/calendar/v3/calendars/primary/events')) return Response.json({ items: [] });
      return Response.json({ error: { message: `unexpected request: ${url}` } }, { status: 500 });
    }));

    const response = await app.fetch(fixture.request('/api/organizations/organization-1/mail-tests/mailbox-active-preview/preview', { method: 'POST' }), fixture.environment);

    expect(response.status).toBe(200);
    const preview = await response.json() as { data: { confirmationToken: string } };
    expect(preview).toMatchObject({ data: { id: 'mailbox-active-preview', selectedRule: { id: 'rule-1', revision: 1 }, events: [{ title: '例会' }] } });
    const calendarResponse = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/mail-tests/calendar', { confirmationToken: preview.data.confirmationToken }), fixture.environment);

    expect(calendarResponse.status).toBe(201);
    await expect(calendarResponse.json()).resolves.toMatchObject({ data: { eventIds: ['mailbox-test-event'] } });
    expect(calendarRequest).toMatchObject({ summary: '例会' });
    expect(calendarRequest.description).toContain('mailbox-active-preview');
    expect(fixture.account.rows('SELECT * FROM source_messages')).toEqual([]);
  });

  it('searches Gmail and prepares an OpenAI-compatible request without an AI credential', async () => {
    fixture = await createAutomationTestApp();
    const upstreamUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      upstreamUrls.push(url);
      if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'message-without-ai' }] });
      if (url.includes('/messages/message-without-ai')) {
        return Response.json({
          id: 'message-without-ai',
          payload: {
            headers: [{ name: 'Subject', value: '手動テスト' }, { name: 'From', value: 'member@example.com' }],
            body: { data: gmailBody('日時: 2026年8月3日 19:00〜21:30') },
          },
        });
      }
      return Response.json({ error: { message: `unexpected request: ${url}` } }, { status: 500 });
    }));

    const searchResponse = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/mail-tests/search', { subject: '手動テスト' }), fixture.environment);
    const preparedResponse = await app.fetch(fixture.request('/api/organizations/organization-1/mail-tests/message-without-ai/ai-request', { method: 'POST' }), fixture.environment);
    const prepared = await preparedResponse.json() as { data: { request: { messages?: Array<{ role?: string; content?: string }> } } };

    expect(searchResponse.status).toBe(200);
    expect(preparedResponse.status).toBe(200);
    expect(prepared.data.request.messages?.[1]?.content).toContain('2026年8月3日 19:00〜21:30');
    expect(upstreamUrls.some((url) => url.includes('ai.example.com'))).toBe(false);
  });

  const searchWith = (subject: string) => {
    const { automation } = automationWith(({ google }) => {
      google.mailbox.messages.set('mailbox-port-message', { id: 'mailbox-port-message', subject, sender: 'member@example.com' });
    });
    return (searched: string) => automation.mailboxTest.search({ accountId: 'organization-1', database: fixture!.account.binding, subject: searched });
  };

  it('returns exact-subject matches through the injected Google adapter', async () => {
    fixture = await createAutomationTestApp();
    await expect(searchWith('手動テスト')('手動テスト')).resolves.toEqual([{ id: 'mailbox-port-message', subject: '手動テスト', sender: 'member@example.com' }]);
  });

  it('matches a subject despite full-width digits and doubled whitespace Gmail treats as the same subject', async () => {
    fixture = await createAutomationTestApp();
    await expect(searchWith('３０周年記念式典　のご案内')('30周年記念式典  のご案内'))
      .resolves.toEqual([{ id: 'mailbox-port-message', subject: '３０周年記念式典　のご案内', sender: 'member@example.com' }]);
  });

  it('rejects a subject that only shares words with the searched-for subject', async () => {
    fixture = await createAutomationTestApp();
    await expect(searchWith('30周年記念式典のご案内（再送）')('30周年記念式典のご案内')).resolves.toEqual([]);
  });

  it('previews an event whose date and time exist only in an XLSX attachment', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute("UPDATE rules SET status = 'draft' WHERE id = 'rule-1'");
    const markdown = { toMarkdown: vi.fn().mockResolvedValue({
      format: 'markdown',
      name: '式典案内.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      tokens: 32,
      data: [
        '# FILE-PROBE-001',
        '',
        '| __EMPTY_1 | 日時         | 時間         | 会場                                      | __EMPTY_2 |',
        '| ----------- | ------------ | ------------ | ----------------------------------------- | --------- |',
        '|             | 2026-08-18   | 14:30-16:00  | 名古屋イノベーションセンター 3階 会議室A |           |',
        '|             |              |              |                                           |           |',
      ].join('\n'),
    }) };
    (fixture.environment as unknown as { AI: typeof markdown }).AI = markdown;
    const xlsx = await readFile(new URL('../../../fixtures/ai-file-probe/event-invitation.xlsx', import.meta.url));
    const gmailXlsx = xlsx.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    let aiRequest: { messages?: Array<{ role?: string; content?: string }> } = {};
    const calendarRequests: unknown[] = [];
    const driveRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/attachments/attachment-xlsx')) return Response.json({ data: gmailXlsx });
      if (url.includes('/messages/gmail-message-attachment')) {
        return Response.json({
          id: 'gmail-message-attachment',
          payload: {
            headers: [{ name: 'Subject', value: '名古屋名城RAC30周年記念式典のご案内' }, { name: 'From', value: 'member@example.com' }],
            body: { data: gmailBody('詳しくは添付をご確認ください。') },
            parts: [{ filename: '式典案内.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: { attachmentId: 'attachment-xlsx', size: xlsx.byteLength } }],
          },
        });
      }
      if (url.includes('/calendar/v3/calendars/primary/events') && !init?.method) return Response.json({ items: [] });
      if (url.includes('ai.example.com')) {
        aiRequest = JSON.parse(init?.body as string) as typeof aiRequest;
        const normalizedText = aiRequest.messages?.[1]?.content ?? '';
        if (!normalizedText.includes('FILE-PROBE-001') || !normalizedText.includes('2026-08-18') || !normalizedText.includes('14:30') || !normalizedText.includes('16:00')) {
          return Response.json({ error: { message: 'Normalized XLSX content was not provided.' } }, { status: 400 });
        }
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          summary: '8月18日に会議と懇親会を開催します。8月10日までの出席登録と8月12日までの参加費振込が必要です。',
          events: [
            { title: 'AI ファイル解析テスト会議', startsAt: '2026-08-18T14:30:00+09:00', endsAt: '2026-08-18T16:00:00+09:00', timeZone: 'Asia/Tokyo', location: '名古屋イノベーションセンター 3階 会議室A', description: '添付XLSXから抽出' },
            { title: 'テスト懇親会', startsAt: '2026-08-18T17:00:00+09:00', endsAt: '2026-08-18T19:00:00+09:00', timeZone: 'Asia/Tokyo', location: '名古屋イノベーションセンター 1階', description: '式典後の懇親会' },
          ],
          tasks: [
            { title: '出席登録を完了する', deadline: '2026-08-10', assigneeContactId: 'unassigned', description: '登録フォームを送信する' },
            { title: '参加費を振り込む', deadline: '2026-08-12', assigneeContactId: 'unassigned', description: '指定口座へ振込する' },
          ],
        }) } }] });
      }
      if (url.includes('drive/')) {
        driveRequests.push(url);
        return Response.json({ files: [], id: 'drive-folder' });
      }
      if (url.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
        calendarRequests.push(JSON.parse(init.body as string));
        return Response.json({ id: 'calendar-event-xlsx' });
      }
      return Response.json({ error: { message: `unexpected request: ${url}` } }, { status: 500 });
    }));

    const requestResponse = await app.fetch(fixture.request('/api/organizations/organization-1/mail-tests/gmail-message-attachment/ai-request', { method: 'POST' }), fixture.environment);
    const aiRequestPreview = await requestResponse.json() as { data: { request: { messages?: Array<{ role?: string; content?: string }> } } };

    expect(requestResponse.status).toBe(200);
    expect(aiRequestPreview.data.request.messages?.[1]?.content).toContain('FILE-PROBE-001');
    expect(aiRequestPreview.data.request.messages?.[1]?.content).toContain('日時\t時間\t会場');
    expect(aiRequestPreview.data.request.messages?.[1]?.content).not.toContain('__EMPTY_1');
    expect(aiRequestPreview.data.request.messages?.[1]?.content).not.toContain('| ----------- |');
    expect(aiRequest.messages).toBeUndefined();

    fixture.account.execute("UPDATE rules SET selection_policy = ? WHERE id = 'rule-1'", JSON.stringify({ sender: 'other@example.com' }));
    const rejectedBySelection = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/mail-tests/gmail-message-attachment/draft-preview', { ruleId: 'rule-1' }), fixture.environment);
    expect(rejectedBySelection.status).toBe(409);
    expect(aiRequest.messages).toBeUndefined();
    fixture.account.execute("UPDATE rules SET selection_policy = '{}' WHERE id = 'rule-1'");

    const previewResponse = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/mail-tests/gmail-message-attachment/draft-preview', { ruleId: 'rule-1' }), fixture.environment);
    const preview = await previewResponse.json() as { data: { summary: string; events: EventDetails[]; tasks: Array<{ assigneeContactId: string }>; confirmationToken: string } };
    const rejectedCalendarResponse = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/mail-tests/calendar', { confirmationToken: preview.data.confirmationToken }), fixture.environment);
    const runResponse = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/mail-tests/rule-run', { confirmationToken: preview.data.confirmationToken, ruleId: 'rule-1' }), fixture.environment);

    expect(previewResponse.status).toBe(200);
    expect(rejectedCalendarResponse.status).toBe(409);
    expect(preview).toMatchObject({ data: {
      summary: '8月18日に会議と懇親会を開催します。8月10日までの出席登録と8月12日までの参加費振込が必要です。',
      events: [{ title: 'AI ファイル解析テスト会議', startsAt: '2026-08-18T14:30:00+09:00' }, { title: 'テスト懇親会' }],
      tasks: [{ assigneeContactId: 'unassigned' }, { assigneeContactId: 'unassigned' }],
    } });
    expect(aiRequest.messages?.[1]?.content).toContain('FILE-PROBE-001');
    expect(aiRequest.messages?.[1]?.content).not.toContain(gmailXlsx);
    expect(markdown.toMarkdown).toHaveBeenCalledWith(expect.objectContaining({ name: '式典案内.xlsx', blob: expect.any(Blob) }), { conversionOptions: { pdf: { metadata: false } } });
    expect(runResponse.status).toBe(201);
    const runBody = await runResponse.json() as { data: { effects: Array<{ arguments: unknown }> } };
    expect(runBody).toMatchObject({ data: {
      rule: { type: 'schema', id: 'rule-1', revision: 1 },
      intent: 'draft_preview',
      executionMode: 'read_only',
      status: 'read_only',
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'schema.apply_events', status: 'planned', arguments: expect.objectContaining({ events: [expect.objectContaining({ title: 'AI ファイル解析テスト会議' }), expect.objectContaining({ title: 'テスト懇親会' })] }) }),
      ]),
    } });
    expect(JSON.stringify(runBody.data.effects)).not.toContain(gmailXlsx);
    expect(calendarRequests).toHaveLength(0);
    expect(driveRequests).toHaveLength(0);
    expect(fixture.account.rows("SELECT id FROM source_messages WHERE gmail_message_id = 'gmail-message-attachment'")).toEqual([]);
  });
});

describe('the Event Refresh exit', () => {
  const CANDIDATE: EventDetails = {
    title: '30周年記念式典',
    startsAt: '2026-08-18T14:30:00+09:00',
    endsAt: '2026-08-18T16:00:00+09:00',
    timeZone: 'Asia/Tokyo',
    location: '市民ホール',
    description: '記念式典',
    summary: '30周年を祝う記念式典です。会費は5,000円です。',
  };

  const staleEvent = (description: string) => ({
    id: 'calendar-event-1',
    etag: '"etag-1"',
    summary: '記念式典',
    description,
    location: '',
    start: { dateTime: '2026-08-18T14:30:00+09:00', timeZone: 'Asia/Tokyo' },
    end: { dateTime: '2026-08-18T16:00:00+09:00', timeZone: 'Asia/Tokyo' },
  });

  const refreshMessage = (attachments: Array<{ attachmentId: string; filename: string; mimeType: string; data: string }> = []) => ({
    id: 'gmail-refresh-1',
    subject: '30周年記念式典のご案内',
    sender: 'member@example.com',
    body: '式典のご案内です。',
    internalDate: '1786000000000',
    attachments,
  });

  const refresh = (providers: MemoryProviders, automation: ReturnType<typeof createAutomation>) => ({
    plan: (events: EventDetails[]) => automation.mailboxTest.planRefresh({ accountId: 'organization-1', database: fixture!.account.binding, messageId: 'gmail-refresh-1', events }),
    apply: (entries: Array<{ googleEventId: string | null; etag: string | null; candidate: EventDetails }>) =>
      automation.mailboxTest.applyRefresh({ accountId: 'organization-1', database: fixture!.account.binding, messageId: 'gmail-refresh-1', entries }),
    patches: () => providers.google.eventWrites.filter(({ operation }) => operation === 'patch'),
  });

  it('plans an update for the Scheduled Event this message already produced', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    let correspondenceInput: { existing: Array<{ id: string }> } | undefined;
    const { automation, providers } = automationWith(({ google, ai }) => {
      google.mailbox.messages.set('gmail-refresh-1', refreshMessage());
      google.addEvent(staleEvent('Mail Automation が Gmail メッセージ gmail-refresh-1 から作成しました。'));
      google.addEvent({
        ...staleEvent('Mail Automation が Gmail メッセージ gmail-refresh-1 から作成しました。'),
        id: 'calendar-event-far',
        start: { dateTime: '2026-11-18T14:30:00+09:00', timeZone: 'Asia/Tokyo' },
        end: { dateTime: '2026-11-18T16:00:00+09:00', timeZone: 'Asia/Tokyo' },
      });
      google.addEvent({ ...staleEvent('手で作った予定です。'), id: 'calendar-event-manual' });
      ai.correspond = async (input) => {
        correspondenceInput = input;
        return [{ candidateIndex: 0, eventId: 'calendar-event-1' }];
      };
    });

    const plan = await refresh(providers, automation).plan([CANDIDATE]);

    expect(correspondenceInput?.existing.map((event) => event.id)).toEqual(['calendar-event-1']);
    expect(plan.entries[0]?.target?.id).toBe('calendar-event-1');
    expect(plan.entries[0]?.changedFields).toEqual(['title', 'description', 'location']);
    expect(plan.outOfWindow.map((event) => event.id)).toEqual(['calendar-event-far']);
    // The existing events carry the old product name; the plan rewrites them under the new one.
    expect(plan.desired[0]?.description).toContain('FlareChat が Gmail メッセージ gmail-refresh-1 から作成しました。');
  });

  it('rewrites every field, adds the active roster as attendees, and preserves an existing attendee\'s response status', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedContact(fixture.account, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    fixture.account.execute(
      `INSERT INTO events
        (id, organization_id, rule_id, google_event_id, title, starts_at, ends_at, location, description, status, created_at, updated_at)
       VALUES (?, 'organization-1', 'rule-1', 'calendar-event-1', ?, ?, ?, '', '', 'scheduled', ?, ?)`,
      'event-1', '記念式典', '2026-08-18T14:30:00+09:00', '2026-08-18T16:00:00+09:00', '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z',
    );
    const { automation, providers } = automationWith(({ google }) => {
      google.mailbox.messages.set('gmail-refresh-1', refreshMessage());
      google.addEvent({ ...staleEvent(''), attendees: [{ email: 'guest@example.com', responseStatus: 'accepted' }] });
    });
    const exit = refresh(providers, automation);

    const outcome = await exit.apply([{ googleEventId: 'calendar-event-1', etag: '"etag-1"', candidate: CANDIDATE }]);

    expect(outcome.updated).toEqual(['calendar-event-1']);
    const [patched] = exit.patches();
    expect(patched?.etag).toBe('"etag-1"');
    expect(patched?.body).toMatchObject({
      summary: '30周年記念式典',
      location: '市民ホール',
      start: { dateTime: '2026-08-18T14:30:00+09:00', timeZone: 'Asia/Tokyo' },
    });
    expect(patched?.body.attendees).toEqual([{ email: 'guest@example.com', responseStatus: 'accepted' }, { email: 'first@example.com' }]);
    expect(String(patched?.body.description)).toContain('FlareChat が Gmail メッセージ gmail-refresh-1 から作成しました。');
    expect(fixture.account.row<{ title: string; location: string }>('SELECT title, location FROM events WHERE google_event_id = ?', 'calendar-event-1'))
      .toMatchObject({ title: '30周年記念式典', location: '市民ホール' });
    expect(fixture.account.rows<{ channel: string; external_id: string }>("SELECT channel, external_id FROM deliveries WHERE channel = 'calendar'"))
      .toEqual([{ channel: 'calendar', external_id: 'calendar-event-1' }]);
  });

  it('sends no notification when every active Contact is already an attendee', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedContact(fixture.account, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    const { automation, providers } = automationWith(({ google }) => {
      google.mailbox.messages.set('gmail-refresh-1', refreshMessage());
      google.addEvent({ ...staleEvent(''), attendees: [{ email: 'first@example.com', responseStatus: 'declined' }] });
    });
    const exit = refresh(providers, automation);

    await exit.apply([{ googleEventId: 'calendar-event-1', etag: '"etag-1"', candidate: CANDIDATE }]);

    expect(exit.patches()[0]?.body.attendees).toEqual([{ email: 'first@example.com', responseStatus: 'declined' }]);
  });

  it('invites the active roster without notifying them when it creates a Scheduled Event through the refresh exit', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedContact(fixture.account, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    const { automation, providers } = automationWith(({ google }) => {
      google.mailbox.messages.set('gmail-refresh-1', refreshMessage());
    });

    const outcome = await refresh(providers, automation).apply([{ googleEventId: null, etag: null, candidate: CANDIDATE }]);

    expect(outcome.created).toEqual(['calendar-event-1']);
    expect(providers.google.eventWrites[0]?.body.attendees).toEqual([{ email: 'first@example.com' }]);
  });

  it('re-offers a Scheduled Event the Calendar changed after the plan, instead of overwriting it', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation, providers } = automationWith(({ google }) => {
      google.mailbox.messages.set('gmail-refresh-1', refreshMessage());
      google.addEvent({ ...staleEvent('Mail Automation が Gmail メッセージ gmail-refresh-1 から作成しました。'), etag: '"etag-9"', location: '別会場' });
    });

    const outcome = await refresh(providers, automation).apply([{ googleEventId: 'calendar-event-1', etag: '"etag-1"', candidate: CANDIDATE }]);

    expect(outcome.updated).toEqual([]);
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]?.etag).toBe('"etag-9"');
    expect(outcome.conflicts[0]?.current.location).toBe('別会場');
    expect(outcome.conflicts[0]?.changedFields).toContain('location');
  });

  it('reuses a Public Attachment a previous run already placed in the folder', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute(
      `INSERT INTO source_messages
        (id, gmail_message_id, gmail_history_id, sender, subject, drive_folder_id, received_at, processed_at, state)
       VALUES (?, 'gmail-refresh-1', 'history-1', ?, ?, 'source-message-folder', ?, ?, 'processed')`,
      'source-message-1', 'member@example.com', '30周年記念式典のご案内', '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z',
    );
    const { automation, providers } = automationWith(({ google }) => {
      google.mailbox.messages.set('gmail-refresh-1', refreshMessage([{ attachmentId: 'attachment-1', filename: '案内.pdf', mimeType: 'application/pdf', data: 'cGRm' }]));
      google.drive.files.push({ id: 'drive-existing', filename: '案内.pdf', folderId: 'source-message-folder', url: 'https://drive.example/existing' });
      google.addEvent({ ...staleEvent(''), attendees: [] });
    });
    const exit = refresh(providers, automation);

    await exit.apply([{ googleEventId: 'calendar-event-1', etag: null, candidate: CANDIDATE }]);

    expect(providers.google.drive.files).toHaveLength(1);
    const description = String(exit.patches()[0]?.body.description);
    expect(description).toContain('https://drive.example/existing');
    expect(description).toContain('案内.pdf');
  });
});

describe('unattended Automation Inbox health', () => {
  const setInboxTokenExpiry = async (expiresAt: string): Promise<void> => {
    const keyRecord = fixture?.control.row<{ master_key_version: string; wrapped_key_envelope: string }>(
      "SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = 'organization-1'",
    );
    const accountKey = await unwrapAccountKey({
      masterKeyVersion: keyRecord?.master_key_version ?? '',
      envelope: JSON.parse(keyRecord?.wrapped_key_envelope ?? '{}'),
    }, await masterKey(fixture?.environment.CREDENTIAL_MASTER_KEY ?? ''), 'organization-1');
    const envelope = await encrypt(JSON.stringify({
      accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt, scopes: [], tokenType: 'Bearer',
    }), accountKey, 'google-connection:organization-1:automation-inbox');
    fixture?.account.execute("UPDATE google_connections SET token_envelope = ? WHERE kind = 'automation_inbox'", JSON.stringify(envelope));
  };

  it('keeps an Automation Inbox connected through a Gmail outage so the next scheduled run retries', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { automation } = automationWith(({ google }) => {
      google.failNext('listHistory', new GoogleApiError('Backend Error', 503, 'history'));
    });

    await automation.runEnabledAccounts();

    expect(inboxHealth()).toMatchObject({ status: 'active', last_error: 'Backend Error', alerted_at: null });
    expect(inboxHealth()?.failing_since).toEqual(expect.any(String));
  });

  it('suspends an Automation Inbox whose grant Google rejected and mails every Administrator', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    await setInboxTokenExpiry(new Date(Date.now() + 10 * 60 * 1_000).toISOString());
    const { automation, providers } = automationWith(({ google }) => { google.tokens.rejectGrant = true; });

    await automation.runEnabledAccounts();

    expect(inboxHealth()).toMatchObject({ status: 'reauthentication_required', last_error: 'Token has been expired or revoked.' });
    expect(inboxHealth()?.alerted_at).toEqual(expect.any(String));
    expect(providers.google.mailbox.sent).toHaveLength(1);
    expect(providers.google.mailbox.sent[0]).toMatchObject({ destination: 'owner@example.com' });
    expect(providers.google.mailbox.sent[0]?.body).toContain('Token has been expired or revoked.');
  });

  it('mails the Administrators once a day of unattended retries has failed and keeps the Inbox connected', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute(
      "UPDATE google_connections SET failing_since = ?, last_error = 'Backend Error' WHERE kind = 'automation_inbox'",
      new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString(),
    );
    const { automation, providers } = automationWith(({ google }) => {
      google.failNext('listHistory', new GoogleApiError('Backend Error', 503, 'history'));
    });

    await automation.runEnabledAccounts();

    expect(inboxHealth()).toMatchObject({ status: 'active', last_error: 'Backend Error' });
    expect(inboxHealth()?.alerted_at).toEqual(expect.any(String));
    expect(providers.google.mailbox.sent[0]).toMatchObject({ destination: 'owner@example.com' });
  });

  it('keeps sweeping the fleet when one Account database cannot be opened', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.control.execute(
      `INSERT INTO organizations (id, name, status, database_id, binding_name, created_at, updated_at)
       VALUES ('organization-unbound', 'Unbound', 'active', 'database-unbound', 'ORG_UNBOUND', ?, ?)`,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    );
    const { automation } = automationWith(({ google }) => { google.mailbox.historyId = 'history-after-unbound-peer'; });

    await automation.runEnabledAccounts();

    expect(fixture.account.row<{ gmail_history_id: string }>("SELECT gmail_history_id FROM google_connections WHERE kind = 'automation_inbox'"))
      .toEqual({ gmail_history_id: 'history-after-unbound-peer' });
    expect(inboxHealth()).toMatchObject({ status: 'active', last_error: null });
  });

  it('clears a recorded failure as soon as one scheduled run succeeds again', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.account.execute(
      "UPDATE google_connections SET failing_since = ?, alerted_at = ?, last_error = 'Backend Error' WHERE kind = 'automation_inbox'",
      '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z',
    );
    const { automation } = automationWith();

    await automation.runEnabledAccounts();

    expect(inboxHealth()).toEqual({ status: 'active', last_error: null, failing_since: null, alerted_at: null });
  });
});

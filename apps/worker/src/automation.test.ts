import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import { extractAiEventDetails, type EventDetails, type MailExtraction } from './event-details';
import {
  createAutomation,
  decodedBody,
  receivedAtOf,
  runEnabledAutomations,
  runOrganizationAutomation,
  selectActiveRule,
  sourceAttachments,
  sourceAttachmentSizes,
} from './automation';
import { createAutomationTestApp, type AutomationTestApp } from '../test/automation';
import { encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import { createMemoryR2, seedAttendanceRegistration, seedMember, seedScheduledEvent } from '../test/seed';
import { AGENT_TOKEN_CEILING, MAX_AGENT_TOOL_CALLS } from './agent-runs';
import { GoogleApiError } from './automation/providers';

let fixture: AutomationTestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

const gmailBody = (value: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

const sourceMessageResponse = (input: {
  subject?: string;
  body?: string;
  sender?: string;
  labelIds?: string[];
} = {}): Response => new Response(JSON.stringify({
  ...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
  payload: {
    headers: [
      { name: 'Subject', value: input.subject ?? '例会のお知らせ' },
      { name: 'From', value: input.sender ?? 'member@example.com' },
    ],
    body: { data: gmailBody(input.body ?? '日時: 2026年8月3日 19:00〜21:30') },
  },
}), { status: 200 });

describe('Source Message processing primitives', () => {
  it('selects the highest-priority matching active Automation Rule', () => {
    expect(selectActiveRule([
      { id: 'rule-low', revision: 1, priority: 1, executionMode: 'unattended', selectionPolicy: { domain: 'example.com' } },
      { id: 'rule-high', revision: 1, priority: 10, executionMode: 'unattended', selectionPolicy: { sender: 'announcer@example.com', keyword: '例会' } },
    ], {
      sender: 'announcer@example.com',
      subject: '例会のお知らせ',
      body: '2026年8月3日 19:00〜21:00',
    })).toMatchObject({ id: 'rule-high' });
    expect(selectActiveRule([
      { id: 'rule-1', revision: 1, priority: 1, executionMode: 'unattended', selectionPolicy: { domain: 'example.com' } },
    ], {
      sender: 'other@invalid.test',
      subject: '例会',
      body: '',
    })).toBeNull();
  });

  it('reads a multipart/alternative body once instead of sending both representations', () => {
    const invitation = '創立30周年記念式典のご案内です。ご出席をお待ちしております。';

    expect(decodedBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: gmailBody(invitation) } },
        { mimeType: 'text/html', body: { data: gmailBody(`<html><body><p>${invitation}</p></body></html>`) } },
      ],
    })).toBe(invitation);
  });

  it('falls back to the HTML representation when Gmail supplies no plain text', () => {
    expect(decodedBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: gmailBody('<p>会場は会館です。</p>') } },
      ],
    })).toBe('会場は会館です。');
  });

  it('states the Gmail delivery time in the time zone this product schedules in', () => {
    expect(receivedAtOf('1775520720000')).toBe('2026-04-07T09:12:00+09:00');
    expect(receivedAtOf(undefined)).toBeUndefined();
    expect(receivedAtOf('not-a-timestamp')).toBeUndefined();
  });

  it('counts and retains only attached file parts', () => {
    const payload = {
      body: { size: 1_000 },
      parts: [
        { filename: 'agenda.pdf', mimeType: 'application/pdf', body: { attachmentId: 'file-1', size: 12 } },
        { body: { data: 'inline-text', size: 100 } },
      ],
    };

    expect(sourceAttachmentSizes(payload)).toEqual([12]);
    expect(sourceAttachments(payload)).toEqual([
      { attachmentId: 'file-1', filename: 'agenda.pdf', mimeType: 'application/pdf', size: 12 },
    ]);
  });
});

describe('Organization Automation Inbox scheduling', () => {
  it('ignores a message sent by the Automation Inbox and still advances Gmail history', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedMember(fixture.organization, { id: 'member-1', name: '一郎', email: 'member@example.com' });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      if (url.includes('/history')) return Response.json({
        historyId: 'history-after-sent-reply',
        history: [{ messagesAdded: [{ message: { id: 'sent-reply' } }] }],
      });
      if (url.includes('/messages/sent-reply')) return sourceMessageResponse({
        subject: 'Re: Volunteer activity',
        body: '説明会は2026年8月5日19:30から20:30です。',
        sender: '"Automation Inbox" <automation@example.com>',
        labelIds: ['SENT'],
      });
      if (url.includes('ai.example.com')) return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '説明会です。',
        events: [{
          title: '説明会',
          startsAt: '2026-08-05T19:30:00+09:00',
          endsAt: '2026-08-05T20:30:00+09:00',
          timeZone: 'Asia/Tokyo',
          location: '',
          description: '説明会です。',
        }],
        tasks: [],
      }) } }] });
      return Response.json({ id: 'calendar-event-that-must-not-exist' });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toEqual({ scanned: 0, created: 0, skipped: 0, exceptions: 0 });

    expect(requests.some((url) => url.includes('ai.example.com') || url.includes('/calendar/'))).toBe(false);
    expect(fixture.organization.rows('SELECT * FROM source_messages')).toEqual([]);
    expect(fixture.organization.row<{ gmail_history_id: string }>(
      "SELECT gmail_history_id FROM google_connections WHERE kind = 'automation_inbox'",
    )).toEqual({ gmail_history_id: 'history-after-sent-reply' });
  });

  it('repairs a rule-less Organization with a catch-all Schema Rule and sends ordinary mail through AI', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute('DELETE FROM rules');
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      if (url.includes('/history')) return Response.json({
        historyId: 'history-after-rule-repair',
        history: [{ messagesAdded: [{ message: { id: 'ordinary-message' } }] }],
      });
      if (url.includes('/messages/ordinary-message')) return sourceMessageResponse({
        subject: '次回例会について',
        body: '詳細は添付の案内をご確認ください。',
      });
      if (url.includes('ai.example.com')) return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '次回例会の案内です。',
        events: [{
          title: '次回例会', startsAt: '2026-08-10T19:00:00+09:00', endsAt: '2026-08-10T21:00:00+09:00',
          timeZone: 'Asia/Tokyo', location: '', description: '詳細は案内を参照',
        }],
        tasks: [],
      }) } }] });
      return Response.json({ id: 'calendar-event-rule-repair' });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toEqual({ scanned: 1, created: 1, skipped: 0, exceptions: 0 });

    expect(requests.some((url) => url.includes('ai.example.com'))).toBe(true);
    expect(fixture.organization.rows<{ name: string; status: string }>('SELECT name, status FROM rules')).toEqual([
      { name: 'All incoming mail', status: 'active' },
    ]);
  });

  it('keeps selective rules while adding a lower-priority catch-all for otherwise unmatched mail', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute("UPDATE rules SET selection_policy = '{\"sender\":\"trusted@example.com\"}' WHERE id = 'rule-1'");
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      if (url.includes('/history')) return Response.json({
        historyId: 'history-after-selective-rule',
        history: [{ messagesAdded: [{ message: { id: 'unmatched-ordinary-message' } }] }],
      });
      if (url.includes('/messages/unmatched-ordinary-message')) return sourceMessageResponse({
        subject: '一般のお知らせ', body: '今月のお知らせです。',
      });
      if (url.includes('ai.example.com')) return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '今月のお知らせです。', events: [], tasks: [],
      }) } }] });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(requests.some((url) => url.includes('ai.example.com'))).toBe(true);
    expect(fixture.organization.rows<{ name: string; priority: number }>(
      'SELECT name, priority FROM rules ORDER BY priority DESC',
    )).toEqual([
      { name: 'All dated Source Messages', priority: 0 },
      { name: 'All incoming mail', priority: -1 },
    ]);
  });

  it('reprocesses messages that legacy Automation previously marked as skipped', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute(
      `INSERT INTO source_messages
        (id, gmail_message_id, gmail_history_id, sender, subject, received_at, processed_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped')`,
      'source-previously-skipped',
      'previously-skipped-message',
      'history-before-connection',
      'member@example.com',
      '会員向けのお知らせ',
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    );
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/messages/previously-skipped-message')) return sourceMessageResponse({
        subject: '会員向けのお知らせ', body: '今月のお知らせです。',
      });
      if (url.includes('ai.example.com')) return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '今月のお知らせです。', events: [], tasks: [],
      }) } }] });
      if (url.includes('/history')) return Response.json({ historyId: 'history-after-repair' });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(fixture.organization.row<{ state: string }>(
      "SELECT state FROM source_messages WHERE id = 'source-previously-skipped'",
    )).toEqual({ state: 'processed' });
    const baseline = fixture.organization.row<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'baseline-schema-rule:v1'",
    );
    expect(JSON.parse(baseline?.value ?? '{}')).toMatchObject({ repairSkipped: false });
  });

  it('does not silently use literal date parsing when an AI Connection is missing', async () => {
    fixture = await createAutomationTestApp();
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      if (url.includes('/history')) return Response.json({
        historyId: 'history-after-missing-ai',
        history: [{ messagesAdded: [{ message: { id: 'dated-message-without-ai' } }] }],
      });
      if (url.includes('/messages/dated-message-without-ai')) return sourceMessageResponse();
      return Response.json({ id: 'calendar-event-should-not-exist' });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).rejects.toThrow('自動化を実行する前に OpenAI 互換 API を設定してください。');
    await runEnabledAutomations(fixture.environment);
    expect(requests).toEqual([]);
    expect(fixture.organization.rows('SELECT * FROM source_messages')).toEqual([]);
    expect(fixture.organization.row<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM google_connections WHERE kind = 'automation_inbox'",
    )).toEqual({
      status: 'active',
      last_error: '自動化を実行する前に OpenAI 互換 API を設定してください。',
    });
  });

  it('continues past a Gmail history entry whose message was deleted and persists the new boundary', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/history')) return Response.json({
        historyId: 'history-after-deleted-message',
        history: [{ messagesAdded: [
          { message: { id: 'deleted-message' } },
          { message: { id: 'ordinary-message-after-delete' } },
        ] }],
      });
      if (url.includes('/messages/deleted-message')) return Response.json({
        error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' },
      }, { status: 404 });
      if (url.includes('/messages/ordinary-message-after-delete')) return sourceMessageResponse({
        subject: '会員向けのお知らせ', body: '今月のお知らせです。',
      });
      if (url.includes('ai.example.com')) return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '今月のお知らせです。', events: [], tasks: [],
      }) } }] });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(fixture.organization.row<{ gmail_history_id: string }>(
      "SELECT gmail_history_id FROM google_connections WHERE kind = 'automation_inbox'",
    )).toEqual({ gmail_history_id: 'history-after-deleted-message' });
  });

  it('executes an unattended Agent Rule LINE write once and records a failed delivery without retry work', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    fixture.organization.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    const lineList = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', { kind: 'line', name: 'Writers' }), fixture.environment);
    const lineListId = (await lineList.json() as { data: { id: string } }).data.id;
    await app.fetch(fixture.jsonRequest(`/api/organizations/organization-1/lists/${lineListId}/items`, { value: 'line-user-1', label: 'Writer' }), fixture.environment);
    const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', { name: 'Writer', instructions: 'Notify.' }), fixture.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;
    await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: 'Writer', promptId, state: 'active', executionMode: 'unattended', selectionPolicy: {}, permittedLineListIds: [lineListId],
    }), fixture.environment);
    let turn = 0;
    const complete = vi.fn(async () => turn++ === 0
      ? { model: 'test-model', content: '', toolCalls: [{ id: 'line-call', name: 'send_line_message' as const, arguments: '{"destination":"line-user-1","message":"Practice moved."}' }], totalTokens: 10 }
      : { model: 'test-model', content: 'done', toolCalls: [], totalTokens: 5 });
    const linePush = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', linePush);
    const automation = createAutomation(fixture.environment, {
      google: { request: async <T>(_token: string, url: string): Promise<T> => {
        if (url.includes('/history')) return { historyId: 'history-write', history: [{ messagesAdded: [{ message: { id: 'gmail-write' } }] }] } as T;
        if (url.includes('/messages/gmail-write')) return { id: 'gmail-write', payload: { headers: [{ name: 'Subject', value: 'Notice' }, { name: 'From', value: 'member@example.com' }], body: { data: gmailBody('Moved.') } } } as T;
        throw new Error(`Unexpected Google request: ${url}`);
      } },
      agent: { complete },
    });

    await expect(automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding }))
      .resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(linePush).toHaveBeenCalledTimes(1);
    expect(fixture.organization.rows<{ destination: string; outcome: string }>('SELECT destination, outcome FROM deliveries')).toEqual([{ destination: 'line-user-1', outcome: 'failed' }]);
    expect(fixture.organization.rows('SELECT * FROM jobs')).toHaveLength(0);
    const run = fixture.organization.row<{ id: string }>('SELECT id FROM agent_runs')!;
    const transcript = await app.fetch(fixture.request(`/api/organizations/organization-1/agent-runs/${run.id}/transcript`), fixture.environment);
    const transcriptText = await transcript.text();
    expect(transcriptText).toContain('line-user-1');
    expect(transcriptText).toContain('planned');
    await expect(automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding }))
      .resolves.toEqual({ scanned: 0, created: 0, skipped: 0, exceptions: 0 });
    expect(linePush).toHaveBeenCalledTimes(1);
  });

  it('approves one frozen Rule Run batch without invoking the Agent again', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    fixture.organization.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    const lineList = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', { kind: 'line', name: 'Writers' }), fixture.environment);
    const lineListId = (await lineList.json() as { data: { id: string } }).data.id;
    await app.fetch(fixture.jsonRequest(`/api/organizations/organization-1/lists/${lineListId}/items`, { value: 'line-user-1', label: 'Writer' }), fixture.environment);
    const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', { name: 'Approver', instructions: 'Propose.' }), fixture.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;
    await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: 'Approver', promptId, state: 'active', executionMode: 'approval', selectionPolicy: {}, permittedLineListIds: [lineListId],
    }), fixture.environment);
    let turn = 0;
    const complete = vi.fn(async () => turn++ === 0
      ? { model: 'test-model', content: '', toolCalls: [{ id: 'proposal-call', name: 'send_line_message' as const, arguments: '{"destination":"line-user-1","message":"Exact approved text"}' }], totalTokens: 10 }
      : { model: 'test-model', content: 'Proposal recorded.', toolCalls: [], totalTokens: 5 });
    const linePush = vi.fn().mockResolvedValue(new Response('', { status: 200, headers: { 'x-line-request-id': 'line-approved' } }));
    vi.stubGlobal('fetch', linePush);
    const automation = createAutomation(fixture.environment, {
      google: { request: async <T>(_token: string, url: string): Promise<T> => {
        if (url.includes('/history')) return { historyId: 'history-approval', history: [{ messagesAdded: [{ message: { id: 'gmail-approval' } }] }] } as T;
        if (url.includes('/messages/gmail-approval')) return { id: 'gmail-approval', payload: { headers: [{ name: 'Subject', value: 'Notice' }, { name: 'From', value: 'member@example.com' }], body: { data: gmailBody('Review.') } } } as T;
        throw new Error(`Unexpected Google request: ${url}`);
      } }, agent: { complete },
    });

    await automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding });
    expect(linePush).not.toHaveBeenCalled();
    const run = fixture.organization.row<{ id: string }>('SELECT id FROM rule_runs')!;
    expect(fixture.organization.row<{ id: string }>('SELECT id FROM agent_runs')).toEqual(run);
    const runResponse = await app.fetch(fixture.request(`/api/organizations/organization-1/rule-runs/${run.id}`), fixture.environment);
    const pending = await runResponse.json() as { data: { sourceMessage: { subject: string; sender: string }; status: string; effects: Array<{ arguments: { destination: string; message: string }; status: string }> } };
    expect(pending.data).toMatchObject({
      sourceMessage: { subject: 'Notice', sender: 'member@example.com' },
      status: 'pending_approval',
      effects: [{ arguments: { destination: 'line-user-1', message: 'Exact approved text' }, status: 'pending' }],
    });

    const approved = await app.fetch(fixture.jsonRequest(`/api/organizations/organization-1/rule-runs/${run.id}/decision`, { decision: 'approve' }), fixture.environment);

    expect(approved.status).toBe(200);
    expect(linePush).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(fixture.organization.rows<{ destination: string; outcome: string }>('SELECT destination, outcome FROM deliveries')).toEqual([{ destination: 'line-user-1', outcome: 'succeeded' }]);
  });

  it('creates a Scheduled Event only for a permitted recipient destination in unattended mode', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    const recipientList = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', { kind: 'recipient', name: 'Guests' }), fixture.environment);
    const recipientListId = (await recipientList.json() as { data: { id: string } }).data.id;
    await app.fetch(fixture.jsonRequest(`/api/organizations/organization-1/lists/${recipientListId}/items`, { value: 'guest@example.com', label: 'Guest' }), fixture.environment);
    const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', { name: 'Scheduler', instructions: 'Schedule.' }), fixture.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;
    const agentRule = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: 'Scheduler', promptId, state: 'active', executionMode: 'unattended', selectionPolicy: {}, permittedRecipientListIds: [recipientListId],
    }), fixture.environment);
    const agentRuleId = (await agentRule.json() as { data: { id: string } }).data.id;
    let turn = 0;
    let calendarBody: Record<string, unknown> | undefined;
    const automation = createAutomation(fixture.environment, {
      google: { request: async <T>(_token: string, url: string, init?: RequestInit): Promise<T> => {
        if (url.includes('/history')) return { historyId: 'history-event-write', history: [{ messagesAdded: [{ message: { id: 'gmail-event-write' } }] }] } as T;
        if (url.includes('/messages/gmail-event-write')) return { id: 'gmail-event-write', payload: { headers: [{ name: 'Subject', value: 'Practice' }, { name: 'From', value: 'member@example.com' }], body: { data: gmailBody('Schedule.') } } } as T;
        if (url.includes('/calendar/')) { calendarBody = JSON.parse(init?.body as string) as Record<string, unknown>; return { id: 'google-agent-event' } as T; }
        throw new Error(`Unexpected Google request: ${url}`);
      } },
      agent: { complete: async () => turn++ === 0 ? {
        model: 'test-model', content: '', totalTokens: 10,
        toolCalls: [{ id: 'event-call', name: 'create_scheduled_event' as const, arguments: '{"destination":"guest@example.com","title":"Practice","startsAt":"2026-08-10T09:00:00+09:00","endsAt":"2026-08-10T10:00:00+09:00"}' }],
      } : { model: 'test-model', content: 'done', toolCalls: [], totalTokens: 5 } },
    });

    await expect(automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding }))
      .resolves.toEqual({ scanned: 1, created: 1, skipped: 0, exceptions: 0 });
    expect(calendarBody).toMatchObject({ summary: 'Practice', attendees: [{ email: 'guest@example.com' }] });
    expect(fixture.organization.rows<{ agent_rule_id: string; title: string; status: string }>('SELECT agent_rule_id, title, status FROM events')).toEqual([{ agent_rule_id: agentRuleId, title: 'Practice', status: 'scheduled' }]);
    expect(fixture.organization.rows<{ destination: string; outcome: string }>('SELECT destination, outcome FROM deliveries')).toEqual([{ destination: 'guest@example.com', outcome: 'succeeded' }]);
  });

  it('runs each matching read-only Agent Rule once with only Organization query tools', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    fixture.organization.execute(
      "INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-existing', 'gmail-existing', 'history-existing', 'member@example.com', '既存行事', '2026-08-01', 'processed')",
    );
    seedScheduledEvent(fixture.organization, { id: 'event-existing', title: '既存行事' });
    seedAttendanceRegistration(fixture.organization, {
      eventId: 'event-existing', memberId: 'recipient-existing', destination: 'reader@example.com', status: 'attending',
    });
    fixture.organization.execute(
      "INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_role_id, assignee_role_name, description, created_at, updated_at) VALUES ('task-existing', 'organization-1', 'source-existing', '既存行事', '資料確認', '2026-08-10', 'unassigned', '未割り当て', '資料を確認する', '2026-08-01', '2026-08-01')",
    );
    const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', {
      name: 'Read-only analyst', instructions: 'Inspect the Source Message and Organization records.',
    }), fixture.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;
    const agentRule = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: 'Example.com analyst', promptId, state: 'active', executionMode: 'read_only', selectionPolicy: { domain: 'example.com' },
    }), fixture.environment);
    expect(agentRule.status).toBe(201);

    const requests: Array<{ messages: Array<{ role: string; name?: string; content?: string }> }> = [];
    const complete = vi.fn(async (request: { messages: Array<{ role: string; name?: string; content?: string }> }) => {
      requests.push(request);
      if (requests.length === 1) return {
        model: 'test-model',
        content: '',
        toolCalls: [
          { id: 'tool-source', name: 'read_source_message' as const, arguments: '{}' },
          { id: 'tool-events', name: 'query_scheduled_events' as const, arguments: '{}' },
          { id: 'tool-tasks', name: 'query_tasks' as const, arguments: '{}' },
          { id: 'tool-attendance', name: 'query_attendance' as const, arguments: '{}' },
        ],
        totalTokens: 400,
      };
      return { model: 'test-model', content: 'Read-only review complete.', toolCalls: [], totalTokens: 120 };
    });
    const googleRequests: string[] = [];
    const automation = createAutomation(fixture.environment, {
      google: { request: async <T>(_token: string, url: string): Promise<T> => {
        googleRequests.push(url);
        if (url.includes('/history')) return { historyId: 'history-agent', history: [{ messagesAdded: [{ message: { id: 'gmail-agent' } }] }] } as T;
        if (url.includes('/messages/gmail-agent')) return { id: 'gmail-agent', payload: {
          headers: [{ name: 'Subject', value: '例会のお知らせ' }, { name: 'From', value: 'member@example.com' }],
          body: { data: gmailBody('日時: 2026年8月3日 19:00〜21:30') },
        } } as T;
        throw new Error(`Unexpected Google request: ${url}`);
      } },
      agent: { complete },
      ai: {
        extract: async () => ({ kind: 'invitation' as const, summary: '例会のお知らせです。', events: [], tasks: [], guests: [], warnings: [] }),
        correspond: async () => [],
      },
    });

    await expect(automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding }))
      .resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(complete).toHaveBeenCalledTimes(2);
    const toolResults = requests[1]?.messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n') ?? '';
    expect(toolResults).toContain('例会のお知らせ');
    expect(toolResults).toContain('既存行事');
    expect(toolResults).toContain('資料確認');
    expect(toolResults).toContain('attending');
    expect(googleRequests.some((url) => url.includes('/calendar/'))).toBe(false);
  });

  it('fetches and converts one Source Message once for its Primary Schema Rule and every matching Agent Rule', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    for (const suffix of ['one', 'two']) {
      const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', {
        name: `Analyst ${suffix}`, instructions: `Review ${suffix}.`,
      }), fixture.environment);
      const promptId = (await prompt.json() as { data: { id: string } }).data.id;
      const created = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
        name: `Agent ${suffix}`, promptId, state: 'active', selectionPolicy: { domain: 'example.com' },
      }), fixture.environment);
      expect(created.status).toBe(201);
    }
    const toMarkdown = vi.fn(async () => ({ format: 'markdown' as const, name: 'agenda.pdf', mimetype: 'application/pdf', tokens: 4, data: 'Converted agenda' }));
    fixture.environment.AI = { toMarkdown };
    const read = vi.fn(async () => [{ attachmentId: 'attachment-1', filename: 'agenda.pdf', mimeType: 'application/pdf', size: 12, data: btoa('agenda') }]);
    const extract = vi.fn(async (input: Parameters<typeof extractAiEventDetails>[0]) => extractAiEventDetails({
      ...input,
      fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '例会です。',
        events: [{ title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '例会です' }],
        tasks: [],
      }) } }] }),
    }));
    const agentRequests: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    const complete = vi.fn(async (request: { messages: Array<{ role: string; content?: string }> }) => {
      agentRequests.push(request);
      return request.messages.some((message) => message.role === 'tool')
        ? { model: 'test-model', content: 'Reviewed.', toolCalls: [], totalTokens: 20 }
        : { model: 'test-model', content: '', toolCalls: [{ id: crypto.randomUUID(), name: 'read_source_message' as const, arguments: '{}' }], totalTokens: 20 };
    });
    const googleRequests: string[] = [];
    const automation = createAutomation(fixture.environment, {
      google: { request: async <T>(_token: string, url: string): Promise<T> => {
        googleRequests.push(url);
        if (url.includes('/history')) return { historyId: 'history-shared', history: [{ messagesAdded: [{ message: { id: 'gmail-shared' } }] }] } as T;
        if (url.includes('/messages/gmail-shared')) return { id: 'gmail-shared', payload: {
          headers: [{ name: 'Subject', value: '例会のお知らせ' }, { name: 'From', value: 'member@example.com' }],
          body: { data: gmailBody('日時: 2026年8月3日 19:00〜21:30') },
          parts: [{ filename: 'agenda.pdf', mimeType: 'application/pdf', body: { attachmentId: 'attachment-1', size: 12 } }],
        } } as T;
        return { id: 'calendar-shared' } as T;
      } },
      attachments: {
        read,
        publish: async () => ({ outcome: 'succeeded', driveFileId: 'drive-1', publicUrl: 'https://drive.example/agenda' }),
        ensurePath: async () => 'attachment-folder-path',
        createMessageFolder: async () => 'source-message-folder',
        find: async () => null,
      },
      ai: { extract, correspond: async () => [] },
      agent: { complete },
    });

    await expect(automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding }))
      .resolves.toEqual({ scanned: 1, created: 1, skipped: 0, exceptions: 0 });
    expect(googleRequests.filter((url) => url.includes('/messages/gmail-shared'))).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(4);
    expect(agentRequests.flatMap((request) => request.messages).filter((message) => message.role === 'tool').map((message) => message.content).join('\n'))
      .toContain('Converted agenda');
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
    fixture.organization.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', {
      name: 'Bounded analyst', instructions: 'Inspect the Source Message.',
    }), fixture.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;
    await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: 'Bounded Agent', promptId, state: 'active', selectionPolicy: {},
    }), fixture.environment);
    const complete = vi.fn(async () => ({
      model: 'test-model', content: '', totalTokens: 10,
      toolCalls: Array.from({ length: MAX_AGENT_TOOL_CALLS + 1 }, (_, index) => ({ id: `tool-${index}`, name: 'read_source_message' as const, arguments: '{}' })),
    }));
    const automation = createAutomation(fixture.environment, {
      google: { request: async <T>(_token: string, url: string): Promise<T> => {
        if (url.includes('/history')) return { historyId: 'history-bounded', history: [{ messagesAdded: [{ message: { id: 'gmail-bounded' } }] }] } as T;
        if (url.includes('/messages/gmail-bounded')) return { id: 'gmail-bounded', payload: {
          headers: [{ name: 'Subject', value: 'お知らせ' }, { name: 'From', value: 'member@example.com' }],
          body: { data: gmailBody('確認してください。') },
        } } as T;
        throw new Error(`Unexpected Google request: ${url}`);
      } },
      agent: { complete },
    });

    await expect(automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding }))
      .resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 1 });
    await expect(automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding }))
      .resolves.toEqual({ scanned: 0, created: 0, skipped: 0, exceptions: 0 });
    const exceptions = await app.fetch(fixture.request('/api/organizations/organization-1/operations/exceptions'), fixture.environment);
    await expect(exceptions.json()).resolves.toMatchObject({ data: [{
      code: 'agent_rule_run_failed',
      message: `Agent Rule tool-call maximum of ${MAX_AGENT_TOOL_CALLS} was exceeded.`,
      state: 'open',
    }] });
    const runs = await app.fetch(fixture.request('/api/organizations/organization-1/agent-runs'), fixture.environment);
    const runsBody = await runs.json() as { data: Array<{ id: string }> };
    expect(runsBody).toMatchObject({ data: [{
      outcome: 'failed',
      toolCallCount: MAX_AGENT_TOOL_CALLS + 1,
      tokens: 10,
    }] });
    const transcript = await app.fetch(fixture.request(
      `/api/organizations/organization-1/agent-runs/${runsBody.data[0]?.id}/transcript`,
    ), fixture.environment);
    await expect(transcript.json()).resolves.toMatchObject({ data: {
      error: `Agent Rule tool-call maximum of ${MAX_AGENT_TOOL_CALLS} was exceeded.`,
    } });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('indexes every Agent Rule run in D1 and exposes its encrypted R2 Run Transcript', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
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
    const automation = createAutomation(fixture.environment, {
      google: { request: async <T>(_token: string, url: string): Promise<T> => {
        if (url.includes('/history')) return { historyId: 'history-transcript', history: [{ messagesAdded: [{ message: { id: 'gmail-transcript' } }] }] } as T;
        if (url.includes('/messages/gmail-transcript')) return { id: 'gmail-transcript', payload: {
          headers: [{ name: 'Subject', value: 'Confidential notice' }, { name: 'From', value: 'member@example.com' }],
          body: { data: gmailBody('Secret Source Message body') },
        } } as T;
        throw new Error(`Unexpected Google request: ${url}`);
      } },
      agent: { complete: async (request) => {
        expect(request.messages[0]?.content).toContain('Explain the current Source Message carefully.');
        return { model: 'audited-model', content: 'No action required.', toolCalls: [], totalTokens: 321 };
      } },
    });

    await automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding });
    const runs = await app.fetch(fixture.request('/api/organizations/organization-1/agent-runs'), fixture.environment);
    const runsBody = await runs.json() as { data: Array<{ id: string; agentRuleId: string; promptId: string; promptRevision: number; model: string; outcome: string; toolCallCount: number; tokens: number; expiresAt: string }> };
    const transcript = await app.fetch(fixture.request(
      `/api/organizations/organization-1/agent-runs/${runsBody.data[0]?.id}/transcript`,
    ), fixture.environment);

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

  it('keeps events and tasks when one extracted role is unknown and raises an Automation Warning', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const createdRole = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/task-roles',
      { displayName: '参加登録担当', description: '出欠と申込期限を扱う' },
    ), fixture.environment);
    expect(createdRole.status).toBe(201);
    const role = (await createdRole.json() as { data: { id: string } }).data;
    const rule = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/rules', {
      name: 'Role-aware extraction', state: 'active', priority: 10, taskRoleIds: [role.id],
    }), fixture.environment);
    expect(rule.status).toBe(201);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/history')) return new Response(JSON.stringify({
        historyId: 'history-after-warning',
        history: [{ messagesAdded: [{ message: { id: 'gmail-message-warning' } }] }],
      }), { status: 200 });
      if (url.includes('/messages/gmail-message-warning')) return sourceMessageResponse();
      if (url.includes('ai.example.com')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: '例会と二つの期限の案内です。',
        events: [{
          title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00',
          timeZone: 'Asia/Tokyo', location: '', description: '例会です',
        }],
        tasks: [
          { title: '出席登録を確認する', deadline: '2026-07-31', assigneeRoleId: role.id, description: '登録状況を確認する' },
          { title: '資料を確認する', deadline: '2026-08-01', assigneeRoleId: 'removed-role', description: '資料を確認する' },
        ],
      }) } }] }), { status: 200 });
      return new Response(JSON.stringify({ id: 'calendar-event-warning' }), { status: 200 });
    }));

    await runEnabledAutomations(fixture.environment);

    const tasks = await app.fetch(fixture.request('/api/organizations/organization-1/tasks'), fixture.environment);
    await expect(tasks.json()).resolves.toMatchObject({ data: [
      { assigneeRoleId: role.id, assigneeRoleName: '参加登録担当' },
      { assigneeRoleId: 'unassigned', assigneeRoleName: '未割り当て' },
    ] });
    const unassignedTasks = await app.fetch(fixture.request('/api/organizations/organization-1/tasks?assignee=unassigned'), fixture.environment);
    await expect(unassignedTasks.json()).resolves.toMatchObject({ data: [
      { title: '資料を確認する', assigneeRoleId: 'unassigned' },
    ] });
    const warnings = await app.fetch(fixture.request('/api/organizations/organization-1/automation-warnings'), fixture.environment);
    expect(warnings.status).toBe(200);
    await expect(warnings.json()).resolves.toMatchObject({ data: [{ code: 'task_role_unmatched' }] });
    const dashboard = await app.fetch(fixture.request('/api/organizations/organization-1/dashboard'), fixture.environment);
    await expect(dashboard.json()).resolves.toMatchObject({ data: { upcomingEvents: 1 } });
  });

  it('creates one named Task from a Source Message and does not duplicate it when the inbox run is retried', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const createdRole = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '参加登録担当', description: '出欠と申込期限を扱う',
    }), fixture.environment);
    const roleId = (await createdRole.json() as { data: { id: string } }).data.id;
    const createdMember = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/members', {
      name: '山田花子', email: 'hanako@example.com',
    }), fixture.environment);
    const memberId = (await createdMember.json() as { data: { id: string } }).data.id;
    const assignment = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/task-roles/${roleId}/assignment`,
      { memberId },
      'PUT',
    ), fixture.environment);
    expect(assignment.status).toBe(200);
    const rule = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/rules', {
      name: 'Task extraction', state: 'active', priority: 10, taskRoleIds: [roleId],
    }), fixture.environment);
    expect(rule.status).toBe(201);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/history')) return new Response(JSON.stringify({
        historyId: 'history-after-connection',
        history: [{ messagesAdded: [{ message: { id: 'gmail-message-task-1' } }] }],
      }), { status: 200 });
      if (url.includes('/messages/gmail-message-task-1')) return sourceMessageResponse();
      if (url.includes('ai.example.com')) return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          events: [{
            title: '例会',
            startsAt: '2026-08-03T19:00:00+09:00',
            endsAt: '2026-08-03T21:30:00+09:00',
            timeZone: 'Asia/Tokyo',
            location: '',
            description: '例会です',
          }],
          tasks: [{
            title: '出席を取りまとめる',
            deadline: '2026-07-31',
            assigneeRoleId: roleId,
            description: '出席登録を確認する',
          }],
        }) } }],
      }), { status: 200 });
      return new Response(JSON.stringify({ id: 'calendar-event-task-1' }), { status: 200 });
    }));

    await runEnabledAutomations(fixture.environment);
    await runEnabledAutomations(fixture.environment);
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
  });

  it('creates a Scheduled Event through the Automation interface with an injected Google adapter', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const automation = createAutomation(fixture.environment, {
      google: {
        request: async <T>(_accessToken: string, url: string): Promise<T> => {
          if (url.includes('/history')) return {
            historyId: 'history-after-connection',
            history: [{ messagesAdded: [{ message: { id: 'gmail-message-port' } }] }],
          } as T;
          if (url.includes('/messages/gmail-message-port')) return {
            id: 'gmail-message-port',
            payload: {
              headers: [
                { name: 'Subject', value: '例会のお知らせ' },
                { name: 'From', value: 'member@example.com' },
              ],
              body: { data: gmailBody('日時: 2026年8月3日 19:00〜21:30') },
            },
          } as T;
          return { id: 'calendar-event-port' } as T;
        },
      },
      ai: {
        correspond: async () => [],
        extract: async () => ({
          kind: 'invitation' as const,
          summary: '例会のお知らせです。',
          events: [{
            title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00',
            timeZone: 'Asia/Tokyo', location: '', description: '例会です。', summary: '毎月の例会です。',
          }],
          tasks: [],
          guests: [],
          warnings: [],
        }),
      },
    });

    await expect(automation.runOrganization({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
    })).resolves.toEqual({ scanned: 1, created: 1, skipped: 0, exceptions: 0 });
    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );
    await expect(dashboard.json()).resolves.toMatchObject({ data: { upcomingEvents: 1 } });
    expect(fixture.organization.rows<{ status: string; execution_mode: string }>(
      'SELECT status, execution_mode FROM rule_runs',
    )).toEqual([{ status: 'completed', execution_mode: 'unattended' }]);
  });

  it.each([
    ['read_only', 'read_only', 'planned'],
    ['approval', 'pending_approval', 'pending'],
  ] as const)('plans a Schema Rule in %s mode without business mutations', async (executionMode, runStatus, effectStatus) => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute('UPDATE rules SET execution_mode = ? WHERE id = ?', executionMode, 'rule-1');
    const calendarWrite = vi.fn();
    const automation = createAutomation(fixture.environment, {
      google: {
        request: async <T>(_accessToken: string, url: string): Promise<T> => {
          if (url.includes('/history')) return {
            historyId: `history-${executionMode}`,
            history: [{ messagesAdded: [{ message: { id: `gmail-${executionMode}` } }] }],
          } as T;
          if (url.includes(`/messages/gmail-${executionMode}`)) return {
            id: `gmail-${executionMode}`,
            payload: {
              headers: [{ name: 'Subject', value: '例会' }, { name: 'From', value: 'member@example.com' }],
              body: { data: gmailBody('日時: 2026年8月3日 19:00〜21:00') },
            },
          } as T;
          if (url.includes('/calendar/v3/calendars/primary/events')) return { items: [] } as T;
          calendarWrite(url);
          return { id: 'must-not-be-created' } as T;
        },
      },
      ai: {
        correspond: async () => [],
        extract: async () => ({
          kind: 'invitation' as const,
          summary: '例会です。',
          events: [{
            title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00',
            timeZone: 'Asia/Tokyo', location: '', description: '例会', summary: '例会',
          }],
          tasks: [{ title: '準備', deadline: '2026-08-02', assigneeRoleId: 'unassigned', description: '準備する' }],
          guests: [], warnings: [],
        }),
      },
    });

    await expect(automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding }))
      .resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });

    expect(calendarWrite).not.toHaveBeenCalled();
    expect(fixture.organization.rows('SELECT * FROM events')).toHaveLength(0);
    expect(fixture.organization.rows('SELECT * FROM tasks')).toHaveLength(0);
    expect(fixture.organization.rows<{ status: string }>('SELECT status FROM rule_runs')).toEqual([{ status: runStatus }]);
    expect(fixture.organization.rows<{ status: string }>('SELECT status FROM rule_effects')).toHaveLength(3);
    expect(fixture.organization.rows<{ status: string }>('SELECT status FROM rule_effects').every(({ status }) => status === effectStatus)).toBe(true);
  });

  const upsertFixture = (active: AutomationTestApp, extractions: Array<() => MailExtraction>) => {
    const created: Array<Record<string, string>> = [];
    const patched: Array<{ url: string; body: Record<string, string> }> = [];
    const meeting = {
      id: 'calendar-event-upsert',
      etag: 'etag-1',
      summary: '例会',
      description: '',
      location: '',
      start: { dateTime: '2026-08-03T19:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-08-03T21:00:00+09:00', timeZone: 'Asia/Tokyo' },
    };
    let run = 0;
    const messageId = (): string => `gmail-message-upsert-${run}`;
    const google = {
      request: async <T>(_accessToken: string, url: string, init?: RequestInit): Promise<T> => {
        if (url.includes('/history')) return {
          historyId: `history-${run}`,
          history: [{ messagesAdded: [{ message: { id: messageId() } }] }],
        } as T;
        if (url.includes(`/messages/${messageId()}`)) return {
          id: messageId(),
          payload: {
            headers: [{ name: 'Subject', value: '例会のお知らせ' }, { name: 'From', value: 'chair@example.com' }],
            body: { data: gmailBody('日時: 2026年8月3日 19:00〜21:00') },
          },
        } as T;
        if (url.includes('/calendar/') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string) as Record<string, string>;
          created.push(body);
          meeting.description = body.description ?? '';
          meeting.location = body.location ?? '';
          return { id: meeting.id, etag: meeting.etag } as T;
        }
        if (url.includes('/calendar/') && init?.method === 'PATCH') {
          const body = JSON.parse(init.body as string) as Record<string, string>;
          patched.push({ url, body });
          if (body.description !== undefined) meeting.description = body.description;

          return { id: meeting.id, etag: 'etag-2' } as T;
        }
        return { items: created.length ? [meeting] : [] } as T;
      },
    };
    const automation = () => createAutomation(active.environment, {
      google,
      ai: {
        correspond: async (input) => input.existing.map((event) => ({ candidateIndex: 0, eventId: event.id })),
        extract: async () => extractions[run] ? extractions[run]!() : null,
      },
    });
    const runOnce = async (index: number) => {
      run = index;
      return automation().runOrganization({
        organizationId: 'organization-1',
        database: active.organization.binding,
      });
    };
    return { created, patched, runOnce };
  };

  const meetingExtraction = (overrides: Partial<MailExtraction> = {}): MailExtraction => ({
    kind: 'invitation',
    summary: '例会のお知らせです。',
    events: [{
      title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00',
      timeZone: 'Asia/Tokyo', location: '本部会館', description: '例会です。', summary: '毎月の例会です。',
    }],
    tasks: [],
    guests: [],
    warnings: [],
    ...overrides,
  });

  it('merges a later message about the same meeting instead of creating a second Scheduled Event', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { created, patched, runOnce } = upsertFixture(fixture, [
      () => meetingExtraction(),
      () => meetingExtraction({
        summary: '会場が変わりました。',
        events: [{
          title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00',
          timeZone: 'Asia/Tokyo', location: '市民ホール', description: '例会です。', summary: '会場が変わりました。',
        }],
      }),
    ]);

    await runOnce(0);
    await runOnce(1);

    expect(created).toHaveLength(1);
    expect(patched).toHaveLength(1);
    expect(patched[0]?.body.location).toBe('市民ホール');
    // A moved meeting is a Significant Change, so its Members are told.
    expect(patched[0]?.url).toContain('sendUpdates=all');
    expect(fixture.organization.rows('SELECT count(*) AS total FROM events')).toEqual([{ total: 1 }]);
  });

  it('records the guests an Event Response returned without creating a Scheduled Event for it', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { created, patched, runOnce } = upsertFixture(fixture, [
      () => meetingExtraction(),
      () => meetingExtraction({
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

    expect(created).toHaveLength(1);
    expect(fixture.organization.rows('SELECT count(*) AS total FROM events')).toEqual([{ total: 1 }]);
    expect(fixture.organization.rows(
      'SELECT name, affiliation FROM guest_registrations ORDER BY name',
    )).toEqual([
      { name: '山田太郎', affiliation: '北クラブ' },
      { name: '鈴木花子', affiliation: '北クラブ' },
    ]);
    expect(patched[0]?.body.description).toContain('外部からの参加登録: 1団体 2名（北クラブ 2名）');
    expect(patched[0]?.body.description).not.toContain('山田太郎');
    // A guest moves neither the meeting nor its deadline, so this is never news to a Member.
    expect(patched[0]?.url).toContain('sendUpdates=none');
  });

  it('creates nothing for an Event Response that locates no Scheduled Event', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const { created, patched, runOnce } = upsertFixture(fixture, [
      () => meetingExtraction({ kind: 'response', summary: 'OKです。' }),
    ]);

    await expect(runOnce(0)).resolves.toMatchObject({ created: 0, exceptions: 0 });
    expect(created).toEqual([]);
    expect(patched).toEqual([]);
    expect(fixture.organization.rows('SELECT count(*) AS total FROM events')).toEqual([{ total: 0 }]);
  });

  it('runs an Automation Inbox only after an authorized member enables it', async () => {
    fixture = await createAutomationTestApp({ enabled: false, ai: true });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify({ historyId: 'history-after-connection' }), { status: 200 });
    }));

    await runEnabledAutomations(fixture.environment);
    const enabled = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/automation/enabled',
      { enabled: true },
    ), fixture.environment);
    await runEnabledAutomations(fixture.environment);

    expect(enabled.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('/gmail/v1/users/me/history');
  });

  it('resumes each Gmail read from the last successfully persisted history boundary', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const boundaries: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const parsed = new URL(url);
      boundaries.push(parsed.searchParams.get('startHistoryId'));
      const historyId = boundaries.length === 1 ? 'history-after-first-run' : 'history-after-second-run';
      return new Response(JSON.stringify({ historyId }), { status: 200 });
    }));

    await runEnabledAutomations(fixture.environment);
    await runEnabledAutomations(fixture.environment);

    expect(boundaries).toEqual(['history-before-connection', 'history-after-first-run']);
    const status = await app.fetch(
      fixture.request('/api/organizations/organization-1/automation'),
      fixture.environment,
    );
    await expect(status.json()).resolves.toMatchObject({
      data: { email: 'automation@example.com', lastError: null },
    });
  });

  it('turns one newly discovered dated Source Message into one upcoming Scheduled Event', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      if (url.includes('/history')) {
        return new Response(JSON.stringify({
          historyId: 'history-after-connection',
          history: [{ messagesAdded: [{ message: { id: 'gmail-message-1' } }] }],
        }), { status: 200 });
      }
      if (url.includes('/messages/gmail-message-1')) return sourceMessageResponse();
      if (url.includes('ai.example.com')) return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '例会のお知らせです。',
        events: [{
          title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00',
          timeZone: 'Asia/Tokyo', location: '', description: '例会です。',
        }],
        tasks: [],
      }) } }] });
      return new Response(JSON.stringify({ id: 'calendar-event-1' }), { status: 200 });
    }));

    await runEnabledAutomations(fixture.environment);

    expect(requests).toContain('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );
    await expect(dashboard.json()).resolves.toMatchObject({
      data: { upcomingEvents: 1, exceptions: 0 },
    });
  });

  it('invites every active Member of the roster to the Scheduled Event it creates', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedMember(fixture.organization, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    seedMember(fixture.organization, { id: 'member-2', name: '二郎', email: 'second@example.com' });
    seedMember(fixture.organization, { id: 'member-3', name: '三郎' });
    let calendarUrl = '';
    let calendarRequest: { attendees?: Array<{ email?: string }> } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/history')) {
        return new Response(JSON.stringify({
          historyId: 'history-after-connection',
          history: [{ messagesAdded: [{ message: { id: 'gmail-message-1' } }] }],
        }), { status: 200 });
      }
      if (url.includes('/messages/gmail-message-1')) return sourceMessageResponse();
      if (url.includes('ai.example.com')) return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '例会のお知らせです。',
        events: [{
          title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00',
          timeZone: 'Asia/Tokyo', location: '', description: '例会です。',
        }],
        tasks: [],
      }) } }] });
      // The correlation search that precedes every insertion; no event exists yet.
      if (url.includes('timeMin=')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      calendarUrl = url;
      calendarRequest = JSON.parse(init?.body as string) as typeof calendarRequest;
      return new Response(JSON.stringify({ id: 'calendar-event-1' }), { status: 200 });
    }));

    await runEnabledAutomations(fixture.environment);

    expect(calendarUrl).toContain('sendUpdates=all');
    expect(calendarRequest.attendees).toEqual([
      { email: 'first@example.com' },
      { email: 'second@example.com' },
    ]);
    expect(fixture.organization.rows(
      "SELECT destination, outcome, external_id FROM deliveries WHERE channel = 'calendar' ORDER BY destination",
    )).toEqual([
      { destination: 'first@example.com', outcome: 'succeeded', external_id: 'calendar-event-1' },
      { destination: 'second@example.com', outcome: 'succeeded', external_id: 'calendar-event-1' },
    ]);
    expect(fixture.organization.rows('SELECT member_id, email_snapshot FROM event_recipients ORDER BY member_id')).toEqual([
      { member_id: 'member-1', email_snapshot: 'first@example.com' },
      { member_id: 'member-2', email_snapshot: 'second@example.com' },
    ]);
  });

  it('delivers a Message Summary for a matched Source Message with no Event Candidate', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute(
      "INSERT INTO lists (id, organization_id, kind, name, created_at, updated_at) VALUES ('recipients-1', 'organization-1', 'recipient', 'Readers', '2026-08-01', '2026-08-01')",
    );
    fixture.organization.execute(
      "INSERT INTO list_items (id, list_id, value, label, enabled) VALUES ('reader-1', 'recipients-1', 'reader@example.com', 'Reader', 1)",
    );
    fixture.organization.execute("INSERT INTO rule_permitted_recipient_lists (rule_id, list_id) VALUES ('rule-1', 'recipients-1')");
    const upstreamRequests: Array<{ url: string; body: string | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      upstreamRequests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.includes('/history')) return new Response(JSON.stringify({
        historyId: 'history-after-summary',
        history: [{ messagesAdded: [{ message: { id: 'gmail-message-summary' } }] }],
      }), { status: 200 });
      if (url.includes('/messages/gmail-message-summary')) return sourceMessageResponse();
      if (url.includes('ai.example.com')) return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: '次年度の活動方針を共有するお知らせです。',
          events: [],
          tasks: [],
        }) } }],
      }), { status: 200 });
      if (url.includes('/messages/send')) return new Response(JSON.stringify({ id: 'gmail-summary-delivery-1' }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });

    const emailRequests = upstreamRequests.filter(({ url }) => url.includes('/messages/send'));
    expect(emailRequests).toHaveLength(1);
    const raw = (JSON.parse(emailRequests[0]!.body ?? '{}') as { raw?: string }).raw ?? '';
    const paddedRaw = `${raw.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - raw.length % 4) % 4)}`;
    expect(new TextDecoder().decode(Uint8Array.from(atob(paddedRaw), (character) => character.charCodeAt(0))))
      .toContain('次年度の活動方針を共有するお知らせです。');
    expect(upstreamRequests.filter(({ url }) => url.includes('ai.example.com'))).toHaveLength(1);

    const audit = await app.fetch(
      fixture.request('/api/organizations/organization-1/audit/deliveries'),
      fixture.environment,
    );
    await expect(audit.json()).resolves.toMatchObject({
      data: [{
        sourceMessageId: expect.any(String),
        eventId: null,
        channel: 'email',
        destination: 'reader@example.com',
        outcome: 'succeeded',
        externalId: 'gmail-summary-delivery-1',
      }],
    });
  });

  it('delivers a Message Summary to the deduplicated destinations from every permitted list', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute(
      "INSERT INTO lists (id, organization_id, kind, name, created_at, updated_at) VALUES ('summary-readers-1', 'organization-1', 'recipient', 'Members', '2026-08-01', '2026-08-01')",
    );
    fixture.organization.execute(
      "INSERT INTO lists (id, organization_id, kind, name, created_at, updated_at) VALUES ('summary-readers-2', 'organization-1', 'recipient', 'Guests', '2026-08-01', '2026-08-01')",
    );
    fixture.organization.execute(
      "INSERT INTO list_items (id, list_id, value, label, enabled) VALUES ('summary-reader-1', 'summary-readers-1', 'member@example.com', 'Member', 1)",
    );
    fixture.organization.execute(
      "INSERT INTO list_items (id, list_id, value, label, enabled) VALUES ('summary-reader-2', 'summary-readers-2', 'guest@example.com', 'Guest', 1)",
    );
    fixture.organization.execute(
      "INSERT INTO list_items (id, list_id, value, label, enabled) VALUES ('summary-reader-duplicate', 'summary-readers-2', 'member@example.com', 'Member duplicate', 1)",
    );
    fixture.organization.execute(
      "INSERT INTO rule_permitted_recipient_lists (rule_id, list_id) VALUES ('rule-1', 'summary-readers-1'), ('rule-1', 'summary-readers-2')",
    );
    const upstreamRequests: Array<{ url: string; body: string | undefined }> = [];
    let deliveryIndex = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      upstreamRequests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.includes('/history')) return new Response(JSON.stringify({
        historyId: 'history-after-permitted-summaries',
        history: [{ messagesAdded: [{ message: { id: 'gmail-message-permitted-summaries' } }] }],
      }), { status: 200 });
      if (url.includes('/messages/gmail-message-permitted-summaries')) return sourceMessageResponse();
      if (url.includes('ai.example.com')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: '許可された読者へ送る要約です。', events: [], tasks: [],
      }) } }] }), { status: 200 });
      if (url.includes('/messages/send')) {
        deliveryIndex += 1;
        return new Response(JSON.stringify({ id: `gmail-summary-delivery-${deliveryIndex}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    await runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    );

    const emailRequests = upstreamRequests.filter(({ url }) => url.includes('/messages/send'));
    expect(emailRequests).toHaveLength(2);
    const deliveredMessages = emailRequests.map(({ body }) => {
      const raw = (JSON.parse(body ?? '{}') as { raw?: string }).raw ?? '';
      const paddedRaw = `${raw.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - raw.length % 4) % 4)}`;
      return new TextDecoder().decode(Uint8Array.from(atob(paddedRaw), (character) => character.charCodeAt(0)));
    });
    expect(deliveredMessages.join('\n')).toContain('To: member@example.com');
    expect(deliveredMessages.join('\n')).toContain('To: guest@example.com');
  });

  it('skips Message Summary channels with no permitted lists without failing the Source Message', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const upstreamRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      upstreamRequests.push(url);
      if (url.includes('/history')) return new Response(JSON.stringify({
        historyId: 'history-after-no-destinations',
        history: [{ messagesAdded: [{ message: { id: 'gmail-message-no-destinations' } }] }],
      }), { status: 200 });
      if (url.includes('/messages/gmail-message-no-destinations')) return sourceMessageResponse();
      if (url.includes('ai.example.com')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: '宛先なしの要約です。', events: [], tasks: [],
      }) } }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 0 });
    expect(upstreamRequests.some((url) => url.includes('/messages/send') || url.includes('api.line.me'))).toBe(false);
  });

  it('delivers exactly one Message Summary when one Source Message produces multiple Scheduled Events', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    fixture.organization.execute(
      "INSERT INTO lists (id, organization_id, kind, name, created_at, updated_at) VALUES ('line-readers-1', 'organization-1', 'line', 'LINE Readers', '2026-08-01', '2026-08-01')",
    );
    fixture.organization.execute(
      "INSERT INTO list_items (id, list_id, value, label, enabled) VALUES ('line-reader-1', 'line-readers-1', 'Usummary-reader-1', 'LINE Reader', 1)",
    );
    fixture.organization.execute("INSERT INTO rule_permitted_line_lists (rule_id, list_id) VALUES ('rule-1', 'line-readers-1')");
    const upstreamRequests: Array<{ url: string; body: string | undefined }> = [];
    let calendarIndex = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      upstreamRequests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.includes('/history')) return new Response(JSON.stringify({
        historyId: 'history-after-multiple-events',
        history: [{ messagesAdded: [{ message: { id: 'gmail-message-multiple-events' } }] }],
      }), { status: 200 });
      if (url.includes('/messages/gmail-message-multiple-events')) return sourceMessageResponse();
      if (url.includes('ai.example.com')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: '会議と懇親会を同日に開催します。',
        events: [
          { title: '会議', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T20:00:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '会議' },
          { title: '懇親会', startsAt: '2026-08-03T20:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '懇親会' },
        ],
        tasks: [],
      }) } }] }), { status: 200 });
      if (url.includes('api.line.me')) return new Response('', { status: 200, headers: { 'x-line-request-id': 'line-summary-delivery-1' } });
      if (url.includes('/calendar/v3/calendars/primary/events')) {
        calendarIndex += 1;
        return new Response(JSON.stringify({ id: `calendar-event-${calendarIndex}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toEqual({ scanned: 1, created: 2, skipped: 0, exceptions: 0 });

    const lineRequests = upstreamRequests.filter(({ url }) => url.includes('api.line.me'));
    expect(lineRequests).toHaveLength(1);
    expect(JSON.parse(lineRequests[0]!.body ?? '{}')).toEqual({
      to: 'Usummary-reader-1',
      messages: [{ type: 'text', text: '会議と懇親会を同日に開催します。' }],
    });
    expect(upstreamRequests.filter(({ url }) => url.includes('ai.example.com'))).toHaveLength(1);

    const audit = await app.fetch(
      fixture.request('/api/organizations/organization-1/audit/deliveries'),
      fixture.environment,
    );
    await expect(audit.json()).resolves.toMatchObject({
      data: [{
        sourceMessageId: expect.any(String),
        eventId: null,
        channel: 'line',
        outcome: 'succeeded',
        externalId: 'line-summary-delivery-1',
      }],
    });
  });

  it('creates an Automation Exception and no Scheduled Event for unsafe AI output', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/history')) {
        return new Response(JSON.stringify({
          historyId: 'history-after-connection',
          history: [{ messagesAdded: [{ message: { id: 'gmail-message-1' } }] }],
        }), { status: 200 });
      }
      if (url.includes('/messages/gmail-message-1')) return sourceMessageResponse();
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"title":"日時未定"}' } }],
      }), { status: 200 });
    }));

    await runEnabledAutomations(fixture.environment);

    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );
    const exceptions = await app.fetch(
      fixture.request('/api/organizations/organization-1/operations/exceptions'),
      fixture.environment,
    );
    await expect(dashboard.json()).resolves.toMatchObject({
      data: { upcomingEvents: 0, exceptions: 1 },
    });
    await expect(exceptions.json()).resolves.toMatchObject({
      data: [{ state: 'open' }],
    });
  });

  it('delivers an Intake Notice containing only sender and subject when intake fails before extraction', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute(
      "INSERT INTO lists (id, organization_id, kind, name, created_at, updated_at) VALUES ('intake-readers-1', 'organization-1', 'recipient', 'Intake Readers', '2026-08-01', '2026-08-01')",
    );
    fixture.organization.execute(
      "INSERT INTO list_items (id, list_id, value, label, enabled) VALUES ('intake-reader-1', 'intake-readers-1', 'intake-reader@example.com', 'Reader', 1)",
    );
    fixture.organization.execute("INSERT INTO rule_permitted_recipient_lists (rule_id, list_id) VALUES ('rule-1', 'intake-readers-1')");
    const upstreamRequests: Array<{ url: string; body: string | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      upstreamRequests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.includes('/history')) return new Response(JSON.stringify({
        historyId: 'history-after-intake-failure',
        history: [{ messagesAdded: [{ message: { id: 'gmail-message-intake-failure' } }] }],
      }), { status: 200 });
      if (url.includes('/messages/gmail-message-intake-failure')) return new Response(JSON.stringify({
        payload: {
          headers: [
            { name: 'Subject', value: '容量超過のお知らせ' },
            { name: 'From', value: 'sender@example.com' },
          ],
          body: { data: gmailBody('読者へ送ってはいけない本文です。') },
          parts: [{
            filename: 'secret.pdf',
            mimeType: 'application/pdf',
            body: { attachmentId: 'oversized', size: 20 * 1024 * 1024 + 1 },
          }],
        },
      }), { status: 200 });
      if (url.includes('/messages/send')) return new Response(JSON.stringify({ id: 'gmail-intake-delivery-1' }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toEqual({ scanned: 1, created: 0, skipped: 0, exceptions: 1 });

    const emailRequests = upstreamRequests.filter(({ url }) => url.includes('/messages/send'));
    expect(emailRequests).toHaveLength(1);
    const raw = (JSON.parse(emailRequests[0]!.body ?? '{}') as { raw?: string }).raw ?? '';
    const paddedRaw = `${raw.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - raw.length % 4) % 4)}`;
    const message = new TextDecoder().decode(Uint8Array.from(atob(paddedRaw), (character) => character.charCodeAt(0)));
    expect(message.split('\r\n\r\n')[1]).toBe('差出人: sender@example.com\r\n件名: 容量超過のお知らせ');
    expect(message).not.toContain('読者へ送ってはいけない本文です。');
    expect(message).not.toContain('secret.pdf');
    expect(upstreamRequests.some(({ url }) => url.includes('ai.example.com'))).toBe(false);

    const audit = await app.fetch(
      fixture.request('/api/organizations/organization-1/audit/deliveries'),
      fixture.environment,
    );
    await expect(audit.json()).resolves.toMatchObject({
      data: [{
        sourceMessageId: expect.any(String),
        eventId: null,
        channel: 'email',
        destination: 'intake-reader@example.com',
        outcome: 'succeeded',
        externalId: 'gmail-intake-delivery-1',
      }],
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
    const gmailDocx = docx.toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    let aiRequest: { messages?: Array<{ role?: string; content?: string }> } = {};
    let calendarUrl = '';
    let calendarRequest: {
      description?: string;
      attachments?: Array<{ fileUrl?: string; title?: string; mimeType?: string }>;
    } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/history')) {
        return new Response(JSON.stringify({
          historyId: 'history-after-connection',
          history: [{ messagesAdded: [{ message: { id: 'gmail-message-docx' } }] }],
        }), { status: 200 });
      }
      if (url.includes('/attachments/attachment-docx')) {
        return new Response(JSON.stringify({ data: gmailDocx }), { status: 200 });
      }
      if (url.includes('/messages/gmail-message-docx')) {
        return new Response(JSON.stringify({
          id: 'gmail-message-docx',
          internalDate: '1775520720000',
          payload: {
            headers: [
              { name: 'Subject', value: '式典のお知らせ' },
              { name: 'From', value: 'member@example.com' },
            ],
            body: { data: gmailBody('日時は添付ファイルをご確認ください。') },
            parts: [{
              filename: '式典案内.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              body: { attachmentId: 'attachment-docx', size: docx.byteLength },
            }],
          },
        }), { status: 200 });
      }
      if (url.includes('ai.example.com')) {
        aiRequest = JSON.parse(init?.body as string) as typeof aiRequest;
        const normalizedText = aiRequest.messages?.[1]?.content ?? '';
        if (!normalizedText.includes('FILE-PROBE-001')
          || !normalizedText.includes('2026-08-18')
          || !normalizedText.includes('14:30')
          || !normalizedText.includes('16:00')) {
          return new Response(JSON.stringify({
            error: { message: 'Normalized DOCX content was not provided.' },
          }), { status: 400 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            title: '式典',
            startsAt: '2026-09-12T14:00:00+09:00',
            endsAt: '2026-09-12T16:00:00+09:00',
            timeZone: 'Asia/Tokyo',
            location: '名古屋',
            description: '添付DOCXから抽出',
            summary: '式典の案内です。受付は開始30分前からです。',
          }) } }],
        }), { status: 200 });
      }
      if (url.includes('upload/drive')) {
        return new Response(JSON.stringify({ id: 'drive-file-docx', webViewLink: 'https://drive.example/docx' }), { status: 200 });
      }
      if (url.includes('/permissions')) return new Response('', { status: 200 });
      if (url.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
        calendarUrl = url;
        calendarRequest = JSON.parse(init.body as string) as typeof calendarRequest;
      }
      return new Response(JSON.stringify({ id: 'calendar-event-docx' }), { status: 200 });
    }));

    await runEnabledAutomations(fixture.environment);

    expect(aiRequest.messages?.[1]?.content).toContain('FILE-PROBE-001');
    expect(aiRequest.messages?.[0]?.content)
      .toContain('{"receivedAt":"2026-04-07T09:12:00+09:00","timeZone":"Asia/Tokyo"}');
    expect(markdown.toMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      name: '式典案内.docx',
      blob: expect.any(Blob),
    }), { conversionOptions: { pdf: { metadata: false } } });
    expect(aiRequest.messages?.[1]?.content).not.toContain(gmailDocx);
    expect(calendarUrl).toContain('supportsAttachments=true');
    expect(calendarRequest.attachments).toEqual([{
      fileUrl: 'https://drive.example/docx',
      title: '式典案内.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }]);
    expect(calendarRequest.description).toBe([
      '式典の案内です。受付は開始30分前からです。',
      '<br><br>添付ファイル:',
      '<br><a href="https://drive.example/docx">式典案内.docx</a>',
      '<br><br>Mail Automation が Gmail メッセージ gmail-message-docx から作成しました。',
    ].join(''));
    const dashboard = await app.fetch(
      fixture.request('/api/organizations/organization-1/dashboard'),
      fixture.environment,
    );
    await expect(dashboard.json()).resolves.toMatchObject({
      data: { upcomingEvents: 1, exceptions: 0 },
    });
  });

  it('creates an Automation Exception when Gmail attachment retrieval fails', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      if (url.includes('/history')) {
        return new Response(JSON.stringify({
          historyId: 'history-after-connection',
          history: [{ messagesAdded: [{ message: { id: 'gmail-message-failed-attachment' } }] }],
        }), { status: 200 });
      }
      if (url.includes('/attachments/attachment-pdf')) {
        return new Response(JSON.stringify({ error: { message: 'attachment unavailable' } }), { status: 503 });
      }
      return new Response(JSON.stringify({
        id: 'gmail-message-failed-attachment',
        payload: {
          headers: [{ name: 'Subject', value: '添付をご確認ください' }],
          parts: [{
            filename: '案内.pdf',
            mimeType: 'application/pdf',
            body: { attachmentId: 'attachment-pdf', size: 9 },
          }],
        },
      }), { status: 200 });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toMatchObject({ created: 0, exceptions: 1 });
    expect(requests.some((url) => url.includes('/calendar/v3/'))).toBe(false);
  });

  it('keeps the Calendar event as a draft when Drive publication fails', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedMember(fixture.organization, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    const markdown = { toMarkdown: vi.fn().mockResolvedValue({
      format: 'markdown', name: '式次第.pdf', mimetype: 'application/pdf', tokens: 4, data: '例会の式次第',
    }) };
    (fixture.environment as unknown as { AI: typeof markdown }).AI = markdown;
    let calendarUrl = '';
    let calendarRequest: { attachments?: unknown[]; attendees?: unknown[] } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/history')) {
        return new Response(JSON.stringify({
          historyId: 'history-after-connection',
          history: [{ messagesAdded: [{ message: { id: 'gmail-message-drive-failure' } }] }],
        }), { status: 200 });
      }
      if (url.includes('/attachments/attachment-pdf')) {
        return new Response(JSON.stringify({ data: 'cGRmLWJ5dGVz' }), { status: 200 });
      }
      if (url.includes('/messages/gmail-message-drive-failure')) {
        return new Response(JSON.stringify({
          id: 'gmail-message-drive-failure',
          payload: {
            headers: [{ name: 'Subject', value: '例会のお知らせ' }],
            body: { data: gmailBody('日時: 2026年8月3日 19:00〜21:30') },
            parts: [{
              filename: '式次第.pdf',
              mimeType: 'application/pdf',
              body: { attachmentId: 'attachment-pdf', size: 9 },
            }],
          },
        }), { status: 200 });
      }
      if (url.includes('upload/drive')) {
        return new Response(JSON.stringify({ error: { message: 'Drive upload failed' } }), { status: 503 });
      }
      if (url.includes('ai.example.com')) return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '例会のお知らせです。',
        events: [{
          title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00',
          timeZone: 'Asia/Tokyo', location: '', description: '例会です。',
        }],
        tasks: [],
      }) } }] });
      if (url.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
        calendarUrl = url;
        calendarRequest = JSON.parse(init.body as string) as typeof calendarRequest;
        return new Response(JSON.stringify({ id: 'calendar-event-draft' }), { status: 200 });
      }
      // The correlation search that precedes every insertion; no event exists yet.
      if (url.includes('timeMin=')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toMatchObject({ created: 0, exceptions: 1 });
    expect(calendarRequest.attachments).toEqual([]);
    expect(calendarRequest.attendees).toEqual([]);
    expect(calendarUrl).not.toContain('sendUpdates');
    expect(fixture.organization.rows(
      "SELECT destination, outcome, external_id FROM deliveries WHERE channel = 'calendar'",
    )).toEqual([{ destination: 'first@example.com', outcome: 'pending', external_id: null }]);
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
            headers: [
              { name: 'Subject', value: '常設メールテスト' },
              { name: 'From', value: 'member@example.com' },
            ],
            body: { data: gmailBody('2026年8月18日 14:30から16:00まで例会を開催します。') },
          },
        });
      }
      if (url.includes('ai.example.com')) {
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: '例会の予定です。',
                events: [{
                  title: '例会',
                  startsAt: '2026-08-18T14:30:00+09:00',
                  endsAt: '2026-08-18T16:00:00+09:00',
                  timeZone: 'Asia/Tokyo',
                  location: '',
                  description: '常設メールテスト',
                  summary: '例会の予定です。',
                }],
                tasks: [],
              }),
            },
          }],
        });
      }
      if (url.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
        calendarRequest = JSON.parse(init.body as string) as typeof calendarRequest;
        return Response.json({ id: 'mailbox-test-event' });
      }
      if (url.includes('/calendar/v3/calendars/primary/events')) {
        return Response.json({ items: [] });
      }
      return Response.json({ error: { message: `unexpected request: ${url}` } }, { status: 500 });
    }));

    const response = await app.fetch(fixture.request(
      '/api/organizations/organization-1/mail-tests/mailbox-active-preview/preview',
      { method: 'POST' },
    ), fixture.environment);

    expect(response.status).toBe(200);
    const preview = await response.json() as { data: { confirmationToken: string } };
    expect(preview).toMatchObject({
      data: {
        id: 'mailbox-active-preview',
        selectedRule: { id: 'rule-1', revision: 1 },
        events: [{ title: '例会' }],
      },
    });
    const calendarResponse = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mail-tests/calendar',
      { confirmationToken: preview.data.confirmationToken },
    ), fixture.environment);

    expect(calendarResponse.status).toBe(201);
    await expect(calendarResponse.json()).resolves.toMatchObject({ data: { eventIds: ['mailbox-test-event'] } });
    expect(calendarRequest).toMatchObject({ summary: '例会' });
    expect(calendarRequest.description).toContain('mailbox-active-preview');
    expect(fixture.organization.rows('SELECT * FROM source_messages')).toEqual([]);
  });

  it('searches Gmail and prepares an OpenAI-compatible request without an AI credential', async () => {
    fixture = await createAutomationTestApp();
    const upstreamUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      upstreamUrls.push(url);
      if (url.includes('/messages?')) {
        return new Response(JSON.stringify({ messages: [{ id: 'message-without-ai' }] }), { status: 200 });
      }
      if (url.includes('/messages/message-without-ai')) {
        return new Response(JSON.stringify({
          id: 'message-without-ai',
          payload: {
            headers: [
              { name: 'Subject', value: '手動テスト' },
              { name: 'From', value: 'member@example.com' },
            ],
            body: { data: gmailBody('日時: 2026年8月3日 19:00〜21:30') },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    const searchResponse = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mail-tests/search',
      { subject: '手動テスト' },
    ), fixture.environment);
    const preparedResponse = await app.fetch(fixture.request(
      '/api/organizations/organization-1/mail-tests/message-without-ai/ai-request',
      { method: 'POST' },
    ), fixture.environment);
    const prepared = await preparedResponse.json() as {
      data: { request: { messages?: Array<{ role?: string; content?: string }> } };
    };

    expect(searchResponse.status).toBe(200);
    expect(preparedResponse.status).toBe(200);
    expect(prepared.data.request.messages?.[1]?.content).toContain('2026年8月3日 19:00〜21:30');
    expect(upstreamUrls.some((url) => url.includes('ai.example.com'))).toBe(false);
  });

  it('returns exact-subject matches through the injected Google adapter', async () => {
    fixture = await createAutomationTestApp();
    const automation = createAutomation(fixture.environment, {
      google: {
        request: async <T>(_accessToken: string, url: string): Promise<T> => {
          if (url.includes('/messages?')) return { messages: [{ id: 'mailbox-port-message' }] } as T;
          return {
            id: 'mailbox-port-message',
            payload: {
              headers: [
                { name: 'Subject', value: '手動テスト' },
                { name: 'From', value: 'member@example.com' },
              ],
            },
          } as T;
        },
      },
    });

    await expect(automation.mailboxTest.search({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
      subject: '手動テスト',
    })).resolves.toEqual([{ id: 'mailbox-port-message', subject: '手動テスト', sender: 'member@example.com' }]);
  });

  it('matches a subject despite full-width digits and doubled whitespace Gmail treats as the same subject', async () => {
    fixture = await createAutomationTestApp();
    const automation = createAutomation(fixture.environment, {
      google: {
        request: async <T>(_accessToken: string, url: string): Promise<T> => {
          if (url.includes('/messages?')) return { messages: [{ id: 'mailbox-port-message' }] } as T;
          return {
            id: 'mailbox-port-message',
            payload: {
              headers: [
                { name: 'Subject', value: '３０周年記念式典　のご案内' },
                { name: 'From', value: 'member@example.com' },
              ],
            },
          } as T;
        },
      },
    });

    await expect(automation.mailboxTest.search({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
      subject: '30周年記念式典  のご案内',
    })).resolves.toEqual([{ id: 'mailbox-port-message', subject: '３０周年記念式典　のご案内', sender: 'member@example.com' }]);
  });

  it('rejects a subject that only shares words with the searched-for subject', async () => {
    fixture = await createAutomationTestApp();
    const automation = createAutomation(fixture.environment, {
      google: {
        request: async <T>(_accessToken: string, url: string): Promise<T> => {
          if (url.includes('/messages?')) return { messages: [{ id: 'mailbox-port-message' }] } as T;
          return {
            id: 'mailbox-port-message',
            payload: {
              headers: [
                { name: 'Subject', value: '30周年記念式典のご案内（再送）' },
                { name: 'From', value: 'member@example.com' },
              ],
            },
          } as T;
        },
      },
    });

    await expect(automation.mailboxTest.search({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
      subject: '30周年記念式典のご案内',
    })).resolves.toEqual([]);
  });

  it('previews an event whose date and time exist only in an XLSX attachment', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const registrationRoleResponse = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '参加登録担当', description: '出欠と申込期限を扱う',
    }), fixture.environment);
    const paymentRoleResponse = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/task-roles', {
      displayName: '支払担当', description: '支払期限を扱う',
    }), fixture.environment);
    const registrationRoleId = (await registrationRoleResponse.json() as { data: { id: string } }).data.id;
    const paymentRoleId = (await paymentRoleResponse.json() as { data: { id: string } }).data.id;
    fixture.organization.execute(
      "UPDATE rules SET task_role_ids = ?, status = 'draft' WHERE id = 'rule-1'",
      JSON.stringify([registrationRoleId, paymentRoleId]),
    );
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
    const gmailXlsx = xlsx.toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    let aiRequest: { messages?: Array<{ role?: string; content?: string }> } = {};
    let calendarUrl = '';
    const calendarRequests: Array<{ summary?: string; attachments?: Array<{ fileUrl?: string; title?: string; mimeType?: string }> }> = [];
    const driveFolders: Array<{ name?: string; parents?: string[] }> = [];
    const driveFolderQueries: string[] = [];
    let uploadMetadata: { name?: string; parents?: string[] } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/attachments/attachment-xlsx')) {
        return new Response(JSON.stringify({ data: gmailXlsx }), { status: 200 });
      }
      if (url.includes('/messages/gmail-message-attachment')) {
        return new Response(JSON.stringify({
          id: 'gmail-message-attachment',
          payload: {
            headers: [
              { name: 'Subject', value: '名古屋名城RAC30周年記念式典のご案内' },
              { name: 'From', value: 'member@example.com' },
            ],
            body: { data: gmailBody('詳しくは添付をご確認ください。') },
            parts: [{
              filename: '式典案内.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              body: { attachmentId: 'attachment-xlsx', size: xlsx.byteLength },
            }],
          },
        }), { status: 200 });
      }
      if (url.includes('/calendar/v3/calendars/primary/events') && !init?.method) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('ai.example.com')) {
        aiRequest = JSON.parse(init?.body as string) as typeof aiRequest;
        const normalizedText = aiRequest.messages?.[1]?.content ?? '';
        if (!normalizedText.includes('FILE-PROBE-001')
          || !normalizedText.includes('2026-08-18')
          || !normalizedText.includes('14:30')
          || !normalizedText.includes('16:00')) {
          return new Response(JSON.stringify({
            error: { message: 'Normalized XLSX content was not provided.' },
          }), { status: 400 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            summary: '8月18日に会議と懇親会を開催します。8月10日までの出席登録と8月12日までの参加費振込が必要です。',
            events: [
              { title: 'AI ファイル解析テスト会議', startsAt: '2026-08-18T14:30:00+09:00', endsAt: '2026-08-18T16:00:00+09:00', timeZone: 'Asia/Tokyo', location: '名古屋イノベーションセンター 3階 会議室A', description: '添付XLSXから抽出' },
              { title: 'テスト懇親会', startsAt: '2026-08-18T17:00:00+09:00', endsAt: '2026-08-18T19:00:00+09:00', timeZone: 'Asia/Tokyo', location: '名古屋イノベーションセンター 1階', description: '式典後の懇親会' },
            ],
            tasks: [
              { title: '出席登録を完了する', deadline: '2026-08-10', assigneeRoleId: registrationRoleId, description: '登録フォームを送信する' },
              { title: '参加費を振り込む', deadline: '2026-08-12', assigneeRoleId: paymentRoleId, description: '指定口座へ振込する' },
            ],
          }) } }],
        }), { status: 200 });
      }
      if (url.includes('drive/v3/files?q=')) {
        driveFolderQueries.push(decodeURIComponent(new URL(url).searchParams.get('q') ?? ''));
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (url.includes('drive/v3/files?fields=id') && init?.method === 'POST') {
        driveFolders.push(JSON.parse(init.body as string) as typeof driveFolders[number]);
        return new Response(JSON.stringify({ id: `drive-folder-${driveFolders.length}` }), { status: 200 });
      }
      if (url.includes('upload/drive')) {
        uploadMetadata = JSON.parse(
          /\r\n\r\n(\{.*?\})\r\n/su.exec(init?.body as string)?.[1] ?? '{}',
        ) as typeof uploadMetadata;
        return new Response(JSON.stringify({ id: 'drive-file-xlsx', webViewLink: 'https://drive.example/xlsx' }), { status: 200 });
      }
      if (url.includes('/permissions')) return new Response('', { status: 200 });
      if (url.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
        calendarUrl = url;
        calendarRequests.push(JSON.parse(init.body as string) as typeof calendarRequests[number]);
        return new Response(JSON.stringify({ id: 'calendar-event-xlsx' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    const requestResponse = await app.fetch(fixture.request(
      '/api/organizations/organization-1/mail-tests/gmail-message-attachment/ai-request',
      { method: 'POST' },
    ), fixture.environment);
    const aiRequestPreview = await requestResponse.json() as {
      data: { request: { messages?: Array<{ role?: string; content?: string }> } };
    };

    expect(requestResponse.status).toBe(200);
    expect(aiRequestPreview.data.request.messages?.[1]?.content).toContain('FILE-PROBE-001');
    expect(aiRequestPreview.data.request.messages?.[1]?.content).toContain('日時\t時間\t会場');
    expect(aiRequestPreview.data.request.messages?.[1]?.content).not.toContain('__EMPTY_1');
    expect(aiRequestPreview.data.request.messages?.[1]?.content).not.toContain('| ----------- |');
    expect(aiRequest.messages).toBeUndefined();

    fixture.organization.execute("UPDATE rules SET selection_policy = ? WHERE id = 'rule-1'", JSON.stringify({ sender: 'other@example.com' }));
    const rejectedBySelection = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mail-tests/gmail-message-attachment/draft-preview',
      { ruleId: 'rule-1' },
    ), fixture.environment);
    expect(rejectedBySelection.status).toBe(409);
    expect(aiRequest.messages).toBeUndefined();
    fixture.organization.execute("UPDATE rules SET selection_policy = '{}' WHERE id = 'rule-1'");

    const previewResponse = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mail-tests/gmail-message-attachment/draft-preview',
      { ruleId: 'rule-1' },
    ), fixture.environment);
    const preview = await previewResponse.json() as {
      data: { summary: string; events: EventDetails[]; tasks: Array<{ assigneeRoleId: string }>; confirmationToken: string };
    };
    const rejectedCalendarResponse = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mail-tests/calendar',
      { confirmationToken: preview.data.confirmationToken },
    ), fixture.environment);
    const runResponse = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mail-tests/rule-run',
      { confirmationToken: preview.data.confirmationToken, ruleId: 'rule-1' },
    ), fixture.environment);

    expect(previewResponse.status).toBe(200);
    expect(rejectedCalendarResponse.status).toBe(409);
    expect(preview).toMatchObject({
      data: {
        summary: '8月18日に会議と懇親会を開催します。8月10日までの出席登録と8月12日までの参加費振込が必要です。',
        events: [{ title: 'AI ファイル解析テスト会議', startsAt: '2026-08-18T14:30:00+09:00' }, { title: 'テスト懇親会' }],
        tasks: [{ assigneeRoleId: registrationRoleId }, { assigneeRoleId: paymentRoleId }],
      },
    });
    expect(aiRequest.messages?.[1]?.content).toContain('FILE-PROBE-001');
    expect(aiRequest.messages?.[1]?.content).not.toContain(gmailXlsx);
    expect(markdown.toMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      name: '式典案内.xlsx',
      blob: expect.any(Blob),
    }), { conversionOptions: { pdf: { metadata: false } } });
    expect(runResponse.status).toBe(201);
    const runBody = await runResponse.json() as { data: { effects: Array<{ arguments: unknown }> } };
    expect(runBody).toMatchObject({ data: {
      rule: { type: 'schema', id: 'rule-1', revision: 1 },
      intent: 'draft_preview',
      executionMode: 'read_only',
      status: 'read_only',
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'schema.apply_events', status: 'planned', arguments: expect.objectContaining({ extraction: expect.objectContaining({ events: [expect.objectContaining({ title: 'AI ファイル解析テスト会議' }), expect.objectContaining({ title: 'テスト懇親会' })] }) }) }),
      ]),
    } });
    expect(JSON.stringify(runBody.data.effects)).not.toContain(gmailXlsx);
    expect(calendarRequests).toHaveLength(0);
    expect(driveFolderQueries).toHaveLength(0);
    expect(driveFolders).toHaveLength(0);
    expect(uploadMetadata.parents).toBeUndefined();
    expect(fixture.organization.rows(
      "SELECT id FROM source_messages WHERE gmail_message_id = 'gmail-message-attachment'",
    )).toEqual([]);
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

  const gmailMessage = {
    id: 'gmail-refresh-1',
    payload: {
      headers: [
        { name: 'Subject', value: '30周年記念式典のご案内' },
        { name: 'From', value: 'member@example.com' },
      ],
      body: { data: gmailBody('式典のご案内です。') },
    },
    internalDate: '1786000000000',
  };

  const attachmentPort = {
    read: async () => [],
    publish: async () => ({ outcome: 'succeeded' as const, driveFileId: 'drive-1', publicUrl: 'https://drive.example/a' }),
    ensurePath: async () => 'attachment-folder-path',
    createMessageFolder: async () => 'source-message-folder',
    find: async () => null,
  };

  it('plans an update for the Scheduled Event this message already produced', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    let correspondenceInput: { existing: Array<{ id: string }> } | undefined;
    const automation = createAutomation(fixture.environment, {
      attachments: attachmentPort,
      google: {
        request: async <T>(_accessToken: string, url: string): Promise<T> => {
          if (url.includes('/calendar/v3/calendars/primary/events?')) {
            return { items: [
              staleEvent('Mail Automation が Gmail メッセージ gmail-refresh-1 から作成しました。'),
              {
                ...staleEvent('Mail Automation が Gmail メッセージ gmail-refresh-1 から作成しました。'),
                id: 'calendar-event-far',
                start: { dateTime: '2026-11-18T14:30:00+09:00', timeZone: 'Asia/Tokyo' },
                end: { dateTime: '2026-11-18T16:00:00+09:00', timeZone: 'Asia/Tokyo' },
              },
              { ...staleEvent('手で作った予定です。'), id: 'calendar-event-manual' },
            ] } as T;
          }
          if (url.includes('/messages/gmail-refresh-1')) return gmailMessage as T;
          throw new Error(`Unexpected Google request: ${url}`);
        },
      },
      ai: {
        extract: async () => null,
        correspond: async (input) => {
          correspondenceInput = input;
          return [{ candidateIndex: 0, eventId: 'calendar-event-1' }];
        },
      },
    });

    const plan = await automation.mailboxTest.planRefresh({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
      messageId: 'gmail-refresh-1',
      events: [CANDIDATE],
    });

    expect(correspondenceInput?.existing.map((event) => event.id)).toEqual(['calendar-event-1']);
    expect(plan.entries[0]?.target?.id).toBe('calendar-event-1');
    expect(plan.entries[0]?.changedFields).toEqual(['title', 'description', 'location']);
    expect(plan.outOfWindow.map((event) => event.id)).toEqual(['calendar-event-far']);
    expect(plan.desired[0]?.description).toContain('Mail Automation が Gmail メッセージ gmail-refresh-1 から作成しました。');
  });

  it('rewrites every field, adds the active roster as attendees, and preserves an existing attendee\'s response status', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedMember(fixture.organization, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    fixture.organization.execute(
      `INSERT INTO events
        (id, organization_id, rule_id, google_event_id, title, starts_at, ends_at, location, description, status, created_at, updated_at)
       VALUES (?, 'organization-1', 'rule-1', 'calendar-event-1', ?, ?, ?, '', '', 'scheduled', ?, ?)`,
      'event-1',
      '記念式典',
      '2026-08-18T14:30:00+09:00',
      '2026-08-18T16:00:00+09:00',
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z',
    );
    let patched: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | undefined;
    const automation = createAutomation(fixture.environment, {
      attachments: attachmentPort,
      google: {
        request: async <T>(_accessToken: string, url: string, init?: RequestInit): Promise<T> => {
          if (url.includes('/messages/gmail-refresh-1')) return gmailMessage as T;
          if (init?.method === 'PATCH') {
            patched = {
              url,
              body: JSON.parse(String(init.body)) as Record<string, unknown>,
              headers: init.headers as Record<string, string>,
            };
            return { id: 'calendar-event-1', etag: '"etag-2"' } as T;
          }
          if (!init?.method && url.endsWith('/calendar-event-1')) {
            return { id: 'calendar-event-1', attendees: [{ email: 'guest@example.com', responseStatus: 'accepted' }] } as T;
          }
          throw new Error(`Unexpected Google request: ${url}`);
        },
      },
    });

    const outcome = await automation.mailboxTest.applyRefresh({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
      messageId: 'gmail-refresh-1',
      entries: [{ googleEventId: 'calendar-event-1', etag: '"etag-1"', candidate: CANDIDATE }],
    });

    expect(outcome.updated).toEqual(['calendar-event-1']);
    expect(patched?.headers['If-Match']).toBe('"etag-1"');
    expect(patched?.url).toContain('sendUpdates=all');
    expect(patched?.body).toMatchObject({
      summary: '30周年記念式典',
      location: '市民ホール',
      start: { dateTime: '2026-08-18T14:30:00+09:00', timeZone: 'Asia/Tokyo' },
    });
    expect(patched?.body.attendees).toEqual([
      { email: 'guest@example.com', responseStatus: 'accepted' },
      { email: 'first@example.com' },
    ]);
    expect(String(patched?.body.description)).toContain('Mail Automation が Gmail メッセージ gmail-refresh-1 から作成しました。');
    expect(fixture.organization.row<{ title: string; location: string }>(
      'SELECT title, location FROM events WHERE google_event_id = ?', 'calendar-event-1',
    )).toMatchObject({ title: '30周年記念式典', location: '市民ホール' });
    expect(fixture.organization.rows<{ channel: string; external_id: string }>(
      "SELECT channel, external_id FROM deliveries WHERE channel = 'calendar'",
    )).toEqual([{ channel: 'calendar', external_id: 'calendar-event-1' }]);
  });

  it('sends no notification when every active Member is already an attendee', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedMember(fixture.organization, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    let patched: { url: string; body: Record<string, unknown> } | undefined;
    const automation = createAutomation(fixture.environment, {
      attachments: attachmentPort,
      google: {
        request: async <T>(_accessToken: string, url: string, init?: RequestInit): Promise<T> => {
          if (url.includes('/messages/gmail-refresh-1')) return gmailMessage as T;
          if (init?.method === 'PATCH') {
            patched = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
            return { id: 'calendar-event-1', etag: '"etag-2"' } as T;
          }
          if (!init?.method && url.endsWith('/calendar-event-1')) {
            return { id: 'calendar-event-1', attendees: [{ email: 'first@example.com', responseStatus: 'declined' }] } as T;
          }
          throw new Error(`Unexpected Google request: ${url}`);
        },
      },
    });

    await automation.mailboxTest.applyRefresh({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
      messageId: 'gmail-refresh-1',
      entries: [{ googleEventId: 'calendar-event-1', etag: '"etag-1"', candidate: CANDIDATE }],
    });

    expect(patched?.url).toContain('sendUpdates=none');
    expect(patched?.body.attendees).toEqual([{ email: 'first@example.com', responseStatus: 'declined' }]);
  });

  it('invites the active roster with sendUpdates=all when it creates a Scheduled Event through the refresh exit', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    seedMember(fixture.organization, { id: 'member-1', name: '一郎', email: 'first@example.com' });
    let created: { url: string; body: Record<string, unknown> } | undefined;
    const automation = createAutomation(fixture.environment, {
      attachments: attachmentPort,
      google: {
        request: async <T>(_accessToken: string, url: string, init?: RequestInit): Promise<T> => {
          if (url.includes('/messages/gmail-refresh-1')) return gmailMessage as T;
          if (init?.method === 'POST') {
            created = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
            return { id: 'calendar-event-new', etag: '"etag-1"' } as T;
          }
          throw new Error(`Unexpected Google request: ${url}`);
        },
      },
    });

    const outcome = await automation.mailboxTest.applyRefresh({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
      messageId: 'gmail-refresh-1',
      entries: [{ googleEventId: null, etag: null, candidate: CANDIDATE }],
    });

    expect(outcome.created).toEqual(['calendar-event-new']);
    expect(created?.url).toContain('sendUpdates=all');
    expect(created?.body.attendees).toEqual([{ email: 'first@example.com' }]);
  });

  it('re-offers a Scheduled Event the Calendar changed after the plan, instead of overwriting it', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const automation = createAutomation(fixture.environment, {
      attachments: attachmentPort,
      google: {
        request: async <T>(_accessToken: string, url: string, init?: RequestInit): Promise<T> => {
          if (url.includes('/messages/gmail-refresh-1')) return gmailMessage as T;
          if (init?.method === 'PATCH') throw new GoogleApiError('Precondition Failed', 412, url);
          return {
            ...staleEvent('Mail Automation が Gmail メッセージ gmail-refresh-1 から作成しました。'),
            etag: '"etag-9"',
            location: '別会場',
          } as T;
        },
      },
    });

    const outcome = await automation.mailboxTest.applyRefresh({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
      messageId: 'gmail-refresh-1',
      entries: [{ googleEventId: 'calendar-event-1', etag: '"etag-1"', candidate: CANDIDATE }],
    });

    expect(outcome.updated).toEqual([]);
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]?.etag).toBe('"etag-9"');
    expect(outcome.conflicts[0]?.current.location).toBe('別会場');
    expect(outcome.conflicts[0]?.changedFields).toContain('location');
  });

  it('reuses a Public Attachment a previous run already placed in the folder', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute(
      `INSERT INTO source_messages
        (id, gmail_message_id, gmail_history_id, sender, subject, drive_folder_id, received_at, processed_at, state)
       VALUES (?, 'gmail-refresh-1', 'history-1', ?, ?, 'source-message-folder', ?, ?, 'processed')`,
      'source-message-1',
      'member@example.com',
      '30周年記念式典のご案内',
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z',
    );
    const publish = vi.fn();
    let patchedDescription = '';
    const automation = createAutomation(fixture.environment, {
      attachments: {
        ...attachmentPort,
        publish,
        find: async () => ({ driveFileId: 'drive-existing', publicUrl: 'https://drive.example/existing' }),
      },
      google: {
        request: async <T>(_accessToken: string, url: string, init?: RequestInit): Promise<T> => {
          if (url.includes('/messages/gmail-refresh-1')) {
            return {
              ...gmailMessage,
              payload: {
                ...gmailMessage.payload,
                parts: [{
                  filename: '案内.pdf',
                  mimeType: 'application/pdf',
                  body: { attachmentId: 'attachment-1', size: 1_024 },
                }],
              },
            } as T;
          }
          if (init?.method === 'PATCH') {
            patchedDescription = String((JSON.parse(String(init.body)) as { description?: string }).description);
            return { id: 'calendar-event-1' } as T;
          }
          if (!init?.method && url.endsWith('/calendar-event-1')) return { id: 'calendar-event-1', attendees: [] } as T;
          throw new Error(`Unexpected Google request: ${url}`);
        },
      },
    });

    await automation.mailboxTest.applyRefresh({
      organizationId: 'organization-1',
      database: fixture.organization.binding,
      messageId: 'gmail-refresh-1',
      entries: [{ googleEventId: 'calendar-event-1', etag: null, candidate: CANDIDATE }],
    });

    expect(publish).not.toHaveBeenCalled();
    expect(patchedDescription).toContain('https://drive.example/existing');
    expect(patchedDescription).toContain('案内.pdf');
  });
});

describe('unattended Automation Inbox health', () => {
  const inboxHealth = (): { status: string; last_error: string | null; failing_since: string | null; alerted_at: string | null } | null =>
    fixture?.organization.row<{ status: string; last_error: string | null; failing_since: string | null; alerted_at: string | null }>(
      "SELECT status, last_error, failing_since, alerted_at FROM google_connections WHERE kind = 'automation_inbox'",
    ) ?? null;

  const setInboxTokenExpiry = async (expiresAt: string): Promise<void> => {
    const keyRecord = fixture?.control.row<{ master_key_version: string; wrapped_key_envelope: string }>(
      "SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = 'organization-1'",
    );
    const organizationKey = await unwrapOrganizationKey({
      masterKeyVersion: keyRecord?.master_key_version ?? '',
      envelope: JSON.parse(keyRecord?.wrapped_key_envelope ?? '{}'),
    }, await masterKey(fixture?.environment.CREDENTIAL_MASTER_KEY ?? ''), 'organization-1');
    const envelope = await encrypt(JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt,
      scopes: [],
      tokenType: 'Bearer',
    }), organizationKey, 'google-connection:organization-1:automation-inbox');
    fixture?.organization.execute(
      "UPDATE google_connections SET token_envelope = ? WHERE kind = 'automation_inbox'",
      JSON.stringify(envelope),
    );
  };

  const sentNotices = (calls: Array<{ raw: string }>): string[] =>
    calls.map(({ raw }) => new TextDecoder().decode(Uint8Array.from(
      atob(raw.replaceAll('-', '+').replaceAll('_', '/')),
      (character) => character.charCodeAt(0),
    )));

  it('keeps an Automation Inbox connected through a Gmail outage so the next scheduled run retries', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/history')) return Response.json({ error: { code: 503, message: 'Backend Error' } }, { status: 503 });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await runEnabledAutomations(fixture.environment);

    expect(inboxHealth()).toMatchObject({ status: 'active', last_error: 'Backend Error', alerted_at: null });
    expect(inboxHealth()?.failing_since).toEqual(expect.any(String));
  });

  it('suspends an Automation Inbox whose grant Google rejected and mails every Administrator', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    await setInboxTokenExpiry(new Date(Date.now() + 10 * 60 * 1_000).toISOString());
    const notices: Array<{ raw: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
      }
      if (url.includes('/messages/send')) {
        notices.push(JSON.parse(String(init?.body)) as { raw: string });
        return Response.json({ id: 'administrator-notice' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await runEnabledAutomations(fixture.environment);

    expect(inboxHealth()).toMatchObject({
      status: 'reauthentication_required',
      last_error: 'Token has been expired or revoked.',
    });
    expect(inboxHealth()?.alerted_at).toEqual(expect.any(String));
    expect(sentNotices(notices)).toHaveLength(1);
    expect(sentNotices(notices)[0]).toContain('To: owner@example.com');
    expect(sentNotices(notices)[0]).toContain('Token has been expired or revoked.');
  });

  it('mails the Administrators once a day of unattended retries has failed and keeps the Inbox connected', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute(
      "UPDATE google_connections SET failing_since = ?, last_error = 'Backend Error' WHERE kind = 'automation_inbox'",
      new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString(),
    );
    const notices: Array<{ raw: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/history')) return Response.json({ error: { code: 503, message: 'Backend Error' } }, { status: 503 });
      if (url.includes('/messages/send')) {
        notices.push(JSON.parse(String(init?.body)) as { raw: string });
        return Response.json({ id: 'administrator-notice' });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await runEnabledAutomations(fixture.environment);

    expect(inboxHealth()).toMatchObject({ status: 'active', last_error: 'Backend Error' });
    expect(inboxHealth()?.alerted_at).toEqual(expect.any(String));
    expect(sentNotices(notices)[0]).toContain('To: owner@example.com');
  });

  it('keeps sweeping the fleet when one Organization database cannot be opened', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.control.execute(
      `INSERT INTO organizations (id, name, status, database_id, binding_name, created_at, updated_at)
       VALUES ('organization-unbound', 'Unbound', 'active', 'database-unbound', 'ORG_UNBOUND', ?, ?)`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/history')) return Response.json({ historyId: 'history-after-unbound-peer' });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await runEnabledAutomations(fixture.environment);

    expect(fixture.organization.row<{ gmail_history_id: string }>(
      "SELECT gmail_history_id FROM google_connections WHERE kind = 'automation_inbox'",
    )).toEqual({ gmail_history_id: 'history-after-unbound-peer' });
    expect(inboxHealth()).toMatchObject({ status: 'active', last_error: null });
  });

  it('clears a recorded failure as soon as one scheduled run succeeds again', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    fixture.organization.execute(
      "UPDATE google_connections SET failing_since = ?, alerted_at = ?, last_error = 'Backend Error' WHERE kind = 'automation_inbox'",
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
    );
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/history')) return Response.json({ historyId: 'history-after-recovery' });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await runEnabledAutomations(fixture.environment);

    expect(inboxHealth()).toEqual({
      status: 'active',
      last_error: null,
      failing_since: null,
      alerted_at: null,
    });
  });
});

import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import { extractAiEventDetails, type EventDetails } from './event-details';
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
import { createMemoryR2, seedAttendanceRegistration, seedScheduledEvent } from '../test/seed';
import { AGENT_TOKEN_CEILING, MAX_AGENT_TOOL_CALLS } from './agent-runs';

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

const sourceMessageResponse = (input: { subject?: string; body?: string } = {}): Response => new Response(JSON.stringify({
  payload: {
    headers: [
      { name: 'Subject', value: input.subject ?? '例会のお知らせ' },
      { name: 'From', value: 'member@example.com' },
    ],
    body: { data: gmailBody(input.body ?? '日時: 2026年8月3日 19:00〜21:30') },
  },
}), { status: 200 });

describe('Source Message processing primitives', () => {
  it('selects the highest-priority matching active Automation Rule', () => {
    expect(selectActiveRule([
      { id: 'rule-low', priority: 1, selectionPolicy: { domain: 'example.com' } },
      { id: 'rule-high', priority: 10, selectionPolicy: { sender: 'announcer@example.com', keyword: '例会' } },
    ], {
      sender: 'announcer@example.com',
      subject: '例会のお知らせ',
      body: '2026年8月3日 19:00〜21:00',
    })).toMatchObject({ id: 'rule-high' });
    expect(selectActiveRule([
      { id: 'rule-1', priority: 1, selectionPolicy: { domain: 'example.com' } },
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
      name: 'Writer', promptId, executionMode: 'unattended', selectionPolicy: {}, permittedLineListIds: [lineListId],
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
    expect(transcriptText).toContain('failed');
    await expect(automation.runOrganization({ organizationId: 'organization-1', database: fixture.organization.binding }))
      .resolves.toEqual({ scanned: 0, created: 0, skipped: 0, exceptions: 0 });
    expect(linePush).toHaveBeenCalledTimes(1);
  });

  it('completes an approval-mode run before executing the exact Proposed Action through the member interface', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    fixture.organization.execute("UPDATE rules SET status = 'suspended' WHERE id = 'rule-1'");
    const lineList = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', { kind: 'line', name: 'Writers' }), fixture.environment);
    const lineListId = (await lineList.json() as { data: { id: string } }).data.id;
    await app.fetch(fixture.jsonRequest(`/api/organizations/organization-1/lists/${lineListId}/items`, { value: 'line-user-1', label: 'Writer' }), fixture.environment);
    const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', { name: 'Approver', instructions: 'Propose.' }), fixture.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;
    await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: 'Approver', promptId, selectionPolicy: {}, permittedLineListIds: [lineListId],
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
    const run = fixture.organization.row<{ id: string }>('SELECT id FROM agent_runs')!;
    const proposalsResponse = await app.fetch(fixture.request(`/api/organizations/organization-1/agent-runs/${run.id}/proposed-actions`), fixture.environment);
    const proposals = await proposalsResponse.json() as { data: Array<{ id: string; arguments: { destination: string; message: string }; status: string }> };
    expect(proposals.data).toMatchObject([{ arguments: { destination: 'line-user-1', message: 'Exact approved text' }, status: 'pending' }]);

    const approved = await app.fetch(fixture.jsonRequest(`/api/organizations/organization-1/proposed-actions/${proposals.data[0]!.id}/approve`, {}), fixture.environment);

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
      name: 'Scheduler', promptId, executionMode: 'unattended', selectionPolicy: {}, permittedRecipientListIds: [recipientListId],
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
      eventId: 'event-existing', recipientId: 'recipient-existing', destination: 'reader@example.com', status: 'attending',
    });
    fixture.organization.execute(
      "INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_role_id, assignee_role_name, description, created_at, updated_at) VALUES ('task-existing', 'organization-1', 'source-existing', '既存行事', '資料確認', '2026-08-10', 'unassigned', '未割り当て', '資料を確認する', '2026-08-01', '2026-08-01')",
    );
    const prompt = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/prompts', {
      name: 'Read-only analyst', instructions: 'Inspect the Source Message and Organization records.',
    }), fixture.environment);
    const promptId = (await prompt.json() as { data: { id: string } }).data.id;
    const agentRule = await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/agent-rules', {
      name: 'Example.com analyst', promptId, state: 'active', selectionPolicy: { domain: 'example.com' },
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
        extract: async () => ({ summary: '例会のお知らせです。', events: [], tasks: [], warnings: [] }),
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
      },
      ai: { extract },
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
        extract: async () => ({
          summary: '例会のお知らせです。',
          events: [{
            title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:30:00+09:00',
            timeZone: 'Asia/Tokyo', location: '', description: '例会です。', summary: '毎月の例会です。',
          }],
          tasks: [],
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
    const markdown = { toMarkdown: vi.fn().mockResolvedValue({
      format: 'markdown', name: '式次第.pdf', mimetype: 'application/pdf', tokens: 4, data: '例会の式次第',
    }) };
    (fixture.environment as unknown as { AI: typeof markdown }).AI = markdown;
    let calendarRequest: { attachments?: unknown[] } = {};
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
        calendarRequest = JSON.parse(init.body as string) as typeof calendarRequest;
        return new Response(JSON.stringify({ id: 'calendar-event-draft' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    await expect(runOrganizationAutomation(
      fixture.environment,
      'organization-1',
      fixture.organization.binding,
    )).resolves.toMatchObject({ created: 0, exceptions: 1 });
    expect(calendarRequest.attachments).toEqual([]);
  });
});

describe('Manual mailbox test', () => {
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

    const previewResponse = await app.fetch(fixture.request(
      '/api/organizations/organization-1/mail-tests/gmail-message-attachment/preview',
      { method: 'POST' },
    ), fixture.environment);
    const preview = await previewResponse.json() as {
      data: { summary: string; events: EventDetails[]; tasks: Array<{ assigneeRoleId: string }>; confirmationToken: string };
    };
    const calendarResponse = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mail-tests/calendar',
      { confirmationToken: preview.data.confirmationToken },
    ), fixture.environment);

    expect(previewResponse.status).toBe(200);
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
    expect(calendarResponse.status).toBe(201);
    expect(calendarUrl).toContain('supportsAttachments=true');
    expect(calendarRequests).toHaveLength(2);
    expect(calendarRequests.map((request) => request.summary)).toEqual(['AI ファイル解析テスト会議', 'テスト懇親会']);
    expect(calendarRequests[0]?.attachments).toEqual([{
      fileUrl: 'https://drive.example/xlsx',
      title: '式典案内.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }]);
    expect(driveFolderQueries).toEqual([expect.stringContaining("name = 'Mail Automation'")]);
    expect(driveFolders).toEqual([
      expect.objectContaining({ name: 'Mail Automation', parents: ['root'] }),
      expect.objectContaining({ name: expect.stringContaining('名古屋名城RAC30周年記念式典のご案内'), parents: ['drive-folder-1'] }),
    ]);
    expect(uploadMetadata.parents).toEqual(['drive-folder-2']);
  });
});

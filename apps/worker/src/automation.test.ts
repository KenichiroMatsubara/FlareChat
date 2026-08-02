import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import type { EventDetails } from './event-details';
import {
  createAutomation,
  extractEventCandidate,
  runEnabledAutomations,
  runOrganizationAutomation,
  selectActiveRule,
  sourceAttachments,
  sourceAttachmentSizes,
} from './automation';
import { createAutomationTestApp, type AutomationTestApp } from '../test/automation';

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

const sourceMessageResponse = (): Response => new Response(JSON.stringify({
  payload: {
    headers: [
      { name: 'Subject', value: '例会のお知らせ' },
      { name: 'From', value: 'member@example.com' },
    ],
    body: { data: gmailBody('日時: 2026年8月3日 19:00〜21:30') },
  },
}), { status: 200 });

describe('Source Message event extraction', () => {
  it('extracts an explicitly dated Japanese time range', () => {
    expect(extractEventCandidate('例会のお知らせ', '日時: 2026年8月3日 19:00〜21:30')).toEqual({
      title: '例会のお知らせ',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:30:00+09:00',
    });
  });

  it('withholds a Source Message that omits a date or an end time', () => {
    expect(extractEventCandidate('お知らせ', '来週の19時から集まりましょう')).toBeNull();
    expect(extractEventCandidate('お知らせ', '2026/08/03 に集まりましょう')).toBeNull();
  });

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
    const assignment = await app.fetch(fixture.jsonRequest(
      `/api/organizations/organization-1/task-roles/${roleId}/assignment`,
      { identityId: 'identity-1' },
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
        assigneeName: 'Owner',
        completed: false,
        sourceMessageSubject: '例会のお知らせ',
      }],
    });
  });

  it('creates a Scheduled Event through the Automation interface with an injected Google adapter', async () => {
    fixture = await createAutomationTestApp();
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
    fixture = await createAutomationTestApp({ enabled: false });
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
    fixture = await createAutomationTestApp();
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
    fixture = await createAutomationTestApp();
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
    fixture.organization.execute("UPDATE rules SET recipient_list_id = 'recipients-1' WHERE id = 'rule-1'");
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
    )).resolves.toEqual({ scanned: 1, created: 0, skipped: 1, exceptions: 0 });

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

  it('delivers exactly one Message Summary when one Source Message produces multiple Scheduled Events', async () => {
    fixture = await createAutomationTestApp({ ai: true, lineSecret: 'line-secret' });
    fixture.organization.execute(
      "INSERT INTO lists (id, organization_id, kind, name, created_at, updated_at) VALUES ('line-readers-1', 'organization-1', 'line', 'LINE Readers', '2026-08-01', '2026-08-01')",
    );
    fixture.organization.execute(
      "INSERT INTO list_items (id, list_id, value, label, enabled) VALUES ('line-reader-1', 'line-readers-1', 'Usummary-reader-1', 'LINE Reader', 1)",
    );
    fixture.organization.execute("UPDATE rules SET line_list_id = 'line-readers-1' WHERE id = 'rule-1'");
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
    fixture.organization.execute("UPDATE rules SET recipient_list_id = 'intake-readers-1' WHERE id = 'rule-1'");
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
    let calendarRequest: { attachments?: Array<{ fileUrl?: string; title?: string; mimeType?: string }> } = {};
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
    expect(markdown.toMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      name: '式典案内.docx',
      blob: expect.any(Blob),
    }));
    expect(aiRequest.messages?.[1]?.content).not.toContain(gmailDocx);
    expect(calendarUrl).toContain('supportsAttachments=true');
    expect(calendarRequest.attachments).toEqual([{
      fileUrl: 'https://drive.example/docx',
      title: '式典案内.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }]);
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
    fixture = await createAutomationTestApp();
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
      if (url.includes('upload/drive')) {
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
    }));
    expect(calendarResponse.status).toBe(201);
    expect(calendarUrl).toContain('supportsAttachments=true');
    expect(calendarRequests).toHaveLength(2);
    expect(calendarRequests.map((request) => request.summary)).toEqual(['AI ファイル解析テスト会議', 'テスト懇親会']);
    expect(calendarRequests[0]?.attachments).toEqual([{
      fileUrl: 'https://drive.example/xlsx',
      title: '式典案内.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }]);
  });
});

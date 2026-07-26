import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import {
  extractEventCandidate,
  runEnabledAutomations,
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
        candidates: [{ content: { parts: [{ text: '{"title":"日時未定"}' }] } }],
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
});

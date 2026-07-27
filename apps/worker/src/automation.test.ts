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

  it('extracts a Scheduled Event from a DOCX attachment in normal Automation Inbox processing', async () => {
    fixture = await createAutomationTestApp({ ai: true });
    const markdown = { toMarkdown: vi.fn().mockResolvedValue({
      format: 'markdown',
      name: '式典案内.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      tokens: 30,
      data: '# GEMINI-FILE-PROBE-001\n日時: 2026-08-18 14:30-16:00\n会場: 名古屋',
    }) };
    (fixture.environment as unknown as { AI: typeof markdown }).AI = markdown;
    const docx = await readFile(new URL('../../../fixtures/gemini-file-probe/event-invitation.docx', import.meta.url));
    const gmailDocx = docx.toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    let geminiRequest: { contents?: Array<{ parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> }> } = {};
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
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiRequest = JSON.parse(init?.body as string) as typeof geminiRequest;
        const normalizedText = geminiRequest.contents?.[0]?.parts
          ?.map((part) => part.text ?? '')
          .join('\n') ?? '';
        if (!normalizedText.includes('GEMINI-FILE-PROBE-001')
          || !normalizedText.includes('2026-08-18')
          || !normalizedText.includes('14:30')
          || !normalizedText.includes('16:00')) {
          return new Response(JSON.stringify({
            error: { message: 'Normalized DOCX content was not provided.' },
          }), { status: 400 });
        }
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            title: '式典',
            startsAt: '2026-09-12T14:00:00+09:00',
            endsAt: '2026-09-12T16:00:00+09:00',
            timeZone: 'Asia/Tokyo',
            location: '名古屋',
            description: '添付DOCXから抽出',
          }) }] } }],
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

    expect(geminiRequest.contents?.[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringContaining('GEMINI-FILE-PROBE-001'),
      }),
    ]));
    expect(markdown.toMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      name: '式典案内.docx',
      blob: expect.any(Blob),
    }));
    expect(geminiRequest.contents?.[0]?.parts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        inlineData: expect.objectContaining({
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      }),
    ]));
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
    const markdown = { toMarkdown: vi.fn().mockResolvedValue({
      format: 'markdown',
      name: '式典案内.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      tokens: 32,
      data: '# GEMINI-FILE-PROBE-001\n日時: 2026-08-18 14:30-16:00\n会場: 名古屋イノベーションセンター 3階 会議室A',
    }) };
    (fixture.environment as unknown as { AI: typeof markdown }).AI = markdown;
    const xlsx = await readFile(new URL('../../../fixtures/gemini-file-probe/event-invitation.xlsx', import.meta.url));
    const gmailXlsx = xlsx.toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    let geminiRequest: { contents?: Array<{ parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> }> } = {};
    let calendarUrl = '';
    let calendarRequest: { attachments?: Array<{ fileUrl?: string; title?: string; mimeType?: string }> } = {};
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
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiRequest = JSON.parse(init?.body as string) as typeof geminiRequest;
        const normalizedText = geminiRequest.contents?.[0]?.parts
          ?.map((part) => part.text ?? '')
          .join('\n') ?? '';
        if (!normalizedText.includes('GEMINI-FILE-PROBE-001')
          || !normalizedText.includes('2026-08-18')
          || !normalizedText.includes('14:30')
          || !normalizedText.includes('16:00')) {
          return new Response(JSON.stringify({
            error: { message: 'Normalized XLSX content was not provided.' },
          }), { status: 400 });
        }
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            title: 'Gemini ファイル解析テスト会議',
            startsAt: '2026-08-18T14:30:00+09:00',
            endsAt: '2026-08-18T16:00:00+09:00',
            timeZone: 'Asia/Tokyo',
            location: '名古屋イノベーションセンター 3階 会議室A',
            description: '添付XLSXから抽出',
          }) }] } }],
        }), { status: 200 });
      }
      if (url.includes('upload/drive')) {
        return new Response(JSON.stringify({ id: 'drive-file-xlsx', webViewLink: 'https://drive.example/xlsx' }), { status: 200 });
      }
      if (url.includes('/permissions')) return new Response('', { status: 200 });
      if (url.includes('/calendar/v3/calendars/primary/events') && init?.method === 'POST') {
        calendarUrl = url;
        calendarRequest = JSON.parse(init.body as string) as typeof calendarRequest;
        return new Response(JSON.stringify({ id: 'calendar-event-xlsx' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: `unexpected request: ${url}` } }), { status: 500 });
    }));

    const requestResponse = await app.fetch(fixture.request(
      '/api/organizations/organization-1/mail-tests/gmail-message-attachment/gemini-request',
      { method: 'POST' },
    ), fixture.environment);
    const geminiRequestPreview = await requestResponse.json() as {
      data: { request: { contents?: Array<{ parts?: Array<{ text?: string; inlineData?: unknown }> }> } };
    };

    expect(requestResponse.status).toBe(200);
    expect(geminiRequestPreview.data.request.contents?.[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('GEMINI-FILE-PROBE-001') }),
    ]));
    expect(geminiRequestPreview.data.request.contents?.[0]?.parts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ inlineData: expect.anything() }),
    ]));
    expect(geminiRequest.contents).toBeUndefined();

    const previewResponse = await app.fetch(fixture.request(
      '/api/organizations/organization-1/mail-tests/gmail-message-attachment/preview',
      { method: 'POST' },
    ), fixture.environment);
    const preview = await previewResponse.json() as {
      data: { event: EventDetails; confirmationToken: string };
    };
    const calendarResponse = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/mail-tests/calendar',
      { confirmationToken: preview.data.confirmationToken },
    ), fixture.environment);

    expect(previewResponse.status).toBe(200);
    expect(preview).toMatchObject({
      data: { event: { title: 'Gemini ファイル解析テスト会議', startsAt: '2026-08-18T14:30:00+09:00' } },
    });
    expect(geminiRequest.contents?.[0]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('GEMINI-FILE-PROBE-001') }),
    ]));
    expect(geminiRequest.contents?.[0]?.parts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        inlineData: expect.objectContaining({
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      }),
    ]));
    expect(markdown.toMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      name: '式典案内.xlsx',
      blob: expect.any(Blob),
    }));
    expect(calendarResponse.status).toBe(201);
    expect(calendarUrl).toContain('supportsAttachments=true');
    expect(calendarRequest.attachments).toEqual([{
      fileUrl: 'https://drive.example/xlsx',
      title: '式典案内.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }]);
  });
});

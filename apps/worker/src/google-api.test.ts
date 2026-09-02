import { afterEach, describe, expect, it, vi } from 'vitest';

import { googleApi } from './google-api';
import { GoogleApiError } from './providers';

const google = googleApi();

const attachment = { attachmentId: 'attachment-1', filename: 'agenda.pdf', mimeType: 'application/pdf', size: 9, data: 'cGRmLWJ5dGVz' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the production Google adapter', () => {
  it('returns a public link only after the Drive anyone-reader permission succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive.example/file-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.drive.publishAttachment('token', { attachment, parentFolderId: 'source-message-folder' }))
      .resolves.toEqual({ outcome: 'succeeded', driveFileId: 'drive-file-1', publicUrl: 'https://drive.example/file-1' });

    expect(fetchMock.mock.calls[0]?.[0]).toContain('upload/drive/v3/files?uploadType=multipart&fields=id%2CwebViewLink');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.googleapis.com/drive/v3/files/drive-file-1/permissions');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body as string)).toEqual({ type: 'anyone', role: 'reader' });
    const body = fetchMock.mock.calls[0]?.[1].body as string;
    expect(JSON.parse(/\r\n\r\n(\{.*?\})\r\n/su.exec(body)?.[1] ?? '{}')).toMatchObject({ name: 'agenda.pdf', parents: ['source-message-folder'] });
  });

  it('does not expose a link when public permission creation fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive.example/file-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 })));

    await expect(google.drive.publishAttachment('token', { attachment, parentFolderId: 'source-message-folder' }))
      .resolves.toEqual({ outcome: 'failed', driveFileId: 'drive-file-1', publicUrl: null });
  });

  it('reuses the folder this application already created for a level and creates only the missing ones', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'existing-top' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'created-leaf' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.drive.ensureFolderPath('token', ['会計 2026', '添付'])).resolves.toBe('created-leaf');

    expect(decodeURIComponent(fetchMock.mock.calls[0]?.[0] as string)).toContain("'root' in parents");
    expect(decodeURIComponent(fetchMock.mock.calls[1]?.[0] as string)).toContain("'existing-top' in parents");
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1].body as string)).toEqual({
      name: '添付',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['existing-top'],
    });
  });

  it('creates a Source Message folder without looking for a same-named one', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'message-folder' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.drive.createFolder('token', { name: '2026-08-01 年次行事', parentId: 'leaf' })).resolves.toBe('message-folder');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toMatchObject({ name: '2026-08-01 年次行事', parents: ['leaf'] });
  });

  it('writes every Calendar event with sendUpdates=none and the caller-supplied revision guard', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'calendar-1', etag: 'etag-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'calendar-1', etag: 'etag-2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await google.calendar.createEvent('token', { summary: '例会', attachments: [{ fileUrl: 'https://drive.example/f' }] });
    await google.calendar.patchEvent('token', 'calendar-1', { description: 'x' }, { etag: 'etag-1' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none&supportsAttachments=true');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/calendar-1?sendUpdates=none');
    expect(new Headers(fetchMock.mock.calls[1]?.[1].headers).get('If-Match')).toBe('etag-1');
  });

  it('reads a Gmail attachment back as standard base64 and reports a refusal with its status', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: 'cGRm-LWJ5_dGVz' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Not Found' } }), { status: 404 })));

    await expect(google.gmail.readAttachments('token', 'gmail-1', [attachment]))
      .resolves.toEqual([{ ...attachment, data: 'cGRm+LWJ5/dGVz==' }]);
    await expect(google.gmail.readMessage('token', 'missing')).rejects.toMatchObject({ status: 404, url: expect.stringContaining('/messages/missing') } satisfies Partial<GoogleApiError>);
  });

  it('sends mail as one UTF-8 plain-text raw message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(google.gmail.sendMail('token', { destination: 'a@example.com', subject: '件名', body: '本文' })).resolves.toEqual({ id: 'sent-1' });

    const raw = (JSON.parse(fetchMock.mock.calls[0]?.[1].body as string) as { raw: string }).raw;
    const decoded = Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
    expect(decoded).toContain('To: a@example.com');
    expect(decoded).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(decoded.endsWith('本文')).toBe(true);
  });
});

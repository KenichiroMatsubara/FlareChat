import { describe, expect, it, vi } from 'vitest';

import { publishDriveAttachment } from './drive-attachments';

describe('Drive attachment publication', () => {
  it('returns a public link only after the Drive anyone-reader permission succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive.example/file-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(publishDriveAttachment({
      accessToken: 'token',
      attachment: { attachmentId: 'attachment-1', filename: 'agenda.pdf', mimeType: 'application/pdf', size: 9, data: 'cGRmLWJ5dGVz' },
    })).resolves.toEqual({ outcome: 'succeeded', driveFileId: 'drive-file-1', publicUrl: 'https://drive.example/file-1' });

    expect(fetchMock.mock.calls[0]?.[0]).toContain('upload/drive/v3/files?uploadType=multipart&fields=id%2CwebViewLink');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.googleapis.com/drive/v3/files/drive-file-1/permissions');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body as string)).toEqual({ type: 'anyone', role: 'reader' });
    vi.unstubAllGlobals();
  });

  it('does not expose a link when public permission creation fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive.example/file-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(publishDriveAttachment({
      accessToken: 'token',
      attachment: { attachmentId: 'attachment-1', filename: 'agenda.pdf', mimeType: 'application/pdf', size: 9, data: 'cGRmLWJ5dGVz' },
    })).resolves.toEqual({ outcome: 'failed', driveFileId: 'drive-file-1', publicUrl: null });
    vi.unstubAllGlobals();
  });
});

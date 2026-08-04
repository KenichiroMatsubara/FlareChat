import { describe, expect, it, vi } from 'vitest';

import { createSourceMessageFolder, ensureAttachmentFolderPath, publishDriveAttachment } from './drive-attachments';

describe('Drive attachment publication', () => {
  it('returns a public link only after the Drive anyone-reader permission succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive.example/file-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(publishDriveAttachment({
      accessToken: 'token',
      attachment: { attachmentId: 'attachment-1', filename: 'agenda.pdf', mimeType: 'application/pdf', size: 9, data: 'cGRmLWJ5dGVz' },
      parentFolderId: 'source-message-folder',
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
      parentFolderId: 'source-message-folder',
    })).resolves.toEqual({ outcome: 'failed', driveFileId: 'drive-file-1', publicUrl: null });
    vi.unstubAllGlobals();
  });

  it('stores the file in the folder it was given instead of the Drive root', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive.example/file-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await publishDriveAttachment({
      accessToken: 'token',
      attachment: { attachmentId: 'attachment-1', filename: 'agenda.pdf', mimeType: 'application/pdf', size: 9, data: 'cGRmLWJ5dGVz' },
      parentFolderId: 'source-message-folder',
    });

    const body = fetchMock.mock.calls[0]?.[1].body as string;
    expect(JSON.parse(/\r\n\r\n(\{.*?\})\r\n/su.exec(body)?.[1] ?? '{}')).toMatchObject({
      name: 'agenda.pdf',
      parents: ['source-message-folder'],
    });
    vi.unstubAllGlobals();
  });
});

describe('Attachment Folder Path', () => {
  it('reuses the folder this application already created for a level and creates only the missing ones', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'existing-top' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'created-leaf' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureAttachmentFolderPath({ accessToken: 'token', segments: ['会計 2026', '添付'] }))
      .resolves.toBe('created-leaf');

    expect(decodeURIComponent(fetchMock.mock.calls[0]?.[0] as string)).toContain("'root' in parents");
    expect(decodeURIComponent(fetchMock.mock.calls[1]?.[0] as string)).toContain("'existing-top' in parents");
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1].body as string)).toEqual({
      name: '添付',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['existing-top'],
    });
    vi.unstubAllGlobals();
  });

  it('creates a Source Message folder without looking for a same-named one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'message-folder' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSourceMessageFolder({ accessToken: 'token', name: '2026-08-01 年次行事', parentId: 'leaf' }))
      .resolves.toBe('message-folder');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toMatchObject({ name: '2026-08-01 年次行事', parents: ['leaf'] });
    vi.unstubAllGlobals();
  });
});

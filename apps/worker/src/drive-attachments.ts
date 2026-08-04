export interface SourceAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface SourceAttachmentContent extends SourceAttachment {
  data: string;
}

export interface PublishedDriveAttachment {
  outcome: 'succeeded' | 'failed';
  driveFileId: string | null;
  publicUrl: string | null;
}

const googleError = async (response: Response, fallback: string): Promise<Error> => {
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
  return new Error(body.error?.message ?? fallback);
};

const standardBase64 = (value: string): string => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(value)) throw new Error('Gmail attachment data is not valid base64url.');
  const unpadded = value.replace(/=+$/u, '').replaceAll('-', '+').replaceAll('_', '/');
  return unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
};

/** Downloads accepted Gmail file parts once for AI extraction and publication. */
export const readGmailAttachments = async (input: {
  accessToken: string;
  gmailMessageId: string;
  attachments: SourceAttachment[];
}): Promise<SourceAttachmentContent[]> => Promise.all(input.attachments.map(async (attachment) => {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.gmailMessageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
    { headers: { Authorization: `Bearer ${input.accessToken}` } },
  );
  if (!response.ok) throw await googleError(response, 'Gmail attachment download failed.');
  const body = await response.json() as { data?: string };
  if (!body.data) throw new Error('Gmail attachment has no downloadable data.');
  return { ...attachment, data: standardBase64(body.data) };
}));

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

const escapeDriveQueryValue = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const createDriveFolder = async (input: {
  accessToken: string;
  name: string;
  parentId: string;
}): Promise<string> => {
  const response = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name, mimeType: FOLDER_MIME_TYPE, parents: [input.parentId] }),
  });
  if (!response.ok) throw await googleError(response, 'Drive folder creation failed.');
  const created = await response.json() as { id?: string };
  if (!created.id) throw new Error('Drive did not return a folder ID.');
  return created.id;
};

/**
 * Resolves one level of the Attachment Folder Path, reusing the folder this
 * application created there before. The `drive.file` grant sees only what this
 * application created, so a folder the Organization made by hand is invisible
 * here and a same-named folder is created beside it.
 */
const ensureDriveFolder = async (input: {
  accessToken: string;
  name: string;
  parentId: string;
}): Promise<string> => {
  const query = [
    `mimeType = '${FOLDER_MIME_TYPE}'`,
    `name = '${escapeDriveQueryValue(input.name)}'`,
    `'${escapeDriveQueryValue(input.parentId)}' in parents`,
    'trashed = false',
  ].join(' and ');
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=${
    encodeURIComponent('files(id)')}&orderBy=${encodeURIComponent('createdTime')}&pageSize=1`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${input.accessToken}` } });
  if (!response.ok) throw await googleError(response, 'Drive folder lookup failed.');
  const found = await response.json() as { files?: Array<{ id?: string }> };
  const existing = found.files?.[0]?.id;
  if (existing) return existing;
  return createDriveFolder(input);
};

/** Creates the Organization's Attachment Folder Path and returns its leaf folder ID. */
export const ensureAttachmentFolderPath = async (input: {
  accessToken: string;
  segments: readonly string[];
}): Promise<string> => {
  let parentId = 'root';
  for (const segment of input.segments) {
    parentId = await ensureDriveFolder({ accessToken: input.accessToken, name: segment, parentId });
  }
  return parentId;
};

/**
 * Creates the folder that holds one Source Message's Public Attachments. It is
 * always created rather than looked up by name, because ADR 0056 tracks a
 * folder by its stable ID once it exists and never restores a moved layout.
 */
export const createSourceMessageFolder = async (input: {
  accessToken: string;
  name: string;
  parentId: string;
}): Promise<string> => createDriveFolder(input);

/**
 * Copies an accepted Gmail attachment into Drive and grants its explicit public
 * reader permission. A Drive URL is withheld unless the permission succeeds.
 */
export const publishDriveAttachment = async (input: {
  accessToken: string;
  attachment: SourceAttachmentContent;
  parentFolderId: string;
}): Promise<PublishedDriveAttachment> => {
  let driveFileId: string | null = null;
  try {
    const headers = { Authorization: `Bearer ${input.accessToken}` };
    const boundary = `mail-automation-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({
      name: input.attachment.filename,
      mimeType: input.attachment.mimeType,
      parents: [input.parentFolderId],
    });
    const upload = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id%2CwebViewLink', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.attachment.mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${input.attachment.data}\r\n--${boundary}--`,
    });
    if (!upload.ok) throw await googleError(upload, 'Drive attachment upload failed.');
    const uploaded = await upload.json() as { id?: string; webViewLink?: string };
    if (!uploaded.id) throw new Error('Drive did not return an attachment file ID.');
    driveFileId = uploaded.id;

    const permission = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(uploaded.id)}/permissions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'anyone', role: 'reader' }),
    });
    if (!permission.ok) throw await googleError(permission, 'Drive public permission failed.');
    if (!uploaded.webViewLink) throw new Error('Drive did not return a public attachment URL.');
    return { outcome: 'succeeded', driveFileId, publicUrl: uploaded.webViewLink };
  } catch {
    return { outcome: 'failed', driveFileId, publicUrl: null };
  }
};

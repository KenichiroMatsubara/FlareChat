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

/**
 * Copies an accepted Gmail attachment into Drive and grants its explicit public
 * reader permission. A Drive URL is withheld unless the permission succeeds.
 */
export const publishDriveAttachment = async (input: {
  accessToken: string;
  attachment: SourceAttachmentContent;
}): Promise<PublishedDriveAttachment> => {
  let driveFileId: string | null = null;
  try {
    const headers = { Authorization: `Bearer ${input.accessToken}` };
    const boundary = `mail-automation-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name: input.attachment.filename, mimeType: input.attachment.mimeType });
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

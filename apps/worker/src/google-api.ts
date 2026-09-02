/**
 * The production Google adapter: Gmail, Calendar, and Drive spoken over `fetch`
 * (ADR 0172). URLs, encodings, and the `sendUpdates=none` rule live here and
 * nowhere else; a use-case asks for an operation and receives its result.
 */

import { refreshGoogleToken } from './google';
import { GoogleApiError } from './providers';
import type {
  CalendarEventResource,
  GmailHistory,
  GmailMessage,
  GoogleProvider,
  PublishedDriveAttachment,
  ReusableDriveAttachment,
  SourceAttachment,
  SourceAttachmentContent,
} from './providers';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

interface GoogleErrorBody {
  error?: { message?: string };
}

const request = async <T>(token: string, url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => ({})) as T & GoogleErrorBody;
  if (!response.ok) throw new GoogleApiError(body.error?.message ?? 'Google API request failed.', response.status, url);
  return body;
};

const standardBase64 = (value: string): string => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(value)) throw new Error('Gmail attachment data is not valid base64url.');
  const unpadded = value.replace(/=+$/u, '').replaceAll('-', '+').replaceAll('_', '/');
  return unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
};

const base64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64Url = (value: string): string =>
  base64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

/** The single UTF-8 plain-text message body the Gmail send endpoint accepts. */
export const gmailRawMessage = (input: { destination: string; subject: string; body: string }): string =>
  base64Url([
    `To: ${input.destination}`,
    `Subject: =?UTF-8?B?${base64(input.subject)}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.body,
  ].join('\r\n'));

const escapeDriveQueryValue = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const createFolder = async (token: string, input: { name: string; parentId: string }): Promise<string> => {
  const created = await request<{ id?: string }>(token, `${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    body: JSON.stringify({ name: input.name, mimeType: FOLDER_MIME_TYPE, parents: [input.parentId] }),
  });
  if (!created.id) throw new Error('Drive did not return a folder ID.');
  return created.id;
};

/**
 * Resolves one level of the Attachment Folder Path, reusing the folder this
 * application created there before. The `drive.file` grant sees only what this
 * application created, so a folder the Account made by hand is invisible here
 * and a same-named folder is created beside it.
 */
const ensureFolder = async (token: string, input: { name: string; parentId: string }): Promise<string> => {
  const query = [
    `mimeType = '${FOLDER_MIME_TYPE}'`,
    `name = '${escapeDriveQueryValue(input.name)}'`,
    `'${escapeDriveQueryValue(input.parentId)}' in parents`,
    'trashed = false',
  ].join(' and ');
  const url = `${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=${encodeURIComponent('files(id)')}&orderBy=${encodeURIComponent('createdTime')}&pageSize=1`;
  const found = await request<{ files?: Array<{ id?: string }> }>(token, url);
  return found.files?.[0]?.id ?? createFolder(token, input);
};

const calendarUrl = (path: string, parameters: Record<string, string>): string => {
  const url = new URL(path);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
};

export const googleApi = (): GoogleProvider => ({
  refreshToken: refreshGoogleToken,
  gmail: {
    listHistory: (token, input) => request<GmailHistory>(token, calendarUrl(`${GMAIL}/history`, {
      startHistoryId: input.startHistoryId,
      historyTypes: 'messageAdded',
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    })),
    currentHistoryId: async (token) => {
      const profile = await request<{ historyId?: string }>(token, `${GMAIL}/profile`);
      if (!profile.historyId) throw new Error('Gmail history position could not be captured.');
      return profile.historyId;
    },
    readMessage: (token, messageId) =>
      request<GmailMessage>(token, `${GMAIL}/messages/${encodeURIComponent(messageId)}?format=full`),
    searchMessages: async (token, input) => {
      const list = await request<{ messages?: Array<{ id?: string }> }>(token, calendarUrl(`${GMAIL}/messages`, {
        q: input.query,
        maxResults: String(input.maxResults),
      }));
      return (list.messages ?? []).flatMap((message) => message.id ? [message.id] : []);
    },
    readAttachments: (token, messageId, attachments: SourceAttachment[]) => Promise.all(attachments.map(async (attachment): Promise<SourceAttachmentContent> => {
      const body = await request<{ data?: string }>(
        token,
        `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
      );
      if (!body.data) throw new Error('Gmail attachment has no downloadable data.');
      return { ...attachment, data: standardBase64(body.data) };
    })),
    sendMail: async (token, input) => {
      const sent = await request<{ id?: string }>(token, `${GMAIL}/messages/send`, {
        method: 'POST',
        body: JSON.stringify({ raw: gmailRawMessage(input) }),
      });
      return { id: sent.id ?? null };
    },
  },
  calendar: {
    listEvents: async (token, input) => {
      const list = await request<{ items?: CalendarEventResource[] }>(token, calendarUrl(CALENDAR_EVENTS, {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        showDeleted: 'false',
        singleEvents: 'false',
        maxResults: String(input.maxResults),
        ...(input.query ? { q: input.query } : {}),
      }));
      return list.items ?? [];
    },
    readEvent: (token, eventId) =>
      request<CalendarEventResource>(token, `${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}`),
    createEvent: (token, event) => request<CalendarEventResource>(token, calendarUrl(CALENDAR_EVENTS, {
      sendUpdates: 'none',
      ...(Array.isArray(event.attachments) && event.attachments.length ? { supportsAttachments: 'true' } : {}),
    }), { method: 'POST', body: JSON.stringify(event) }),
    patchEvent: (token, eventId, event, options = {}) => request<CalendarEventResource>(
      token,
      calendarUrl(`${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}`, {
        sendUpdates: 'none',
        ...(Array.isArray(event.attachments) && event.attachments.length ? { supportsAttachments: 'true' } : {}),
      }),
      {
        method: 'PATCH',
        body: JSON.stringify(event),
        ...(options.etag ? { headers: { 'If-Match': options.etag } } : {}),
      },
    ),
  },
  drive: {
    ensureFolderPath: async (token, segments) => {
      let parentId = 'root';
      for (const segment of segments) parentId = await ensureFolder(token, { name: segment, parentId });
      return parentId;
    },
    // Always created rather than looked up by name, because ADR 0056 tracks a
    // Source Message's folder by its stable ID once it exists.
    createFolder,
    findPublishedAttachment: async (token, input): Promise<ReusableDriveAttachment | null> => {
      const query = [
        `name = '${escapeDriveQueryValue(input.filename)}'`,
        `'${escapeDriveQueryValue(input.folderId)}' in parents`,
        'trashed = false',
      ].join(' and ');
      const url = `${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=${encodeURIComponent('files(id,webViewLink)')}&pageSize=10`;
      try {
        const body = await request<{ files?: Array<{ id?: string; webViewLink?: string }> }>(token, url);
        const found = (body.files ?? []).find((file) => file.id && file.webViewLink);
        return found?.id && found.webViewLink ? { driveFileId: found.id, publicUrl: found.webViewLink } : null;
      } catch {
        return null;
      }
    },
    /** A Drive URL is withheld unless the anyone-reader permission succeeds. */
    publishAttachment: async (token, input): Promise<PublishedDriveAttachment> => {
      let driveFileId: string | null = null;
      try {
        const boundary = `mail-automation-${crypto.randomUUID()}`;
        const metadata = JSON.stringify({
          name: input.attachment.filename,
          mimeType: input.attachment.mimeType,
          parents: [input.parentFolderId],
        });
        const uploaded = await request<{ id?: string; webViewLink?: string }>(
          token,
          `${DRIVE_UPLOAD}?uploadType=multipart&fields=id%2CwebViewLink`,
          {
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.attachment.mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${input.attachment.data}\r\n--${boundary}--`,
          },
        );
        if (!uploaded.id) throw new Error('Drive did not return an attachment file ID.');
        driveFileId = uploaded.id;
        await request(token, `${DRIVE_FILES}/${encodeURIComponent(uploaded.id)}/permissions`, {
          method: 'POST',
          body: JSON.stringify({ type: 'anyone', role: 'reader' }),
        });
        if (!uploaded.webViewLink) throw new Error('Drive did not return a public attachment URL.');
        return { outcome: 'succeeded', driveFileId, publicUrl: uploaded.webViewLink };
      } catch {
        return { outcome: 'failed', driveFileId, publicUrl: null };
      }
    },
  },
});

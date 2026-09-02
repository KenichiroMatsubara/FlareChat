/**
 * In-memory twins of the providers (ADR 0172).
 *
 * A test states what Gmail holds, what the Calendar shows, and what the model
 * will answer, runs the use-case, and then reads what was sent and written back
 * — the same seam production crosses, with nothing stubbed around it.
 */

import { GoogleGrantRejectedError, type GoogleTokenSet } from '../src/google';
import { GoogleApiError } from '../src/providers';
import type {
  AiProvider,
  CalendarEventResource,
  Fetch,
  GmailMessage,
  GmailPart,
  GoogleProvider,
  Providers,
  SourceAttachmentContent,
} from '../src/providers';
import type { AgentModelCompletion, AgentModelRequest } from '../src/agent-runs';
import type { ChatModelCompletion, ChatModelRequest } from '../src/chat';
import type { MailExtraction } from '../src/event-details';
import type { EventCorrespondence } from '../src/event-refresh';

export const gmailBody = (value: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

export interface MemoryAttachment {
  attachmentId?: string;
  filename: string;
  mimeType: string;
  /** Standard base64 of the file's bytes. */
  data: string;
}

export interface MemoryMessage {
  id: string;
  subject?: string;
  sender?: string;
  body?: string;
  /** A ready-made Gmail part tree, for messages whose shape is the point of the test. */
  payload?: GmailPart;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  attachments?: MemoryAttachment[];
}

const messagePayload = (message: MemoryMessage): GmailPart => {
  if (message.payload) return message.payload;
  const attachments = (message.attachments ?? []).map((attachment, index): GmailPart => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    body: {
      attachmentId: attachment.attachmentId ?? `attachment-${index + 1}`,
      size: Math.floor(attachment.data.length * 3 / 4),
    },
  }));
  const text: GmailPart = {
    mimeType: 'text/plain',
    body: { data: gmailBody(message.body ?? '') },
  };
  return {
    headers: [
      { name: 'Subject', value: message.subject ?? '' },
      { name: 'From', value: message.sender ?? 'member@example.com' },
    ],
    ...(attachments.length
      ? { mimeType: 'multipart/mixed', parts: [text, ...attachments] }
      : { mimeType: 'text/plain', body: { data: gmailBody(message.body ?? '') } }),
  };
};

const toBase64Url = (standard: string): string => standard.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

export interface MemoryCalendarEvent extends CalendarEventResource {
  id: string;
}

type GoogleOperation = 'listHistory' | 'readMessage' | 'readAttachments' | 'sendMail' | 'listEvents' | 'readEvent' | 'createEvent' | 'patchEvent' | 'publishAttachment' | 'ensureFolderPath';

export interface MemoryGoogle extends GoogleProvider {
  mailbox: {
    historyId: string;
    /** Messages Gmail history reports as added, in order. */
    inbox: MemoryMessage[];
    /** Messages readable by id, whether or not history reports them. */
    messages: Map<string, MemoryMessage>;
    /** Ids Gmail answers 404 for, as a deleted message does. */
    missing: Set<string>;
    /** Whether the stored history cursor has fallen outside Gmail's window. */
    historyExpired: boolean;
    historyRequests: string[];
    sent: Array<{ destination: string; subject: string; body: string }>;
  };
  events: Map<string, MemoryCalendarEvent>;
  eventWrites: Array<{ operation: 'create' | 'patch'; id: string; body: Record<string, unknown>; etag: string | null }>;
  drive: GoogleProvider['drive'] & {
    files: Array<{ id: string; filename: string; folderId: string; url: string }>;
    folders: string[];
    publishFails: boolean;
  };
  tokens: {
    refreshed: number;
    rejectGrant: boolean;
    refreshError: Error | null;
  };
  /** Makes the named operation throw once, with the error given. */
  failNext(operation: GoogleOperation, error: Error): void;
  addMessage(message: MemoryMessage): void;
  addEvent(event: Omit<MemoryCalendarEvent, 'etag'> & { etag?: string }): MemoryCalendarEvent;
}

export const memoryGoogle = (): MemoryGoogle => {
  const failures = new Map<GoogleOperation, Error>();
  const failing = (operation: GoogleOperation): void => {
    const error = failures.get(operation);
    if (!error) return;
    failures.delete(operation);
    throw error;
  };
  let eventCounter = 0;
  let etagCounter = 0;
  const nextEtag = (): string => `etag-${++etagCounter}`;
  const google: MemoryGoogle = {
    mailbox: {
      historyId: 'history-1',
      inbox: [],
      messages: new Map(),
      missing: new Set(),
      historyExpired: false,
      historyRequests: [],
      sent: [],
    },
    events: new Map(),
    eventWrites: [],
    tokens: { refreshed: 0, rejectGrant: false, refreshError: null },
    failNext: (operation, error) => { failures.set(operation, error); },
    addMessage: (message) => {
      google.mailbox.inbox.push(message);
      google.mailbox.messages.set(message.id, message);
    },
    addEvent: (event) => {
      const stored: MemoryCalendarEvent = { ...event, etag: event.etag ?? nextEtag() };
      google.events.set(stored.id, stored);
      return stored;
    },
    refreshToken: async (): Promise<GoogleTokenSet> => {
      if (google.tokens.rejectGrant) throw new GoogleGrantRejectedError('invalid_grant', 'Token has been expired or revoked.');
      if (google.tokens.refreshError) throw google.tokens.refreshError;
      google.tokens.refreshed += 1;
      return {
        accessToken: `access-token-${google.tokens.refreshed}`,
        refreshToken: 'refresh-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: [],
        tokenType: 'Bearer',
      };
    },
    gmail: {
      listHistory: async (_token, input) => {
        failing('listHistory');
        google.mailbox.historyRequests.push(input.startHistoryId);
        if (google.mailbox.historyExpired) throw new GoogleApiError('Requested entity was not found.', 404, 'history');
        return {
          historyId: google.mailbox.historyId,
          history: google.mailbox.inbox.map((message) => ({ messagesAdded: [{ message: { id: message.id } }] })),
        };
      },
      currentHistoryId: async () => google.mailbox.historyId,
      readMessage: async (_token, messageId): Promise<GmailMessage> => {
        failing('readMessage');
        const message = google.mailbox.messages.get(messageId);
        if (!message || google.mailbox.missing.has(messageId)) {
          throw new GoogleApiError('Requested entity was not found.', 404, `/messages/${encodeURIComponent(messageId)}`);
        }
        return {
          id: message.id,
          ...(message.labelIds === undefined ? {} : { labelIds: message.labelIds }),
          ...(message.internalDate === undefined ? {} : { internalDate: message.internalDate }),
          ...(message.snippet === undefined ? {} : { snippet: message.snippet }),
          payload: messagePayload(message),
        };
      },
      // Gmail's subject search is forgiving about width and whitespace, so the
      // twin offers every message and leaves the exact match to the caller.
      searchMessages: async (_token, input) => [...google.mailbox.messages.keys()].slice(0, input.maxResults),
      readAttachments: async (_token, messageId, attachments) => {
        failing('readAttachments');
        const message = google.mailbox.messages.get(messageId);
        return attachments.map((attachment): SourceAttachmentContent => {
          const stored = (message?.attachments ?? []).find((candidate, index) =>
            (candidate.attachmentId ?? `attachment-${index + 1}`) === attachment.attachmentId);
          if (!stored) throw new GoogleApiError('Attachment was not found.', 404, `/attachments/${attachment.attachmentId}`);
          // Gmail hands back base64url; the adapter standardises it, so the twin does the same.
          void toBase64Url;
          return { ...attachment, data: stored.data };
        });
      },
      sendMail: async (_token, input) => {
        failing('sendMail');
        google.mailbox.sent.push(input);
        return { id: `sent-${google.mailbox.sent.length}` };
      },
    },
    calendar: {
      listEvents: async (_token, input) => {
        failing('listEvents');
        const min = Date.parse(input.timeMin);
        const max = Date.parse(input.timeMax);
        return [...google.events.values()].filter((event) => {
          const start = event.start?.dateTime ? Date.parse(event.start.dateTime) : null;
          if (start !== null && (start < min || start > max)) return false;
          return !input.query || (event.description ?? '').includes(input.query);
        });
      },
      readEvent: async (_token, eventId) => {
        failing('readEvent');
        const event = google.events.get(eventId);
        if (!event) throw new GoogleApiError('Not Found', 404, `/events/${eventId}`);
        return event;
      },
      createEvent: async (_token, body) => {
        failing('createEvent');
        const id = `calendar-event-${++eventCounter}`;
        const stored: MemoryCalendarEvent = { ...(body as CalendarEventResource), id, etag: nextEtag() };
        google.events.set(id, stored);
        google.eventWrites.push({ operation: 'create', id, body, etag: null });
        return stored;
      },
      patchEvent: async (_token, eventId, body, options = {}) => {
        failing('patchEvent');
        const current = google.events.get(eventId);
        if (!current) throw new GoogleApiError('Not Found', 404, `/events/${eventId}`);
        if (options.etag && current.etag !== options.etag) throw new GoogleApiError('Precondition Failed', 412, `/events/${eventId}`);
        const updated: MemoryCalendarEvent = { ...current, ...(body as CalendarEventResource), id: eventId, etag: nextEtag() };
        google.events.set(eventId, updated);
        google.eventWrites.push({ operation: 'patch', id: eventId, body, etag: options.etag ?? null });
        return updated;
      },
    },
    drive: {
      files: [],
      folders: [],
      publishFails: false,
      ensureFolderPath: async (_token, segments) => {
        failing('ensureFolderPath');
        const id = `folder:${segments.join('/')}`;
        if (!google.drive.folders.includes(id)) google.drive.folders.push(id);
        return id;
      },
      createFolder: async (_token, input) => {
        const id = `${input.parentId}/${input.name}`;
        google.drive.folders.push(id);
        return id;
      },
      findPublishedAttachment: async (_token, input) => {
        const found = google.drive.files.find((file) => file.filename === input.filename && file.folderId === input.folderId);
        return found ? { driveFileId: found.id, publicUrl: found.url } : null;
      },
      publishAttachment: async (_token, input) => {
        failing('publishAttachment');
        if (google.drive.publishFails) return { outcome: 'failed', driveFileId: null, publicUrl: null };
        const id = `drive-file-${google.drive.files.length + 1}`;
        const url = `https://drive.example/${encodeURIComponent(input.attachment.filename)}`;
        google.drive.files.push({ id, filename: input.attachment.filename, folderId: input.parentFolderId, url });
        return { outcome: 'succeeded', driveFileId: id, publicUrl: url };
      },
    },
  };
  return google;
};

export interface MemoryAi extends AiProvider {
  /** What the next extractions answer, in order; the last one repeats. */
  extractions: Array<MailExtraction | null | Error>;
  extractionRequests: Array<Parameters<AiProvider['extract']>[0]>;
  correspondences: Array<EventCorrespondence[] | null | Error>;
  agentTurns: Array<AgentModelCompletion | Error | ((request: AgentModelRequest) => AgentModelCompletion)>;
  agentRequests: AgentModelRequest[];
  chatTurns: Array<ChatModelCompletion | Error | ((request: ChatModelRequest) => ChatModelCompletion)>;
  chatRequests: ChatModelRequest[];
}

const nextAnswer = <T>(queue: T[]): T | undefined => queue.length > 1 ? queue.shift() : queue[0];

export const memoryAi = (): MemoryAi => {
  const ai: MemoryAi = {
    extractions: [],
    extractionRequests: [],
    correspondences: [[]],
    agentTurns: [],
    agentRequests: [],
    chatTurns: [],
    chatRequests: [],
    extract: async (input) => {
      ai.extractionRequests.push(input);
      const answer = nextAnswer(ai.extractions);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error('The test model was given no extraction to answer with.');
      return answer;
    },
    correspond: async () => {
      const answer = nextAnswer(ai.correspondences);
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    completeAgentTurn: async (request) => {
      ai.agentRequests.push(request);
      const answer = nextAnswer(ai.agentTurns);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error('The test model was given no Agent turn to answer with.');
      return typeof answer === 'function' ? answer(request) : answer;
    },
    completeChatTurn: async (request) => {
      ai.chatRequests.push(request);
      const answer = nextAnswer(ai.chatTurns);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error('The test model was given no chat turn to answer with.');
      return typeof answer === 'function' ? answer(request) : answer;
    },
  };
  return ai;
};

export interface RecordedSend {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MemoryTransport {
  fetch: Fetch;
  sends: RecordedSend[];
  /** Answers a URL containing the key with the given response, or the default. */
  answers: Array<{ match: string | RegExp; respond: (send: RecordedSend) => Response }>;
  /** The LINE push status the twin answers with. */
  lineStatus: number;
}

const defaultResponse = (send: RecordedSend): Response => {
  if (send.url.includes('api.line.me')) return new Response('', { status: 200, headers: { 'x-line-request-id': `line-${Date.now()}` } });
  if (send.url.includes('discord.com')) return Response.json({ id: `discord-${Date.now()}` });
  return Response.json({});
};

export const memoryTransport = (): MemoryTransport => {
  const transport: MemoryTransport = {
    sends: [],
    answers: [],
    lineStatus: 200,
    fetch: async (url, init = {}) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
      const raw = typeof init.body === 'string' ? init.body : null;
      let body: unknown = raw;
      try {
        body = raw === null ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const send: RecordedSend = { url, method: init.method ?? 'GET', headers, body };
      transport.sends.push(send);
      const answer = transport.answers.find(({ match }) => typeof match === 'string' ? url.includes(match) : match.test(url));
      if (answer) return answer.respond(send);
      if (url.includes('api.line.me') && transport.lineStatus !== 200) return new Response('', { status: transport.lineStatus });
      return defaultResponse(send);
    },
  };
  return transport;
};

export interface MemoryProviders extends Providers {
  google: MemoryGoogle;
  ai: MemoryAi;
  transport: MemoryTransport;
}

export const memoryProviders = (): MemoryProviders => {
  const transport = memoryTransport();
  return { google: memoryGoogle(), ai: memoryAi(), transport, fetch: transport.fetch };
};

/** An extraction with one dated Event Candidate, the shape most tests need. */
export const invitationExtraction = (overrides: Partial<MailExtraction> = {}): MailExtraction => ({
  kind: 'invitation',
  summary: '例会のお知らせです。',
  events: [{
    title: '例会',
    startsAt: '2026-08-03T19:00:00+09:00',
    endsAt: '2026-08-03T21:30:00+09:00',
    timeZone: 'Asia/Tokyo',
    location: '',
    description: '例会です。',
    summary: '毎月の例会です。',
  }],
  tasks: [],
  guests: [],
  warnings: [],
  ...overrides,
});

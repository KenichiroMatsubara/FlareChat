/**
 * The providers the automation is built from (ADR 0172).
 *
 * Each provider is one adapter that owns its URLs, its authentication, and its
 * transport, and speaks in the operations the product performs rather than in
 * request and response shapes. A use-case receives the set and never reaches a
 * provider by any other path, so a test substitutes an in-memory twin of the
 * same interface instead of stubbing the global `fetch` around it.
 */

import { completeAgentTurn, type AgentModelCompletion, type AgentModelRequest } from './agent-runs';
import { completeChatTurn } from './chat-model';
import type { ChatModelCompletion, ChatModelRequest } from './chat';
import type { ConvertedAttachment, MarkdownConverter } from './attachment-conversion';
import { extractAiEventDetails, type ContactDescription, type EventDetails, type MailExtraction } from './event-details';
import { decideEventCorrespondence, type CalendarAttendee, type CalendarEventFields, type EventCorrespondence } from './event-refresh';
import type { GoogleTokenSet } from './google';
import { googleApi } from './google-api';

export interface GmailPart {
  filename?: string;
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id?: string;
  labelIds?: string[];
  payload?: GmailPart;
  snippet?: string;
  /** Gmail's delivery timestamp as epoch milliseconds. */
  internalDate?: string;
}

export interface GmailHistory {
  historyId?: string;
  nextPageToken?: string;
  history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
}

export interface CalendarTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarEventResource {
  id?: string;
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  attendees?: CalendarAttendee[];
}

/** One attachment part of a Source Message, before its bytes are read. */
export interface SourceAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** An attachment with its bytes, as standard base64. */
export interface SourceAttachmentContent extends SourceAttachment {
  data: string;
}

/** A Public Attachment as Drive reports it, or the failure that withheld its link. */
export interface PublishedDriveAttachment {
  outcome: 'succeeded' | 'failed';
  driveFileId: string | null;
  publicUrl: string | null;
}

export interface ReusableDriveAttachment {
  driveFileId: string;
  publicUrl: string;
}

/** A Google refusal, with the status and the operation the caller needs to classify it. */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.url = url;
  }
}

/** Everything the product does at Google, in the product's own words. */
export interface GoogleProvider {
  refreshToken(input: { refreshToken: string; clientId: string; clientSecret: string }): Promise<GoogleTokenSet>;
  gmail: {
    listHistory(token: string, input: { startHistoryId: string; pageToken?: string }): Promise<GmailHistory>;
    currentHistoryId(token: string): Promise<string>;
    readMessage(token: string, messageId: string): Promise<GmailMessage>;
    searchMessages(token: string, input: { query: string; maxResults: number }): Promise<string[]>;
    readAttachments(token: string, messageId: string, attachments: SourceAttachment[]): Promise<SourceAttachmentContent[]>;
    sendMail(token: string, input: { destination: string; subject: string; body: string }): Promise<{ id: string | null }>;
  };
  calendar: {
    listEvents(token: string, input: { timeMin: string; timeMax: string; query?: string; maxResults: number }): Promise<CalendarEventResource[]>;
    readEvent(token: string, eventId: string): Promise<CalendarEventResource>;
    /** Creates an event with `sendUpdates=none`; Google never mails an attendee on the automation's behalf. */
    createEvent(token: string, event: Record<string, unknown>): Promise<CalendarEventResource>;
    /** Patches an event with `sendUpdates=none`, guarded by the revision the caller last saw when one is given. */
    patchEvent(token: string, eventId: string, event: Record<string, unknown>, options?: { etag?: string | null }): Promise<CalendarEventResource>;
  };
  drive: {
    ensureFolderPath(token: string, segments: readonly string[]): Promise<string>;
    createFolder(token: string, input: { name: string; parentId: string }): Promise<string>;
    findPublishedAttachment(token: string, input: { filename: string; folderId: string }): Promise<ReusableDriveAttachment | null>;
    publishAttachment(token: string, input: { attachment: SourceAttachmentContent; parentFolderId: string }): Promise<PublishedDriveAttachment>;
  };
}

export interface AiExtractionInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  source: string;
  attachments?: SourceAttachmentContent[];
  convertedAttachments?: ConvertedAttachment[];
  markdown?: MarkdownConverter;
  roster?: ContactDescription[];
  receivedAt?: string;
}

export interface AiCorrespondenceInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  candidates: EventDetails[];
  existing: CalendarEventFields[];
}

/** The model provider: bounded extraction, correspondence, and the two conversational turns. */
export interface AiProvider {
  extract(input: AiExtractionInput): Promise<MailExtraction | null>;
  correspond(input: AiCorrespondenceInput): Promise<EventCorrespondence[] | null>;
  completeAgentTurn(request: AgentModelRequest): Promise<AgentModelCompletion>;
  completeChatTurn(request: ChatModelRequest): Promise<ChatModelCompletion>;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Providers {
  google: GoogleProvider;
  ai: AiProvider;
  /** The transport the Channels and MCP clients send on; the Channel adapters own the URLs. */
  fetch: Fetch;
}

/** The one production provider set; every entrance builds its use-cases from it. */
export const productionProviders = (): Providers => ({
  google: googleApi(),
  ai: {
    extract: extractAiEventDetails,
    correspond: decideEventCorrespondence,
    completeAgentTurn,
    completeChatTurn,
  },
  fetch: (url, init) => fetch(url, init),
});

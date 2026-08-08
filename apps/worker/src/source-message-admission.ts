export type SourceMessageIgnoreReason =
  | 'calendar_transport'
  | 'discarded_mailbox_state'
  | 'promotion'
  | 'sent';

export type SourceMessageAdmission =
  | { kind: 'admit' }
  | { kind: 'ignore'; reason: SourceMessageIgnoreReason };

export interface SourceMessagePartMetadata {
  filename?: string;
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  parts?: SourceMessagePartMetadata[];
}

export interface SourceMessageMetadata {
  labelIds?: string[];
  payload?: SourceMessagePartMetadata;
}

const headerValue = (part: SourceMessagePartMetadata | undefined, name: string): string =>
  part?.headers?.find((header) => header.name?.toLowerCase() === name)?.value?.trim() ?? '';

const everyPart = (part: SourceMessagePartMetadata | undefined): SourceMessagePartMetadata[] =>
  part ? [part, ...(part.parts ?? []).flatMap(everyPart)] : [];

const isCalendarPart = (part: SourceMessagePartMetadata): boolean => {
  const mimeType = part.mimeType?.toLowerCase() ?? '';
  const contentType = headerValue(part, 'content-type').toLowerCase();
  const filename = part.filename?.toLowerCase() ?? '';
  return mimeType === 'text/calendar'
    || mimeType === 'application/ics'
    || contentType.startsWith('text/calendar')
    || contentType.startsWith('application/ics')
    || filename.endsWith('.ics');
};

const isGoogleCalendarTransport = (payload: SourceMessagePartMetadata | undefined): boolean => {
  const messageId = headerValue(payload, 'message-id');
  const sender = headerValue(payload, 'from').toLowerCase();
  return /^<calendar-[^>]+@google\.com>$/iu.test(messageId)
    || /\bcalendar-notification@google\.com\b/iu.test(sender);
};

/**
 * Decides whether an unattended inbox sweep should admit a Gmail message to
 * rule matching and AI. It recognizes transport and mailbox metadata only;
 * it never guesses from event-like words in an untrusted subject or body.
 */
export const decideSourceMessageAdmission = (message: SourceMessageMetadata): SourceMessageAdmission => {
  const labels = new Set(message.labelIds ?? []);
  if (labels.has('SENT')) return { kind: 'ignore', reason: 'sent' };
  if (['DRAFT', 'SPAM', 'TRASH'].some((label) => labels.has(label))) {
    return { kind: 'ignore', reason: 'discarded_mailbox_state' };
  }
  if (labels.has('CATEGORY_PROMOTIONS')) return { kind: 'ignore', reason: 'promotion' };
  if (everyPart(message.payload).some(isCalendarPart) || isGoogleCalendarTransport(message.payload)) {
    return { kind: 'ignore', reason: 'calendar_transport' };
  }
  return { kind: 'admit' };
};

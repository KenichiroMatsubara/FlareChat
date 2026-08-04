import type { GoogleAutomationPort } from './automation/providers';
import { organizationDatabase } from './storage/database';
import { deliveries } from './storage/organization-schema';

export interface DeliveryAttempt {
  id: string;
  eventId: string | null;
  sourceMessageId: string | null;
  destination: string;
  channel: 'calendar' | 'line' | 'email' | 'drive';
  outcome: 'succeeded' | 'failed' | 'pending';
  externalId: string | null;
  createdAt: string;
}

/** Preserves one external effect outcome per destination instead of collapsing a partial batch. */
export const recordDeliveryAttempt = async (
  database: D1Database,
  input: Omit<DeliveryAttempt, 'id' | 'createdAt' | 'eventId' | 'sourceMessageId'> & {
    eventId?: string | null;
    sourceMessageId?: string | null;
  },
): Promise<DeliveryAttempt> => {
  const record: DeliveryAttempt = {
    id: crypto.randomUUID(),
    eventId: input.eventId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    destination: input.destination,
    channel: input.channel,
    outcome: input.outcome,
    externalId: input.externalId,
    createdAt: new Date().toISOString(),
  };
  await organizationDatabase(database).insert(deliveries).values(record).run();
  return record;
};

const base64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64Url = (value: string): string =>
  base64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

/** Builds the single UTF-8 plain-text message body that the Gmail send endpoint accepts. */
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

/** Sends one Source Message notice through the Automation Inbox and records the effect independently of Events. */
export const deliverSourceMessageEmail = async (input: {
  database: D1Database;
  google: GoogleAutomationPort;
  accessToken: string;
  sourceMessageId: string;
  destination: string;
  subject: string;
  body: string;
}): Promise<DeliveryAttempt> => {
  let outcome: DeliveryAttempt['outcome'] = 'failed';
  let externalId: string | null = null;
  try {
    const raw = gmailRawMessage({ destination: input.destination, subject: input.subject, body: input.body });
    const sent = await input.google.request<{ id?: string }>(
      input.accessToken,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { method: 'POST', body: JSON.stringify({ raw }) },
    );
    outcome = 'succeeded';
    externalId = sent.id ?? null;
  } catch {
    // The failed intended effect remains visible and independently retryable.
  }
  return recordDeliveryAttempt(input.database, {
    sourceMessageId: input.sourceMessageId,
    destination: input.destination,
    channel: 'email',
    outcome,
    externalId,
  });
};

/** Invites one snapshotted recipient and always leaves an independent Delivery Record. */
export const deliverCalendarInvitation = async (input: {
  database: D1Database;
  accessToken: string;
  eventId: string;
  calendarEventId: string;
  recipientEmail: string;
}): Promise<DeliveryAttempt> => {
  try {
    const existing = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.calendarEventId)}`, { headers: { Authorization: `Bearer ${input.accessToken}` } });
    const event = existing.ok ? await existing.json() as { attendees?: Array<{ email?: string }> } : { attendees: [] };
    const attendees = event.attendees ?? [];
    if (!attendees.some((attendee) => attendee.email?.toLowerCase() === input.recipientEmail.toLowerCase())) attendees.push({ email: input.recipientEmail });
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.calendarEventId)}?sendUpdates=all`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendees }),
      },
    );
    const body = await response.json() as { id?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? 'Google Calendar invitation failed.');
    return recordDeliveryAttempt(input.database, {
      eventId: input.eventId,
      destination: input.recipientEmail,
      channel: 'calendar',
      outcome: 'succeeded',
      externalId: body.id ?? input.calendarEventId,
    });
  } catch {
    return recordDeliveryAttempt(input.database, {
      eventId: input.eventId,
      destination: input.recipientEmail,
      channel: 'calendar',
      outcome: 'failed',
      externalId: null,
    });
  }
};

/** Sends one LINE push batch (at most five message objects) and records every intended notification. */
export const deliverLineBatch = async (input: {
  database: D1Database;
  accessToken: string;
  eventId?: string | null;
  sourceMessageId?: string | null;
  destinationId: string;
  messages: string[];
}): Promise<DeliveryAttempt[]> => {
  if (!input.messages.length || input.messages.length > 5) throw new Error('A LINE batch must contain between one and five messages.');
  let outcome: DeliveryAttempt['outcome'] = 'failed';
  let externalId: string | null = null;
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: input.destinationId, messages: input.messages.map((text) => ({ type: 'text', text })) }),
    });
    if (!response.ok) throw new Error('LINE push failed.');
    outcome = 'succeeded';
    externalId = response.headers.get('x-line-request-id');
  } catch {
    // Every failed intended message still receives its own retryable record below.
  }
  return Promise.all(input.messages.map(() => recordDeliveryAttempt(input.database, {
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
    destination: input.destinationId,
    channel: 'line',
    outcome,
    externalId,
  })));
};

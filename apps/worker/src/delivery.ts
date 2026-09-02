/**
 * Delivery Records: the immutable account of every external effect, one row per
 * intended destination (ADR 0010). Nothing here speaks to a provider; the
 * Channels and the Google adapter do that and record the outcome through this.
 */

import { eq } from 'drizzle-orm';

import { accountDatabase } from './storage/database';
import { deliveries, eventRecipients, contacts } from './storage/account-schema';

export interface DeliveryAttempt {
  id: string;
  eventId: string | null;
  sourceMessageId: string | null;
  destination: string;
  channel: 'calendar' | 'line' | 'email' | 'drive' | 'discord';
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
  await accountDatabase(database).insert(deliveries).values(record).run();
  return record;
};

export interface EventInvitee {
  contactId: string;
  name: string;
  email: string;
}

/** Rejects a roster address Google Calendar would reject for the whole batch. */
const invitableEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);

/**
 * The Google accounts a Scheduled Event invites: every active Contact that
 * carries an address. A Contact without one is administered without Calendar and
 * is simply absent from the attendee list rather than an automation failure.
 */
export const activeContactInvitees = async (database: D1Database): Promise<EventInvitee[]> => {
  const rows = await accountDatabase(database).select({
    contactId: contacts.id,
    name: contacts.name,
    email: contacts.email,
  }).from(contacts).where(eq(contacts.state, 'active')).all();
  const seen = new Set<string>();
  const invitees: EventInvitee[] = [];
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!invitableEmail(email) || seen.has(email)) continue;
    seen.add(email);
    invitees.push({ contactId: row.contactId, name: row.name, email });
  }
  return invitees;
};

/**
 * Freezes who one Scheduled Event invited and leaves one independent Delivery
 * Record per invitation, so a later roster change never rewrites the history of
 * an event that already reached its attendees. A withheld invitation is
 * recorded as `pending` rather than omitted, because the intended effect is
 * what a retry after publication correction has to find.
 */
export const recordEventInvitations = async (input: {
  database: D1Database;
  eventId: string;
  googleEventId: string | null;
  invitees: EventInvitee[];
  outcome: DeliveryAttempt['outcome'];
}): Promise<DeliveryAttempt[]> => {
  if (!input.invitees.length) return [];
  const database = accountDatabase(input.database);
  const createdAt = new Date().toISOString();
  for (const invitee of input.invitees) {
    await database.insert(eventRecipients).values({
      eventId: input.eventId,
      contactId: invitee.contactId,
      nameSnapshot: invitee.name,
      emailSnapshot: invitee.email,
      createdAt,
    }).onConflictDoNothing().run();
  }
  return Promise.all(input.invitees.map((invitee) => recordDeliveryAttempt(input.database, {
    eventId: input.eventId,
    destination: invitee.email,
    channel: 'calendar',
    outcome: input.outcome,
    externalId: input.outcome === 'succeeded' ? input.googleEventId : null,
  })));
};

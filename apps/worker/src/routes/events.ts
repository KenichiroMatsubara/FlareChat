import { and, eq, inArray } from 'drizzle-orm';

import { now } from '../clock';
import { invalid, notFound } from '../refusal';
import { resource } from '../response';
import { attendance, contacts, eventOverrides, eventRecipients, events } from '../storage/account-schema';
import { accountRoute, created } from './account';

export const eventRoutes = resource();

type EventStatus = 'draft' | 'scheduled' | 'cancelled' | 'exception';
const EVENT_STATUSES: readonly EventStatus[] = ['draft', 'scheduled', 'cancelled', 'exception'];

interface EventInput {
  title?: string;
  startsAt?: string;
  endsAt?: string;
  location?: string;
  description?: string;
  status?: string;
  reason?: string;
}

eventRoutes.patch('/organizations/:accountId/events/:eventId', accountRoute<EventInput>(async ({ db, session, body, params }) => {
  const changeSet = {
    ...(body.title === undefined ? {} : { title: body.title.trim() }),
    ...(body.startsAt === undefined ? {} : { startsAt: body.startsAt.trim() }),
    ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt.trim() }),
    ...(body.location === undefined ? {} : { location: body.location.trim() }),
    ...(body.description === undefined ? {} : { description: body.description.trim() }),
    ...(body.status === undefined ? {} : { status: body.status.trim() }),
  };
  if (!Object.keys(changeSet).length || Object.values(changeSet).some((value) => value === '')) throw invalid('At least one non-empty Event field is required.');
  const status = changeSet.status;
  if (status && !EVENT_STATUSES.includes(status as EventStatus)) throw invalid('Unsupported Event status.');
  const updates: Partial<typeof events.$inferInsert> = {};
  if (changeSet.title !== undefined) updates.title = changeSet.title;
  if (changeSet.startsAt !== undefined) updates.startsAt = changeSet.startsAt;
  if (changeSet.endsAt !== undefined) updates.endsAt = changeSet.endsAt;
  if (changeSet.location !== undefined) updates.location = changeSet.location;
  if (changeSet.description !== undefined) updates.description = changeSet.description;
  if (status !== undefined) updates.status = status as EventStatus;
  const eventId = params.eventId ?? '';
  const timestamp = now();
  const updated = await db.update(events).set({ ...updates, updatedAt: timestamp }).where(eq(events.id, eventId)).returning({ id: events.id }).get();
  if (!updated) throw notFound('Event was not found.');
  await db.insert(eventOverrides).values({
    id: crypto.randomUUID(),
    eventId,
    actorIdentityId: session.identity_id,
    changesJson: JSON.stringify(changeSet),
    reason: body.reason?.trim() ?? '',
    createdAt: timestamp,
  }).run();
  return { id: eventId, updatedFields: Object.keys(changeSet) };
}));

eventRoutes.post('/organizations/:accountId/events/:eventId/recipient-snapshots', accountRoute<{ contactIds?: unknown }>(async ({ db, body, params }) => {
  if (!Array.isArray(body.contactIds) || !body.contactIds.length || body.contactIds.some((id) => typeof id !== 'string' || !id.trim())) throw invalid('At least one Contact is required.');
  const contactIds = [...new Set((body.contactIds as string[]).map((id) => id.trim()))];
  const eventId = params.eventId ?? '';
  const recipients = await db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
    .where(and(inArray(contacts.id, contactIds), eq(contacts.state, 'active'))).all();
  if (recipients.length !== contactIds.length) throw notFound('One or more active Contacts were not found.');
  const timestamp = now();
  await Promise.all(recipients.map((recipient) => db.insert(attendance).values({
    eventId, contactId: recipient.id, status: 'unanswered', comment: '', updatedAt: timestamp,
  }).onConflictDoNothing().run()));
  await Promise.all(recipients.map((recipient) => db.insert(eventRecipients).values({
    eventId, contactId: recipient.id, nameSnapshot: recipient.name, emailSnapshot: recipient.email, createdAt: timestamp,
  }).onConflictDoNothing().run()));
  return created({ eventId, snapshotted: recipients.length });
}));

import { eq } from 'drizzle-orm';

import { organizationDatabase } from './storage/database';
import { events, exceptions } from './storage/organization-schema';

export const recordCalendarDeletion = async (database: D1Database, input: { eventId: string; sourceMessageId: string | null; now: string }): Promise<void> => {
  const db = organizationDatabase(database);
  await db.batch([
    db.update(events).set({ status: 'exception', updatedAt: input.now }).where(eq(events.id, input.eventId)),
    db.insert(exceptions).values({
      id: crypto.randomUUID(),
      sourceMessageId: input.sourceMessageId,
      code: 'calendar_event_deleted',
      message: 'The organizer deleted this Calendar event; it was not recreated.',
      state: 'open',
      createdAt: input.now,
    }),
  ]);
};

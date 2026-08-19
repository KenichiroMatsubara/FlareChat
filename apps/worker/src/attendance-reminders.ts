import { shouldSendAttendanceReminder } from '@mail/domain';
import { and, eq, isNotNull } from 'drizzle-orm';
import { createDatabaseAccess } from './database-access';
import type { Bindings } from './types';
import { controlDatabase, accountDatabase as drizzleAccountDatabase } from './storage/database';
import { accounts } from './storage/control-schema';
import { attendance, events, jobs, lineDestinations, contactLineDestinations, contacts } from './storage/account-schema';

interface ReminderCandidate {
  eventId: string;
  contactId: string;
  destination: string;
  status: 'unanswered' | 'attending' | 'not_attending';
  attendanceDeadline: string;
}

/** Queues one durable reminder per unanswered recipient and milestone. */
export const enqueueDueAttendanceReminders = async (database: D1Database, now: string): Promise<number> => {
  const db = drizzleAccountDatabase(database);
  const rows: ReminderCandidate[] = await db.select({
    eventId: attendance.eventId,
    contactId: attendance.contactId,
    destination: lineDestinations.destinationId,
    status: attendance.status,
    attendanceDeadline: events.attendanceDeadline,
  }).from(attendance)
    .innerJoin(events, eq(events.id, attendance.eventId))
    .innerJoin(contacts, eq(contacts.id, attendance.contactId))
    .innerJoin(contactLineDestinations, eq(contactLineDestinations.contactId, contacts.id))
    .innerJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
    .where(isNotNull(events.attendanceDeadline))
    .all() as ReminderCandidate[];
  let queued = 0;
  for (const row of rows) {
    const milestone = Math.floor((Date.parse(row.attendanceDeadline) - Date.parse(now)) / 86_400_000);
    const idempotencyKey = `attendance-reminder:${row.eventId}:${row.contactId}:${milestone}`;
    if (!shouldSendAttendanceReminder({ status: row.status, daysUntilDeadline: milestone, alreadySent: false })) continue;
    const timestamp = now;
    const result = await db.insert(jobs).values({
      id: crypto.randomUUID(),
      kind: 'attendance_reminder',
      payload: JSON.stringify({ eventId: row.eventId, contactId: row.contactId, destination: row.destination, milestone }),
      state: 'pending',
      attempts: 0,
      availableAt: timestamp,
      idempotencyKey,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).onConflictDoNothing().run();
    queued += result.meta.changes;
  }
  return queued;
};

/** Scans all active Account databases; suspended Accounts deliberately receive no new reminder work. */
export const enqueueDueAccountAttendanceReminders = async (env: Bindings, now: string): Promise<number> => {
  const activeAccounts = await controlDatabase(env.CONTROL_DB).select({
    bindingName: accounts.bindingName,
    databaseId: accounts.databaseId,
  }).from(accounts).where(and(eq(accounts.status, 'active'), isNotNull(accounts.databaseId))).all();
  let queued = 0;
  const databases = createDatabaseAccess(env);
  for (const account of activeAccounts) {
    const database = await databases.open({
      kind: 'organization',
      bindingName: account.bindingName,
      databaseId: account.databaseId,
    });
    queued += await enqueueDueAttendanceReminders(database.raw, now);
  }
  return queued;
};

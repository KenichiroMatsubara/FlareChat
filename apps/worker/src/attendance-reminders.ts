import { shouldSendAttendanceReminder } from '@mail/domain';
import { and, eq, isNotNull } from 'drizzle-orm';
import { organizationDatabase } from './organization-db';
import type { Bindings } from './types';
import { controlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { organizations } from './storage/control-schema';
import { attendance, events, jobs, listItems } from './storage/organization-schema';

interface ReminderCandidate {
  eventId: string;
  recipientItemId: string;
  destination: string;
  status: 'unanswered' | 'attending' | 'not_attending';
  attendanceDeadline: string;
}

/** Queues one durable reminder per unanswered recipient and milestone. */
export const enqueueDueAttendanceReminders = async (database: D1Database, now: string): Promise<number> => {
  const db = drizzleOrganizationDatabase(database);
  const rows: ReminderCandidate[] = await db.select({
    eventId: attendance.eventId,
    recipientItemId: attendance.recipientItemId,
    destination: listItems.value,
    status: attendance.status,
    attendanceDeadline: events.attendanceDeadline,
  }).from(attendance)
    .innerJoin(events, eq(events.id, attendance.eventId))
    .innerJoin(listItems, eq(listItems.id, attendance.recipientItemId))
    .where(isNotNull(events.attendanceDeadline))
    .all() as ReminderCandidate[];
  let queued = 0;
  for (const row of rows) {
    const milestone = Math.floor((Date.parse(row.attendanceDeadline) - Date.parse(now)) / 86_400_000);
    const idempotencyKey = `attendance-reminder:${row.eventId}:${row.recipientItemId}:${milestone}`;
    if (!shouldSendAttendanceReminder({ status: row.status, daysUntilDeadline: milestone, alreadySent: false })) continue;
    const timestamp = now;
    const result = await db.insert(jobs).values({
      id: crypto.randomUUID(),
      kind: 'attendance_reminder',
      payload: JSON.stringify({ eventId: row.eventId, recipientItemId: row.recipientItemId, destination: row.destination, milestone }),
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

/** Scans all active Organization databases; suspended Organizations deliberately receive no new reminder work. */
export const enqueueDueOrganizationAttendanceReminders = async (env: Bindings, now: string): Promise<number> => {
  const activeOrganizations = await controlDatabase(env.CONTROL_DB).select({
    bindingName: organizations.bindingName,
    databaseId: organizations.databaseId,
  }).from(organizations).where(and(eq(organizations.status, 'active'), isNotNull(organizations.databaseId))).all();
  let queued = 0;
  for (const organization of activeOrganizations) {
    const database = organizationDatabase(env, organization.bindingName, organization.databaseId);
    if (!database) continue;
    queued += await enqueueDueAttendanceReminders(database, now);
  }
  return queued;
};

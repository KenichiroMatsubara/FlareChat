import { DEFAULT_ATTENDANCE_REMINDER_DAYS, displayLineDestinationId, shouldSendAttendanceReminder } from '@mail/domain';
import { and, eq, isNotNull } from 'drizzle-orm';
import { ATTENDANCE_REMINDER_JOB_KIND } from './attendance-reminder-job';
import { createDatabaseAccess } from './database-access';
import { attendanceReminderNotice } from './notice';
import {
  ATTENDANCE_REMINDERS_ENABLED_SETTING,
  ATTENDANCE_REMINDER_DAYS_SETTING,
  accountReminderDays,
  accountRemindersEnabled,
  saveAccountReminderDays,
  saveAccountRemindersEnabled,
} from './reminder-settings';
import type { Bindings } from './types';
import { controlDatabase, accountDatabase as drizzleAccountDatabase } from './storage/database';
import type { AccountDatabase } from './storage/database';
import { accounts } from './storage/control-schema';
import { attendance, events, jobs, lineDestinations, contactLineDestinations, contacts } from './storage/account-schema';

interface ReminderCandidate {
  eventId: string;
  eventTitle: string;
  contactId: string;
  contactName: string;
  destination: string;
  status: 'unanswered' | 'attending' | 'not_attending';
  attendanceDeadline: string;
}

export const accountAttendanceRemindersEnabled = (database: AccountDatabase): Promise<boolean> =>
  accountRemindersEnabled(database, ATTENDANCE_REMINDERS_ENABLED_SETTING);

export const saveAccountAttendanceRemindersEnabled = (
  database: AccountDatabase,
  enabled: boolean,
  updatedAt: string,
): Promise<void> => saveAccountRemindersEnabled(database, ATTENDANCE_REMINDERS_ENABLED_SETTING, enabled, updatedAt);

/**
 * The milestones this Account asks for an answer on, falling back to the
 * product default. ADR 0164 gives attendance the cadence a Task already had,
 * because a Response Deadline an Account sets itself is exactly the deadline it
 * knows best how far ahead to chase.
 */
export const accountAttendanceReminderDays = (database: AccountDatabase): Promise<readonly number[]> =>
  accountReminderDays(database, ATTENDANCE_REMINDER_DAYS_SETTING, DEFAULT_ATTENDANCE_REMINDER_DAYS);

export const saveAccountAttendanceReminderDays = (
  database: AccountDatabase,
  days: readonly number[],
  updatedAt: string,
): Promise<void> => saveAccountReminderDays(database, ATTENDANCE_REMINDER_DAYS_SETTING, days, updatedAt);

/** The unanswered, LINE-reachable Registrations both the queue and the preview read. */
const attendanceReminderCandidates = async (db: AccountDatabase): Promise<ReminderCandidate[]> => await db.select({
  eventId: attendance.eventId,
  eventTitle: events.title,
  contactId: attendance.contactId,
  contactName: contacts.name,
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

/** One attendance reminder this Account's configuration will send, before it is sent. */
export interface ScheduledAttendanceReminder {
  eventId: string;
  eventTitle: string;
  deadline: string;
  contactId: string;
  contactName: string;
  channel: string;
  destination: string;
  milestone: number;
  sendOn: string;
  text: string;
}

const day = (instant: number): string => new Date(instant).toISOString().slice(0, 10);

/**
 * Every attendance reminder still ahead of this Account, composed exactly as it
 * will be delivered. It answers the same question the Task preview does, and is
 * readable whether or not the switch is on, because deciding to turn reminders
 * on is exactly when somebody needs to see what turning them on would send.
 */
export const upcomingAttendanceReminders = async (
  database: D1Database,
  now: string,
): Promise<ScheduledAttendanceReminder[]> => {
  const db = drizzleAccountDatabase(database);
  const milestones = await accountAttendanceReminderDays(db);
  if (milestones.length === 0) return [];
  const rows = await attendanceReminderCandidates(db);
  const today = day(Date.parse(now));
  const scheduled: ScheduledAttendanceReminder[] = [];
  for (const row of rows) {
    if (row.status !== 'unanswered') continue;
    for (const milestone of milestones) {
      const sendOn = day(Date.parse(row.attendanceDeadline) - milestone * 86_400_000);
      if (sendOn < today) continue;
      scheduled.push({
        eventId: row.eventId,
        eventTitle: row.eventTitle,
        deadline: row.attendanceDeadline,
        contactId: row.contactId,
        contactName: row.contactName,
        channel: 'line',
        destination: displayLineDestinationId(row.destination),
        milestone,
        sendOn,
        text: attendanceReminderNotice({ title: row.eventTitle, deadline: row.attendanceDeadline, milestone }),
      });
    }
  }
  return scheduled.sort((left, right) => left.sendOn.localeCompare(right.sendOn) || left.eventTitle.localeCompare(right.eventTitle));
};

/** Queues one durable reminder per unanswered recipient and milestone. */
export const enqueueDueAttendanceReminders = async (database: D1Database, now: string): Promise<number> => {
  const db = drizzleAccountDatabase(database);
  if (!await accountAttendanceRemindersEnabled(db)) return 0;
  const milestones = await accountAttendanceReminderDays(db);
  if (milestones.length === 0) return 0;
  const rows = await attendanceReminderCandidates(db);
  let queued = 0;
  for (const row of rows) {
    const milestone = Math.floor((Date.parse(row.attendanceDeadline) - Date.parse(now)) / 86_400_000);
    const idempotencyKey = `attendance-reminder:${row.eventId}:${row.contactId}:${milestone}`;
    if (!shouldSendAttendanceReminder({ status: row.status, daysUntilDeadline: milestone, alreadySent: false, milestones })) continue;
    const timestamp = now;
    const result = await db.insert(jobs).values({
      id: crypto.randomUUID(),
      kind: ATTENDANCE_REMINDER_JOB_KIND,
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

/**
 * Delivers an attendance reminder the Registration Deadline milestones queued
 * (ADR 0163), on the same terms as a Task reminder.
 *
 * ADR 0030 reminds only those who have not yet answered, so the Attendance
 * Registration is read again here rather than trusted from the payload: the
 * Contact may have answered since it was queued, and reminding somebody to do
 * what they have already done is the failure that rule exists to prevent. The
 * milestone must still be today for the same reason it must be for a Task: rows
 * queued while nothing handled this kind must not arrive as one burst.
 */

import { and, eq } from 'drizzle-orm';

import { channelCredentials, sendOnChannel } from './channel';
import { createRequestContext } from './routes/request-context';
import { attendanceReminderNotice } from './notice';
import { accountDatabase } from './storage/database';
import { attendance, events } from './storage/account-schema';
import type { JobHandler } from './job-dispatch';
import type { Bindings } from './types';

export const ATTENDANCE_REMINDER_JOB_KIND = 'attendance_reminder';

interface AttendanceReminderPayload {
  eventId?: unknown;
  contactId?: unknown;
  channel?: unknown;
  milestone?: unknown;
}

export const attendanceReminderJobHandler = (env: Bindings): JobHandler => async ({ database, accountId, payload, at }) => {
  const reminder = payload as AttendanceReminderPayload;
  if (typeof reminder.eventId !== 'string' || typeof reminder.contactId !== 'string' || typeof reminder.milestone !== 'number') {
    throw new Error('An attendance reminder needs a Scheduled Event, a Contact, and the milestone it was queued for.');
  }
  const db = accountDatabase(database);
  const registration = await db.select({
    status: attendance.status,
    title: events.title,
    deadline: events.attendanceDeadline,
  }).from(attendance)
    .innerJoin(events, eq(events.id, attendance.eventId))
    .where(and(eq(attendance.eventId, reminder.eventId), eq(attendance.contactId, reminder.contactId)))
    .get();
  if (!registration?.deadline) return;
  if (registration.status !== 'unanswered') return;
  if (Math.floor((Date.parse(registration.deadline) - Date.parse(at)) / 86_400_000) !== reminder.milestone) return;
  const accountKey = await createRequestContext(new Request('https://request-context.invalid'), env).accountKey(accountId);
  await sendOnChannel({
    database,
    credentials: await channelCredentials({ database, accountKey, accountId }),
    contactId: reminder.contactId,
    channel: typeof reminder.channel === 'string' && reminder.channel ? reminder.channel : 'line',
    texts: [attendanceReminderNotice({
      title: registration.title,
      deadline: registration.deadline,
      milestone: reminder.milestone,
    })],
  });
};

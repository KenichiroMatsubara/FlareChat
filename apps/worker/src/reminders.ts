/**
 * The Reminder Schedule (ADR 0163, ADR 0164, ADR 0171): every reminder this
 * Account's Reminder Milestones still have ahead of them, the Jobs that carry
 * the due ones, and their delivery through the one Channel seam.
 *
 * A reminder has a subject — a Task, a Registration, or a message an outside
 * agent scheduled for a stated time (ADR 0156) — and the subject is a
 * distinction inside this module: the milestone arithmetic, the "still today"
 * guard that keeps a backlog from arriving as one burst, the key, and the send
 * are written once.
 *
 * A Task or attendance reminder is counted in Asia/Tokyo calendar days and
 * travels in the Morning Notice of the day it falls on (ADR 0176); only a
 * reminder scheduled for a stated time still travels as its own Job.
 */

import {
  DEFAULT_ATTENDANCE_REMINDER_DAYS,
  DEFAULT_TASK_REMINDER_DAYS,
  displayLineDestinationId,
  shouldSendAttendanceReminder,
  shouldSendTaskReminder,
  tokyoDay,
  tokyoDaysBetween,
} from '@mail/domain';
import { and, eq, isNotNull } from 'drizzle-orm';

import { channelCredentials, isChannelName, sendOnChannel } from './channel';
import type { JobHandler } from './job-dispatch';
import { enqueueJob } from './jobs';
import { accountKeyFor } from './keys';
import { attendanceReminderNotice, taskReminderNotice } from './notice';
import type { Providers } from './providers';
import {
  ATTENDANCE_REMINDER_DAYS_SETTING,
  ATTENDANCE_REMINDERS_ENABLED_SETTING,
  TASK_REMINDER_DAYS_SETTING,
  TASK_REMINDERS_ENABLED_SETTING,
  accountReminderDays,
  accountRemindersEnabled,
  saveAccountReminderDays,
  saveAccountRemindersEnabled,
} from './reminder-settings';
import { attendance, contactLineDestinations, contacts, events, lineDestinations, tasks } from './storage/account-schema';
import { accountDatabase, type AccountDatabase } from './storage/database';
import type { Bindings } from './types';

/** The one Job kind every reminder travels as; the payload names its subject. */
export const REMINDER_JOB_KIND = 'reminder';

/** What a reminder is about: the two deadlines the product tracks, or a time somebody outside chose. */
export type ReminderSubject = 'task' | 'registration' | 'scheduled';

export type ReminderPayload =
  | { subject: 'task'; taskId: string; contactId: string; milestone: number }
  | { subject: 'registration'; eventId: string; contactId: string; milestone: number }
  | { subject: 'scheduled'; contactId: string; channel: string; text: string };

/** One reminder this Account's configuration will send, before it is sent. */
export interface ScheduledReminder {
  subject: 'task' | 'registration';
  /** The Task or the Scheduled Event the reminder is about. */
  subjectId: string;
  title: string;
  deadline: string;
  contactId: string;
  contactName: string;
  channel: string;
  destination: string;
  milestone: number;
  sendOn: string;
  text: string;
}

/** The switch and the milestones one subject reminds on; kept apart per subject (ADR 0163, ADR 0164). */
export interface ReminderSettings {
  enabled(): Promise<boolean>;
  saveEnabled(enabled: boolean, updatedAt: string): Promise<void>;
  days(): Promise<readonly number[]>;
  saveDays(days: readonly number[], updatedAt: string): Promise<void>;
}

const SETTING_KEYS = {
  task: { enabled: TASK_REMINDERS_ENABLED_SETTING, days: TASK_REMINDER_DAYS_SETTING, fallback: DEFAULT_TASK_REMINDER_DAYS },
  registration: { enabled: ATTENDANCE_REMINDERS_ENABLED_SETTING, days: ATTENDANCE_REMINDER_DAYS_SETTING, fallback: DEFAULT_ATTENDANCE_REMINDER_DAYS },
} as const;

export const reminderSettings = (database: AccountDatabase, subject: 'task' | 'registration'): ReminderSettings => {
  const keys = SETTING_KEYS[subject];
  return {
    enabled: () => accountRemindersEnabled(database, keys.enabled),
    saveEnabled: (enabled, updatedAt) => saveAccountRemindersEnabled(database, keys.enabled, enabled, updatedAt),
    days: () => accountReminderDays(database, keys.days, keys.fallback),
    saveDays: (days, updatedAt) => saveAccountReminderDays(database, keys.days, days, updatedAt),
  };
};

/** The Asia/Tokyo day `days` whole days after the one `day` names, both as `YYYY-MM-DD`. */
const dayAfter = (day: string, days: number): string =>
  new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Whole Asia/Tokyo calendar days from the day `at` falls on to the deadline's,
 * the same count the milestones are chosen in: a deadline at 03:00 is on the
 * day it names, not on the day before.
 */
export const milestoneAt = (deadline: string, at: string): number =>
  tokyoDaysBetween(Date.parse(at), Date.parse(deadline));

interface TaskCandidate {
  taskId: string;
  contactId: string;
  contactName: string;
  title: string;
  deadline: string;
  sourceMessageSubject: string;
  description: string;
  completed: boolean;
  destination: string;
}

interface RegistrationCandidate {
  eventId: string;
  eventTitle: string;
  contactId: string;
  contactName: string;
  destination: string;
  status: 'unanswered' | 'attending' | 'not_attending';
  attendanceDeadline: string;
}

/** The unfinished, assigned, LINE-reachable Tasks both the queue and the preview read. */
const taskCandidates = async (db: AccountDatabase): Promise<TaskCandidate[]> => await db.select({
  taskId: tasks.id,
  contactId: tasks.assigneeContactId,
  contactName: contacts.name,
  title: tasks.title,
  deadline: tasks.deadline,
  sourceMessageSubject: tasks.sourceMessageSubject,
  description: tasks.description,
  completed: tasks.completed,
  destination: lineDestinations.destinationId,
}).from(tasks)
  .innerJoin(contacts, eq(contacts.id, tasks.assigneeContactId))
  .innerJoin(contactLineDestinations, eq(contactLineDestinations.contactId, contacts.id))
  .innerJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
  .where(and(isNotNull(tasks.assigneeContactId), eq(tasks.completed, false)))
  .all() as TaskCandidate[];

/** The LINE-reachable Registrations both the queue and the preview read; answered ones are filtered by the caller. */
const registrationCandidates = async (db: AccountDatabase): Promise<RegistrationCandidate[]> => await db.select({
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
  .all() as RegistrationCandidate[];

const taskText = (candidate: Pick<TaskCandidate, 'title' | 'deadline' | 'sourceMessageSubject' | 'description'>, milestone: number): string =>
  taskReminderNotice({
    title: candidate.title,
    deadline: candidate.deadline,
    milestone,
    sourceMessageSubject: candidate.sourceMessageSubject,
    description: candidate.description,
  });

/**
 * Every reminder still ahead of this Account, composed exactly as it will be
 * delivered, whether or not the switch is on: deciding to turn reminders on is
 * exactly when somebody needs to see what turning them on would send. The
 * reminders already past are left out; the Delivery Records hold what happened.
 */
export const upcomingReminders = async (
  database: D1Database,
  now: string,
  subject?: 'task' | 'registration',
): Promise<ScheduledReminder[]> => {
  const db = accountDatabase(database);
  const today = tokyoDay(Date.parse(now));
  const scheduled: ScheduledReminder[] = [];
  const milestonesAhead = (deadline: string, milestones: readonly number[]): Array<{ milestone: number; sendOn: string }> =>
    milestones.flatMap((milestone) => {
      const sendOn = dayAfter(tokyoDay(Date.parse(deadline)), -milestone);
      return sendOn < today ? [] : [{ milestone, sendOn }];
    });
  if (subject !== 'registration') {
    const milestones = await reminderSettings(db, 'task').days();
    for (const row of milestones.length ? await taskCandidates(db) : []) {
      for (const { milestone, sendOn } of milestonesAhead(row.deadline, milestones)) {
        scheduled.push({
          subject: 'task',
          subjectId: row.taskId,
          title: row.title,
          deadline: row.deadline,
          contactId: row.contactId,
          contactName: row.contactName,
          channel: 'line',
          destination: displayLineDestinationId(row.destination),
          milestone,
          sendOn,
          text: taskText(row, milestone),
        });
      }
    }
  }
  if (subject !== 'task') {
    const milestones = await reminderSettings(db, 'registration').days();
    for (const row of milestones.length ? await registrationCandidates(db) : []) {
      if (row.status !== 'unanswered') continue;
      for (const { milestone, sendOn } of milestonesAhead(row.attendanceDeadline, milestones)) {
        scheduled.push({
          subject: 'registration',
          subjectId: row.eventId,
          title: row.eventTitle,
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
  }
  return scheduled.sort((left, right) => left.sendOn.localeCompare(right.sendOn) || left.title.localeCompare(right.title));
};

/** The key a reminder is kept under, as a Job or a Morning Entry; the same milestone keeps the same key in both. */
export const reminderKey = (payload: ReminderPayload, at: string): string => {
  switch (payload.subject) {
    case 'task':
      return `reminder:task:${payload.taskId}:${payload.contactId}:${payload.milestone}`;
    case 'registration':
      return `reminder:registration:${payload.eventId}:${payload.contactId}:${payload.milestone}`;
    case 'scheduled':
      return `reminder:scheduled:${payload.contactId}:${at}:${payload.text}`;
  }
};

const enqueueReminder = async (database: D1Database, payload: ReminderPayload, availableAt: string): Promise<boolean> => {
  const job = await enqueueJob(database, {
    kind: REMINDER_JOB_KIND,
    payload: { ...payload },
    idempotencyKey: reminderKey(payload, availableAt),
    availableAt,
  });
  return job.created;
};

/** One Task or attendance reminder due today, addressed and worded as it will arrive. */
export interface DueReminder {
  /** Names the subject, the thing, the Contact, and the milestone, so each milestone is kept once (ADR 0171). */
  key: string;
  contactId: string;
  /** The LINE destination the Contact is reachable at. */
  destination: string;
  text: string;
}

/**
 * The reminders due on the Asia/Tokyo day `at` falls on, one per subject and
 * milestone, addressed to the one Contact it concerns. ADR 0030 reminds only
 * those who have not yet acted, so a completed Task, an unassigned one, and an
 * answered Registration produce nothing; a switch that is off produces nothing
 * either. The Morning Notice keeps each under its key, so reading this twice
 * on one day sends nothing twice (ADR 0176).
 */
export const dueReminders = async (database: D1Database, at: string): Promise<DueReminder[]> => {
  const db = accountDatabase(database);
  const due: DueReminder[] = [];
  const taskSettings = reminderSettings(db, 'task');
  if (await taskSettings.enabled()) {
    const milestones = await taskSettings.days();
    for (const row of milestones.length ? await taskCandidates(db) : []) {
      const milestone = milestoneAt(row.deadline, at);
      if (!shouldSendTaskReminder({ completed: row.completed, assigned: true, daysUntilDeadline: milestone, milestones })) continue;
      due.push({
        key: reminderKey({ subject: 'task', taskId: row.taskId, contactId: row.contactId, milestone }, at),
        contactId: row.contactId,
        destination: row.destination,
        text: taskText(row, milestone),
      });
    }
  }
  const registrationSettings = reminderSettings(db, 'registration');
  if (await registrationSettings.enabled()) {
    const milestones = await registrationSettings.days();
    for (const row of milestones.length ? await registrationCandidates(db) : []) {
      const milestone = milestoneAt(row.attendanceDeadline, at);
      if (!shouldSendAttendanceReminder({ status: row.status, daysUntilDeadline: milestone, alreadySent: false, milestones })) continue;
      due.push({
        key: reminderKey({ subject: 'registration', eventId: row.eventId, contactId: row.contactId, milestone }, at),
        contactId: row.contactId,
        destination: row.destination,
        text: attendanceReminderNotice({ title: row.eventTitle, deadline: row.attendanceDeadline, milestone }),
      });
    }
  }
  return due;
};

/** Records a reminder an outside agent scheduled for a stated time (ADR 0156); the Job row is the whole promise. */
export const scheduleReminder = async (
  database: D1Database,
  input: { contactId: string; channel: string; text: string; at: string },
): Promise<{ scheduled: true; at: string; contactId: string }> => {
  if (!isChannelName(input.channel)) throw new Error(`This server does not reach a Contact on ${input.channel} yet.`);
  await enqueueReminder(database, { subject: 'scheduled', contactId: input.contactId, channel: input.channel, text: input.text }, input.at);
  return { scheduled: true, at: input.at, contactId: input.contactId };
};

const readPayload = (payload: Record<string, unknown>): ReminderPayload => {
  const contactId = typeof payload.contactId === 'string' ? payload.contactId : null;
  switch (payload.subject) {
    case 'task':
      if (typeof payload.taskId !== 'string' || !contactId || typeof payload.milestone !== 'number') {
        throw new Error('A Task reminder needs a Task, a Contact, and the milestone it was queued for.');
      }
      return { subject: 'task', taskId: payload.taskId, contactId, milestone: payload.milestone };
    case 'registration':
      if (typeof payload.eventId !== 'string' || !contactId || typeof payload.milestone !== 'number') {
        throw new Error('An attendance reminder needs a Scheduled Event, a Contact, and the milestone it was queued for.');
      }
      return { subject: 'registration', eventId: payload.eventId, contactId, milestone: payload.milestone };
    default:
      if (!contactId || typeof payload.text !== 'string') throw new Error('A scheduled reminder needs a Contact and something to say.');
      return { subject: 'scheduled', contactId, channel: typeof payload.channel === 'string' ? payload.channel : '', text: payload.text };
  }
};

/**
 * What one queued reminder should say now, or nothing. The subject is read back
 * rather than trusted from the payload: the Task may have been completed or
 * handed to somebody else, the Registration answered, since it was queued. The
 * milestone must still be today, so rows queued long ago never arrive as one
 * burst the day something first delivers them.
 */
const reminderText = async (database: D1Database, payload: ReminderPayload, at: string): Promise<string | null> => {
  const db = accountDatabase(database);
  switch (payload.subject) {
    case 'scheduled':
      return payload.text;
    case 'task': {
      const task = await db.select({
        title: tasks.title,
        deadline: tasks.deadline,
        sourceMessageSubject: tasks.sourceMessageSubject,
        description: tasks.description,
        completed: tasks.completed,
        assigneeContactId: tasks.assigneeContactId,
      }).from(tasks).where(eq(tasks.id, payload.taskId)).get();
      if (!task || task.completed || task.assigneeContactId !== payload.contactId) return null;
      if (milestoneAt(task.deadline, at) !== payload.milestone) return null;
      return taskText(task, payload.milestone);
    }
    case 'registration': {
      const registration = await db.select({
        status: attendance.status,
        title: events.title,
        deadline: events.attendanceDeadline,
      }).from(attendance)
        .innerJoin(events, eq(events.id, attendance.eventId))
        .where(and(eq(attendance.eventId, payload.eventId), eq(attendance.contactId, payload.contactId)))
        .get();
      if (!registration?.deadline || registration.status !== 'unanswered') return null;
      if (milestoneAt(registration.deadline, at) !== payload.milestone) return null;
      return attendanceReminderNotice({ title: registration.title, deadline: registration.deadline, milestone: payload.milestone });
    }
  }
};

/** Delivers one queued reminder through the one Channel seam (ADR 0158), exactly as an immediate message goes. */
export const reminderJobHandler = (env: Bindings, providers: Providers): JobHandler => async ({ database, accountId, payload, at }) => {
  const reminder = readPayload(payload);
  const text = await reminderText(database, reminder, at);
  if (text === null) return;
  const accountKey = await accountKeyFor(env, accountId);
  await sendOnChannel({
    database,
    credentials: await channelCredentials({ database, accountKey, accountId }),
    contactId: reminder.contactId,
    channel: reminder.subject === 'scheduled' ? reminder.channel : 'line',
    texts: [text],
    fetch: providers.fetch,
  });
};

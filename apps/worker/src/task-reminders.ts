import {
  DEFAULT_TASK_REMINDER_DAYS,
  displayLineDestinationId,
  readTaskReminderDays,
  shouldSendTaskReminder,
  writeTaskReminderDays,
} from '@mail/domain';

import { taskReminderNotice } from './notice';
import { TASK_REMINDERS_ENABLED_SETTING, accountRemindersEnabled, saveAccountRemindersEnabled } from './reminder-switch';
import { and, eq, isNotNull } from 'drizzle-orm';

import { createDatabaseAccess } from './database-access';
import { TASK_REMINDER_JOB_KIND } from './task-reminder-job';
import { accounts } from './storage/control-schema';
import { controlDatabase, accountDatabase as drizzleAccountDatabase } from './storage/database';
import { jobs, lineDestinations, contactLineDestinations, contacts, settings, tasks } from './storage/account-schema';
import type { AccountDatabase } from './storage/database';
import type { Bindings } from './types';

export const TASK_REMINDER_DAYS_SETTING = 'task_reminder_days';

export const accountTaskRemindersEnabled = (database: AccountDatabase): Promise<boolean> =>
  accountRemindersEnabled(database, TASK_REMINDERS_ENABLED_SETTING);

export const saveAccountTaskRemindersEnabled = (
  database: AccountDatabase,
  enabled: boolean,
  updatedAt: string,
): Promise<void> => saveAccountRemindersEnabled(database, TASK_REMINDERS_ENABLED_SETTING, enabled, updatedAt);

/**
 * The milestones this Account reminds on, falling back to the product default.
 * A stored value that no longer reads as a milestone list is treated as absent
 * rather than as "remind never", because silence is the one outcome an operator
 * would not be able to tell apart from the feature working.
 */
export const accountTaskReminderDays = async (database: AccountDatabase): Promise<readonly number[]> => {
  const stored = await database.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, TASK_REMINDER_DAYS_SETTING)).get();
  if (stored === undefined) return DEFAULT_TASK_REMINDER_DAYS;
  const read = readTaskReminderDays(stored.value);
  return read.accepted ? read.days : DEFAULT_TASK_REMINDER_DAYS;
};

export const saveAccountTaskReminderDays = async (
  database: AccountDatabase,
  days: readonly number[],
  updatedAt: string,
): Promise<void> => {
  const value = writeTaskReminderDays(days);
  await database.insert(settings).values({ key: TASK_REMINDER_DAYS_SETTING, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
};

interface TaskReminderCandidate {
  taskId: string;
  contactId: string;
  contactName: string;
  title: string;
  deadline: string;
  completed: boolean;
  destination: string;
}

/** One reminder this Account's configuration will send, before it is sent. */
export interface ScheduledTaskReminder {
  taskId: string;
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

const day = (instant: number): string => new Date(instant).toISOString().slice(0, 10);

/**
 * Every reminder still ahead of this Account, composed exactly as it will be
 * delivered. ADR 0163 lets an Account choose milestones it cannot otherwise
 * observe: a cadence that is only a list of numbers is not something an operator
 * can check, so the same rule that decides a send also answers what is coming.
 *
 * The reminders already past are left out. They are history, and the Delivery
 * Records hold what actually happened to them.
 */
export const upcomingTaskReminders = async (
  database: D1Database,
  now: string,
): Promise<ScheduledTaskReminder[]> => {
  const db = drizzleAccountDatabase(database);
  const milestones = await accountTaskReminderDays(db);
  if (milestones.length === 0) return [];
  const rows = await taskReminderCandidates(db);
  const today = day(Date.parse(now));
  const scheduled: ScheduledTaskReminder[] = [];
  for (const row of rows) {
    for (const milestone of milestones) {
      const sendOn = day(Date.parse(row.deadline) - milestone * 86_400_000);
      if (sendOn < today) continue;
      scheduled.push({
        taskId: row.taskId,
        title: row.title,
        deadline: row.deadline,
        contactId: row.contactId,
        contactName: row.contactName,
        channel: 'line',
        destination: displayLineDestinationId(row.destination),
        milestone,
        sendOn,
        text: taskReminderNotice({ title: row.title, deadline: row.deadline, milestone }),
      });
    }
  }
  return scheduled.sort((left, right) => left.sendOn.localeCompare(right.sendOn) || left.title.localeCompare(right.title));
};

/** The unfinished, assigned, LINE-reachable Tasks both the queue and the preview read. */
const taskReminderCandidates = async (db: AccountDatabase): Promise<TaskReminderCandidate[]> => await db.select({
  taskId: tasks.id,
  contactId: tasks.assigneeContactId,
  contactName: contacts.name,
  title: tasks.title,
  deadline: tasks.deadline,
  completed: tasks.completed,
  destination: lineDestinations.destinationId,
}).from(tasks)
  .innerJoin(contacts, eq(contacts.id, tasks.assigneeContactId))
  .innerJoin(contactLineDestinations, eq(contactLineDestinations.contactId, contacts.id))
  .innerJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
  .where(and(isNotNull(tasks.assigneeContactId), eq(tasks.completed, false)))
  .all() as TaskReminderCandidate[];

/**
 * Queues one durable reminder per unfinished Task and milestone, addressed to
 * its assignee alone. ADR 0030 reminds only those who have not yet acted, so a
 * completed Task and an unassigned one produce nothing.
 */
export const enqueueDueTaskReminders = async (database: D1Database, now: string): Promise<number> => {
  const db = drizzleAccountDatabase(database);
  if (!await accountTaskRemindersEnabled(db)) return 0;
  const milestones = await accountTaskReminderDays(db);
  if (milestones.length === 0) return 0;
  const rows = await taskReminderCandidates(db);
  let queued = 0;
  for (const row of rows) {
    const milestone = Math.floor((Date.parse(row.deadline) - Date.parse(now)) / 86_400_000);
    if (!shouldSendTaskReminder({ completed: row.completed, assigned: true, daysUntilDeadline: milestone, milestones })) continue;
    const result = await db.insert(jobs).values({
      id: crypto.randomUUID(),
      kind: TASK_REMINDER_JOB_KIND,
      payload: JSON.stringify({ taskId: row.taskId, contactId: row.contactId, title: row.title, destination: row.destination, milestone }),
      state: 'pending',
      attempts: 0,
      availableAt: now,
      idempotencyKey: `task-reminder:${row.taskId}:${milestone}`,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();
    queued += result.meta.changes;
  }
  return queued;
};

/** Scans all active Account databases, like the attendance reminders beside it. */
export const enqueueDueAccountTaskReminders = async (env: Bindings, now: string): Promise<number> => {
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
    queued += await enqueueDueTaskReminders(database.raw, now);
  }
  return queued;
};

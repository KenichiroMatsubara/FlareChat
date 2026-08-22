/**
 * Delivers a Task reminder the deadline milestones queued (ADR 0163).
 *
 * Nothing handled this Job kind before, so every Account carries rows queued on
 * milestones that have long passed. A reminder that waited is not a reminder,
 * and that backlog must not arrive as one burst the first time this runs, so a
 * Job is delivered only while the milestone it names is still the milestone
 * today. ADR 0030 reminds only those who have not yet acted, so the Task is read
 * again here rather than trusted from the payload: it may have been completed or
 * handed to somebody else since it was queued.
 */

import { eq } from 'drizzle-orm';

import { channelCredentials, sendOnChannel } from './channel';
import { createRequestContext } from './routes/request-context';
import { taskReminderNotice } from './notice';
import { accountDatabase } from './storage/database';
import { tasks } from './storage/account-schema';
import type { JobHandler } from './job-dispatch';
import type { Bindings } from './types';

export const TASK_REMINDER_JOB_KIND = 'task_reminder';

interface TaskReminderPayload {
  taskId?: unknown;
  contactId?: unknown;
  channel?: unknown;
  milestone?: unknown;
}

/** Whole days from `at` to the deadline, the same count the milestones are chosen in. */
export const milestoneAt = (deadline: string, at: string): number =>
  Math.floor((Date.parse(deadline) - Date.parse(at)) / 86_400_000);

export const taskReminderJobHandler = (env: Bindings): JobHandler => async ({ database, accountId, payload, at }) => {
  const reminder = payload as TaskReminderPayload;
  if (typeof reminder.taskId !== 'string' || typeof reminder.contactId !== 'string' || typeof reminder.milestone !== 'number') {
    throw new Error('A Task reminder needs a Task, a Contact, and the milestone it was queued for.');
  }
  const task = await accountDatabase(database).select({
    title: tasks.title,
    deadline: tasks.deadline,
    completed: tasks.completed,
    assigneeContactId: tasks.assigneeContactId,
  }).from(tasks).where(eq(tasks.id, reminder.taskId)).get();
  if (!task) return;
  if (task.completed || task.assigneeContactId !== reminder.contactId) return;
  if (milestoneAt(task.deadline, at) !== reminder.milestone) return;
  const accountKey = await createRequestContext(new Request('https://request-context.invalid'), env).accountKey(accountId);
  await sendOnChannel({
    database,
    credentials: await channelCredentials({ database, accountKey, accountId }),
    contactId: reminder.contactId,
    channel: typeof reminder.channel === 'string' && reminder.channel ? reminder.channel : 'line',
    texts: [taskReminderNotice({ title: task.title, deadline: task.deadline, milestone: reminder.milestone })],
  });
};

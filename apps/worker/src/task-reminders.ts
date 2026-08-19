import { shouldSendTaskReminder } from '@mail/domain';
import { and, eq, isNotNull } from 'drizzle-orm';

import { createDatabaseAccess } from './database-access';
import { accounts } from './storage/control-schema';
import { controlDatabase, accountDatabase as drizzleAccountDatabase } from './storage/database';
import { jobs, lineDestinations, contactLineDestinations, contacts, tasks } from './storage/account-schema';
import type { Bindings } from './types';

interface TaskReminderCandidate {
  taskId: string;
  contactId: string;
  title: string;
  deadline: string;
  completed: boolean;
  destination: string;
}

/**
 * Queues one durable reminder per unfinished Task and milestone, addressed to
 * its assignee alone. ADR 0030 reminds only those who have not yet acted, so a
 * completed Task and an unassigned one produce nothing.
 */
export const enqueueDueTaskReminders = async (database: D1Database, now: string): Promise<number> => {
  const db = drizzleAccountDatabase(database);
  const rows: TaskReminderCandidate[] = await db.select({
    taskId: tasks.id,
    contactId: tasks.assigneeContactId,
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
  let queued = 0;
  for (const row of rows) {
    const milestone = Math.floor((Date.parse(row.deadline) - Date.parse(now)) / 86_400_000);
    if (!shouldSendTaskReminder({ completed: row.completed, assigned: true, daysUntilDeadline: milestone })) continue;
    const result = await db.insert(jobs).values({
      id: crypto.randomUUID(),
      kind: 'task_reminder',
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

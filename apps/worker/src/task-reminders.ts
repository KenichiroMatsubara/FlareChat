import { shouldSendTaskReminder } from '@mail/domain';
import { and, eq, isNotNull } from 'drizzle-orm';

import { createDatabaseAccess } from './database-access';
import { organizations } from './storage/control-schema';
import { controlDatabase, organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { jobs, lineDestinations, memberLineDestinations, members, tasks } from './storage/organization-schema';
import type { Bindings } from './types';

interface TaskReminderCandidate {
  taskId: string;
  memberId: string;
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
  const db = drizzleOrganizationDatabase(database);
  const rows: TaskReminderCandidate[] = await db.select({
    taskId: tasks.id,
    memberId: tasks.assigneeMemberId,
    title: tasks.title,
    deadline: tasks.deadline,
    completed: tasks.completed,
    destination: lineDestinations.destinationId,
  }).from(tasks)
    .innerJoin(members, eq(members.id, tasks.assigneeMemberId))
    .innerJoin(memberLineDestinations, eq(memberLineDestinations.memberId, members.id))
    .innerJoin(lineDestinations, eq(lineDestinations.id, memberLineDestinations.lineDestinationId))
    .where(and(isNotNull(tasks.assigneeMemberId), eq(tasks.completed, false)))
    .all() as TaskReminderCandidate[];
  let queued = 0;
  for (const row of rows) {
    const milestone = Math.floor((Date.parse(row.deadline) - Date.parse(now)) / 86_400_000);
    if (!shouldSendTaskReminder({ completed: row.completed, assigned: true, daysUntilDeadline: milestone })) continue;
    const result = await db.insert(jobs).values({
      id: crypto.randomUUID(),
      kind: 'task_reminder',
      payload: JSON.stringify({ taskId: row.taskId, memberId: row.memberId, title: row.title, destination: row.destination, milestone }),
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

/** Scans all active Organization databases, like the attendance reminders beside it. */
export const enqueueDueOrganizationTaskReminders = async (env: Bindings, now: string): Promise<number> => {
  const activeOrganizations = await controlDatabase(env.CONTROL_DB).select({
    bindingName: organizations.bindingName,
    databaseId: organizations.databaseId,
  }).from(organizations).where(and(eq(organizations.status, 'active'), isNotNull(organizations.databaseId))).all();
  let queued = 0;
  const databases = createDatabaseAccess(env);
  for (const organization of activeOrganizations) {
    const database = await databases.open({
      kind: 'organization',
      bindingName: organization.bindingName,
      databaseId: organization.databaseId,
    });
    queued += await enqueueDueTaskReminders(database.raw, now);
  }
  return queued;
};

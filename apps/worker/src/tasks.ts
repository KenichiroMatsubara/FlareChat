import { and, asc, eq } from 'drizzle-orm';

import { UNASSIGNED_ASSIGNEE, type TaskDetails } from './event-details';
import type { AccountDatabase } from './storage/database';
import { contacts, tasks } from './storage/account-schema';

/** What a Task's assignee reads as until somebody is named. */
export const UNASSIGNED_TASK_ASSIGNEE = '未割り当て';

export interface TaskView {
  id: string;
  title: string;
  deadline: string;
  assigneeContactId: string | null;
  assigneeName: string;
  sourceMessageSubject: string;
  description: string;
  remarks: string;
  completed: boolean;
  completedAt: string | null;
}

const timestamp = (): string => new Date().toISOString();

/**
 * Tasks, assigned to the Contact the extraction named (ADR 0161).
 *
 * The name is copied onto the Task when it is created, so a Task keeps saying
 * who it was given to even after that Contact is renamed or removed.
 */
export const createTaskWorkflow = (database: AccountDatabase) => ({
  async createFromSourceMessage(input: {
    accountId: string;
    sourceMessageId: string;
    sourceMessageSubject: string;
    extractedTasks: TaskDetails[];
  }): Promise<void> {
    const roster = await database.select({ id: contacts.id, name: contacts.name }).from(contacts).all();
    const nameById = new Map(roster.map((contact) => [contact.id, contact.name]));
    for (const extracted of input.extractedTasks) {
      const assigneeName = nameById.get(extracted.assigneeContactId);
      const now = timestamp();
      await database.insert(tasks).values({
        id: crypto.randomUUID(),
        accountId: input.accountId,
        sourceMessageId: input.sourceMessageId,
        sourceMessageSubject: input.sourceMessageSubject,
        title: extracted.title,
        deadline: extracted.deadline,
        assigneeContactId: assigneeName === undefined ? null : extracted.assigneeContactId,
        assigneeName: assigneeName ?? UNASSIGNED_TASK_ASSIGNEE,
        description: extracted.description,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
    }
  },

  /** Moves one Task onto a Contact, or off every Contact when none is named. */
  async assign(taskId: string, contactId: string | null): Promise<TaskView | null> {
    const contact = contactId
      ? await database.select({ id: contacts.id, name: contacts.name }).from(contacts).where(eq(contacts.id, contactId)).get()
      : null;
    if (contactId && !contact) return null;
    return await database.update(tasks).set({
      assigneeContactId: contact?.id ?? null,
      assigneeName: contact?.name ?? UNASSIGNED_TASK_ASSIGNEE,
      updatedAt: timestamp(),
    }).where(eq(tasks.id, taskId)).returning().get() ?? null;
  },

  async list(input: { assigneeContactId?: string; unassigned?: boolean; event?: string; completed?: boolean } = {}): Promise<TaskView[]> {
    const conditions = [
      input.unassigned ? eq(tasks.assigneeName, UNASSIGNED_TASK_ASSIGNEE) : input.assigneeContactId ? eq(tasks.assigneeContactId, input.assigneeContactId) : undefined,
      input.event ? eq(tasks.sourceMessageSubject, input.event) : undefined,
      input.completed === undefined ? undefined : eq(tasks.completed, input.completed),
    ].filter((value): value is NonNullable<typeof value> => Boolean(value));
    return await database.select().from(tasks).where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(tasks.completed), asc(tasks.deadline), asc(tasks.createdAt)).all();
  },

  async update(id: string, input: { completed?: boolean; remarks?: string }): Promise<TaskView | null> {
    if (input.completed === undefined && input.remarks === undefined) return null;
    const now = timestamp();
    const values: Partial<typeof tasks.$inferInsert> = { updatedAt: now };
    if (input.completed !== undefined) {
      values.completed = input.completed;
      values.completedAt = input.completed ? now : null;
    }
    if (input.remarks !== undefined) values.remarks = input.remarks;
    return await database.update(tasks).set(values).where(eq(tasks.id, id)).returning().get() ?? null;
  },
});

export { UNASSIGNED_ASSIGNEE };

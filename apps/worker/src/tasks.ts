import { and, asc, eq } from 'drizzle-orm';

import { UNASSIGNED_ASSIGNEE, type TaskDetails } from './event-details';
import type { AccountDatabase } from './storage/database';
import { contacts, events, tasks } from './storage/account-schema';

/** What a Task's assignee reads as until somebody is named. */
export const UNASSIGNED_TASK_ASSIGNEE = '未割り当て';

export interface TaskView {
  id: string;
  title: string;
  deadline: string;
  assigneeContactId: string | null;
  assigneeName: string;
  sourceMessageSubject: string;
  scheduledEventId: string | null;
  scheduledEventTitle: string | null;
  description: string;
  remarks: string;
  completed: boolean;
  completedAt: string | null;
}

const timestamp = (): string => new Date().toISOString();

/**
 * Tasks created by an Account or Agent Rule (ADR 0161, ADR 0175).
 *
 * The assignee name is copied onto the Task, so it keeps saying who it was
 * given to even after that Contact is renamed or removed.
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

  /** Creates one Task from an Agent Rule, with the current Source Message as provenance. */
  async createFromAgent(input: {
    accountId: string;
    sourceMessageId: string;
    sourceMessageSubject: string;
    title: string;
    deadline: string;
    description: string;
    assigneeContactId?: string | null;
    scheduledEventId?: string | null;
  }): Promise<TaskView> {
    const existing = await database.select().from(tasks).where(and(
      eq(tasks.sourceMessageId, input.sourceMessageId),
      eq(tasks.deadline, input.deadline),
      eq(tasks.title, input.title),
    )).get();
    if (existing) return existing;
    const contact = input.assigneeContactId
      ? await database.select({ id: contacts.id, name: contacts.name }).from(contacts)
        .where(eq(contacts.id, input.assigneeContactId)).get()
      : null;
    if (input.assigneeContactId && !contact) throw new Error('The Task assignee is not a Contact in this Account.');
    const event = input.scheduledEventId
      ? await database.select({ id: events.id, title: events.title }).from(events)
        .where(and(eq(events.id, input.scheduledEventId), eq(events.accountId, input.accountId))).get()
      : null;
    if (input.scheduledEventId && !event) throw new Error('The Task Scheduled Event is not in this Account.');
    const createdAt = timestamp();
    await database.insert(tasks).values({
      id: crypto.randomUUID(),
      accountId: input.accountId,
      sourceMessageId: input.sourceMessageId,
      sourceMessageSubject: input.sourceMessageSubject,
      scheduledEventId: event?.id ?? null,
      scheduledEventTitle: event?.title ?? null,
      title: input.title,
      deadline: input.deadline,
      assigneeContactId: contact?.id ?? null,
      assigneeName: contact?.name ?? UNASSIGNED_TASK_ASSIGNEE,
      description: input.description,
      createdAt,
      updatedAt: createdAt,
    }).onConflictDoNothing().run();
    const created = await database.select().from(tasks).where(and(
      eq(tasks.sourceMessageId, input.sourceMessageId),
      eq(tasks.deadline, input.deadline),
      eq(tasks.title, input.title),
    )).get();
    if (!created) throw new Error('The Task could not be created.');
    return created;
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

  /** Lets an Agent update an existing Task rather than creating a duplicate. */
  async updateFromAgent(accountId: string, taskId: string, input: {
    title?: string;
    deadline?: string;
    description?: string;
    completed?: boolean;
    assigneeContactId?: string | null;
    scheduledEventId?: string | null;
  }): Promise<TaskView | null> {
    const values: Partial<typeof tasks.$inferInsert> = { updatedAt: timestamp() };
    if (input.assigneeContactId !== undefined) {
      const contact = input.assigneeContactId
        ? await database.select({ id: contacts.id, name: contacts.name }).from(contacts).where(eq(contacts.id, input.assigneeContactId)).get()
        : null;
      if (input.assigneeContactId && !contact) throw new Error('The Task assignee is not a Contact in this Account.');
      values.assigneeContactId = contact?.id ?? null;
      values.assigneeName = contact?.name ?? UNASSIGNED_TASK_ASSIGNEE;
    }
    if (input.scheduledEventId !== undefined) {
      const event = input.scheduledEventId
        ? await database.select({ id: events.id, title: events.title }).from(events)
          .where(and(eq(events.id, input.scheduledEventId), eq(events.accountId, accountId))).get()
        : null;
      if (input.scheduledEventId && !event) throw new Error('The Task Scheduled Event is not in this Account.');
      values.scheduledEventId = event?.id ?? null;
      values.scheduledEventTitle = event?.title ?? null;
    }
    if (input.title !== undefined) values.title = input.title;
    if (input.deadline !== undefined) values.deadline = input.deadline;
    if (input.description !== undefined) values.description = input.description;
    if (input.completed !== undefined) {
      values.completed = input.completed;
      values.completedAt = input.completed ? timestamp() : null;
    }
    if (Object.keys(values).length === 1) return null;
    return await database.update(tasks).set(values).where(and(eq(tasks.id, taskId), eq(tasks.accountId, accountId))).returning().get() ?? null;
  },

  async list(input: { assigneeContactId?: string; unassigned?: boolean; event?: string; completed?: boolean } = {}): Promise<TaskView[]> {
    const conditions = [
      input.unassigned ? eq(tasks.assigneeName, UNASSIGNED_TASK_ASSIGNEE) : input.assigneeContactId ? eq(tasks.assigneeContactId, input.assigneeContactId) : undefined,
      input.event ? eq(tasks.scheduledEventTitle, input.event) : undefined,
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

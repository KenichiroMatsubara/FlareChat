import { and, asc, eq } from 'drizzle-orm';

import type { TaskDetails } from './event-details';
import type { OrganizationDatabase } from './storage/database';
import { taskRoleAssignments, tasks } from './storage/organization-schema';

export type OperationalTaskRole = 'organizer' | 'treasurer';

export interface TaskView {
  id: string;
  title: string;
  deadline: string;
  assigneeRole: OperationalTaskRole;
  assigneeIdentityId: string | null;
  assigneeName: string;
  sourceMessageSubject: string;
  description: string;
  remarks: string;
  completed: boolean;
  completedAt: string | null;
}

const timestamp = (): string => new Date().toISOString();

export const createTaskWorkflow = (database: OrganizationDatabase) => ({
  async assignRole(input: { role: OperationalTaskRole; identityId: string; displayName: string }): Promise<void> {
    const now = timestamp();
    await database.insert(taskRoleAssignments).values({ ...input, assignedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: taskRoleAssignments.role, set: { identityId: input.identityId, displayName: input.displayName, updatedAt: now } }).run();
  },

  async createFromSourceMessage(input: { organizationId: string; sourceMessageId: string; sourceMessageSubject: string; extractedTasks: TaskDetails[] }): Promise<void> {
    const assignments = await database.select().from(taskRoleAssignments).all();
    const assigneeByRole = new Map(assignments.map((assignment) => [assignment.role, assignment]));
    for (const extracted of input.extractedTasks) {
      const assignment = assigneeByRole.get(extracted.assigneeRole);
      const now = timestamp();
      await database.insert(tasks).values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        sourceMessageId: input.sourceMessageId,
        sourceMessageSubject: input.sourceMessageSubject,
        title: extracted.title,
        deadline: extracted.deadline,
        assigneeRole: extracted.assigneeRole,
        assigneeIdentityId: assignment?.identityId ?? null,
        assigneeName: assignment?.displayName ?? '未割り当て',
        description: extracted.description,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
    }
  },

  async list(input: { assigneeIdentityId?: string; event?: string } = {}): Promise<TaskView[]> {
    const conditions = [input.assigneeIdentityId ? eq(tasks.assigneeIdentityId, input.assigneeIdentityId) : undefined,
      input.event ? eq(tasks.sourceMessageSubject, input.event) : undefined].filter((value): value is NonNullable<typeof value> => Boolean(value));
    const rows = await database.select().from(tasks).where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(tasks.completed), asc(tasks.deadline), asc(tasks.createdAt)).all();
    return rows;
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
    return await database.update(tasks).set(values).where(eq(tasks.id, id)).returning().get();
  },
});

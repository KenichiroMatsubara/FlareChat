import { and, asc, eq } from 'drizzle-orm';

import type { TaskDetails } from './event-details';
import type { OrganizationDatabase } from './storage/database';
import { operationalTaskRoles, taskRoleAssignments, tasks } from './storage/organization-schema';

export const UNASSIGNED_TASK_ROLE = {
  id: 'unassigned',
  displayName: '未割り当て',
  description: '定義済みの担当に当てはまらない、または担当が決まっていないタスク',
} as const;

export interface OperationalTaskRole {
  id: string;
  displayName: string;
  description: string;
}

export interface TaskView {
  id: string;
  title: string;
  deadline: string;
  assigneeRoleId: string;
  assigneeRoleName: string;
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
  async listRoles(): Promise<OperationalTaskRole[]> {
    return database.select({
      id: operationalTaskRoles.id,
      displayName: operationalTaskRoles.displayName,
      description: operationalTaskRoles.description,
    }).from(operationalTaskRoles).orderBy(asc(operationalTaskRoles.displayName)).all();
  },

  async createRole(input: { displayName: string; description: string }): Promise<OperationalTaskRole> {
    const id = crypto.randomUUID();
    const now = timestamp();
    const role = { id, displayName: input.displayName, description: input.description };
    await database.insert(operationalTaskRoles).values({ ...role, createdAt: now, updatedAt: now }).run();
    return role;
  },

  async updateRole(id: string, input: { displayName?: string; description?: string }): Promise<OperationalTaskRole | null> {
    if (input.displayName === undefined && input.description === undefined) return null;
    return await database.update(operationalTaskRoles).set({ ...input, updatedAt: timestamp() })
      .where(eq(operationalTaskRoles.id, id)).returning({
        id: operationalTaskRoles.id,
        displayName: operationalTaskRoles.displayName,
        description: operationalTaskRoles.description,
      }).get();
  },

  async deleteRole(id: string): Promise<boolean> {
    const deleted = await database.delete(operationalTaskRoles).where(eq(operationalTaskRoles.id, id))
      .returning({ id: operationalTaskRoles.id }).get();
    return Boolean(deleted);
  },

  async assignRole(input: { roleId: string; identityId: string; displayName: string }): Promise<void> {
    const now = timestamp();
    await database.insert(taskRoleAssignments).values({ ...input, assignedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: taskRoleAssignments.roleId, set: { identityId: input.identityId, displayName: input.displayName, updatedAt: now } }).run();
  },

  async createFromSourceMessage(input: { organizationId: string; sourceMessageId: string; sourceMessageSubject: string; extractedTasks: TaskDetails[] }): Promise<void> {
    const [roles, assignments] = await Promise.all([
      database.select().from(operationalTaskRoles).all(),
      database.select().from(taskRoleAssignments).all(),
    ]);
    const roleById = new Map(roles.map((role) => [role.id, role]));
    const assigneeByRole = new Map(assignments.map((assignment) => [assignment.roleId, assignment]));
    for (const extracted of input.extractedTasks) {
      const role = roleById.get(extracted.assigneeRoleId) ?? UNASSIGNED_TASK_ROLE;
      const assignment = role.id === UNASSIGNED_TASK_ROLE.id ? undefined : assigneeByRole.get(role.id);
      const now = timestamp();
      await database.insert(tasks).values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        sourceMessageId: input.sourceMessageId,
        sourceMessageSubject: input.sourceMessageSubject,
        title: extracted.title,
        deadline: extracted.deadline,
        assigneeRoleId: role.id,
        assigneeRoleName: role.displayName,
        assigneeIdentityId: assignment?.identityId ?? null,
        assigneeName: assignment?.displayName ?? '未割り当て',
        description: extracted.description,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
    }
  },

  async list(input: { assigneeIdentityId?: string; unassigned?: boolean; event?: string } = {}): Promise<TaskView[]> {
    const conditions = [input.unassigned ? eq(tasks.assigneeRoleId, UNASSIGNED_TASK_ROLE.id) : input.assigneeIdentityId ? eq(tasks.assigneeIdentityId, input.assigneeIdentityId) : undefined,
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

import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';

import type { TaskDetails } from './event-details';
import type { AccountDatabase } from './storage/database';
import { operationalTaskRoles, taskRoleAssignments, taskRoleRevisions, tasks } from './storage/account-schema';

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

/** The single row that carries the Operational Task Role revision of one Account. */
export const TASK_ROLE_REVISION_ID = 'current';

/**
 * Whether the open Tasks still match the Operational Task Role set. It becomes
 * pending the moment a role is added, renamed, described differently, or
 * removed, and stays pending until an AccountIdentity completes a reassignment review.
 */
export interface TaskReassignmentReview {
  rolesChangedAt: string | null;
  reviewedAt: string | null;
  pending: boolean;
  openTasks: number;
}

export interface TaskView {
  id: string;
  title: string;
  deadline: string;
  assigneeRoleId: string;
  assigneeRoleName: string;
  assigneeContactId: string | null;
  assigneeName: string;
  sourceMessageSubject: string;
  description: string;
  remarks: string;
  completed: boolean;
  completedAt: string | null;
}

const timestamp = (): string => new Date().toISOString();

const reassignmentReviewOf = async (database: AccountDatabase): Promise<TaskReassignmentReview> => {
  const [revision, open] = await Promise.all([
    database.select().from(taskRoleRevisions).where(eq(taskRoleRevisions.id, TASK_ROLE_REVISION_ID)).get(),
    database.select({ value: count() }).from(tasks).where(eq(tasks.completed, false)).get(),
  ]);
  return {
    rolesChangedAt: revision?.changedAt ?? null,
    reviewedAt: revision?.reviewedAt ?? null,
    pending: (revision?.revision ?? 0) > (revision?.reviewedRevision ?? 0),
    openTasks: open?.value ?? 0,
  };
};

/**
 * Counts the role change rather than dating it: two changes within one
 * millisecond of a review must still leave the review pending.
 */
const recordRoleChange = async (database: AccountDatabase): Promise<void> => {
  const changedAt = timestamp();
  await database.insert(taskRoleRevisions)
    .values({ id: TASK_ROLE_REVISION_ID, revision: 1, reviewedRevision: 0, changedAt, reviewedAt: null })
    .onConflictDoUpdate({
      target: taskRoleRevisions.id,
      set: { revision: sql`${taskRoleRevisions.revision} + 1`, changedAt },
    }).run();
};

export const createTaskWorkflow = (database: AccountDatabase) => ({
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
    await recordRoleChange(database);
    return role;
  },

  async updateRole(id: string, input: { displayName?: string; description?: string }): Promise<OperationalTaskRole | null> {
    if (input.displayName === undefined && input.description === undefined) return null;
    const role = await database.update(operationalTaskRoles).set({ ...input, updatedAt: timestamp() })
      .where(eq(operationalTaskRoles.id, id)).returning({
        id: operationalTaskRoles.id,
        displayName: operationalTaskRoles.displayName,
        description: operationalTaskRoles.description,
      }).get();
    if (role) await recordRoleChange(database);
    return role;
  },

  async deleteRole(id: string): Promise<boolean> {
    const deleted = await database.delete(operationalTaskRoles).where(eq(operationalTaskRoles.id, id))
      .returning({ id: operationalTaskRoles.id }).get();
    if (deleted) await recordRoleChange(database);
    return Boolean(deleted);
  },

  /** Reports whether the open Tasks are still worth reviewing against the current roles. */
  async reassignmentReview(): Promise<TaskReassignmentReview> {
    return reassignmentReviewOf(database);
  },

  async markReassignmentReviewed(): Promise<TaskReassignmentReview> {
    const now = timestamp();
    await database.insert(taskRoleRevisions)
      .values({ id: TASK_ROLE_REVISION_ID, revision: 0, reviewedRevision: 0, changedAt: now, reviewedAt: now })
      .onConflictDoUpdate({
        target: taskRoleRevisions.id,
        set: { reviewedRevision: sql`${taskRoleRevisions.revision}`, reviewedAt: now },
      }).run();
    return reassignmentReviewOf(database);
  },

  /**
   * Moves the named open Tasks onto the roles an AccountIdentity accepted, taking each
   * assignee from the role's current holder. A Task that no longer exists, is
   * already completed, or would collide with an existing Task of the same role,
   * deadline, and title is reported as skipped rather than failing the batch.
   */
  async reassign(input: Array<{ taskId: string; roleId: string }>): Promise<{ tasks: TaskView[]; skipped: string[] }> {
    if (!input.length) return { tasks: [], skipped: [] };
    const [roles, assignments] = await Promise.all([
      database.select().from(operationalTaskRoles)
        .where(inArray(operationalTaskRoles.id, input.map(({ roleId }) => roleId))).all(),
      database.select().from(taskRoleAssignments).all(),
    ]);
    const roleById = new Map(roles.map((role) => [role.id, role]));
    const assigneeByRole = new Map(assignments.map((assignment) => [assignment.roleId, assignment]));
    const updated: TaskView[] = [];
    const skipped: string[] = [];
    for (const { taskId, roleId } of input) {
      const role = roleId === UNASSIGNED_TASK_ROLE.id ? UNASSIGNED_TASK_ROLE : roleById.get(roleId);
      if (!role) {
        skipped.push(taskId);
        continue;
      }
      const assignment = role.id === UNASSIGNED_TASK_ROLE.id ? undefined : assigneeByRole.get(role.id);
      try {
        const task = await database.update(tasks).set({
          assigneeRoleId: role.id,
          assigneeRoleName: role.displayName,
          assigneeContactId: assignment?.contactId ?? null,
          assigneeName: assignment?.displayName ?? UNASSIGNED_TASK_ROLE.displayName,
          updatedAt: timestamp(),
        }).where(and(eq(tasks.id, taskId), eq(tasks.completed, false))).returning().get();
        if (task) updated.push(task);
        else skipped.push(taskId);
      } catch {
        skipped.push(taskId);
      }
    }
    return { tasks: updated, skipped };
  },

  async assignRole(input: { roleId: string; contactId: string; displayName: string }): Promise<void> {
    const now = timestamp();
    await database.insert(taskRoleAssignments).values({ ...input, assignedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: taskRoleAssignments.roleId, set: { contactId: input.contactId, displayName: input.displayName, updatedAt: now } }).run();
  },

  async createFromSourceMessage(input: { accountId: string; sourceMessageId: string; sourceMessageSubject: string; extractedTasks: TaskDetails[] }): Promise<void> {
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
        accountId: input.accountId,
        sourceMessageId: input.sourceMessageId,
        sourceMessageSubject: input.sourceMessageSubject,
        title: extracted.title,
        deadline: extracted.deadline,
        assigneeRoleId: role.id,
        assigneeRoleName: role.displayName,
        assigneeContactId: assignment?.contactId ?? null,
        assigneeName: assignment?.displayName ?? '未割り当て',
        description: extracted.description,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
    }
  },

  async list(input: { assigneeContactId?: string; unassigned?: boolean; event?: string; completed?: boolean } = {}): Promise<TaskView[]> {
    const conditions = [input.unassigned ? eq(tasks.assigneeRoleId, UNASSIGNED_TASK_ROLE.id) : input.assigneeContactId ? eq(tasks.assigneeContactId, input.assigneeContactId) : undefined,
      input.event ? eq(tasks.sourceMessageSubject, input.event) : undefined,
      input.completed === undefined ? undefined : eq(tasks.completed, input.completed)].filter((value): value is NonNullable<typeof value> => Boolean(value));
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

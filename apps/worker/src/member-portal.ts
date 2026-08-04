import { and, asc, eq, gte, isNull } from 'drizzle-orm';

import { memberLogins } from './storage/control-schema';
import { attendance, events, members, portalInvitations, tasks } from './storage/organization-schema';
import type { ControlDatabase, OrganizationDatabase } from './storage/database';

export interface PortalMember {
  memberId: string;
  name: string;
}

export interface PortalEvent {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  registrationDeadline: string | null;
  status: 'unanswered' | 'attending' | 'not_attending';
  comment: string;
  open: boolean;
}

export interface PortalTask {
  taskId: string;
  title: string;
  deadline: string;
  assigneeRoleName: string;
  assigneeName: string;
  sourceMessageSubject: string;
  description: string;
  remarks: string;
  completed: boolean;
  mine: boolean;
}

export interface PortalView {
  member: PortalMember;
  events: PortalEvent[];
  tasks: PortalTask[];
}

/** Resolves the Member a signed-in Google account was bound to, if any. */
export const memberForGoogleSubject = async (
  database: OrganizationDatabase,
  googleSubject: string,
): Promise<PortalMember | null> => {
  const row = await database.select({ memberId: members.id, name: members.name })
    .from(members)
    .where(and(eq(members.googleSubject, googleSubject), eq(members.state, 'active')))
    .get();
  return row ?? null;
};

/**
 * Binds a Member to one Google account through a single-use portal invitation.
 *
 * The invitation is the only way in: it reaches the Member through their LINE
 * Destination, so a Member with none has no Portal access. After this the
 * account's stable `sub` identifies them and the roster address is never used
 * to prove who they are.
 */
export const bindMemberToGoogleAccount = async (input: {
  control: ControlDatabase;
  database: OrganizationDatabase;
  organizationId: string;
  token: string;
  googleSubject: string;
  now: string;
}): Promise<PortalMember> => {
  const link = await input.database.select({ memberId: portalInvitations.memberId, expiresAt: portalInvitations.expiresAt })
    .from(portalInvitations)
    .where(and(eq(portalInvitations.token, input.token), isNull(portalInvitations.usedAt)))
    .get();
  if (!link) throw new Error('Portal invitation has expired or was already used.');
  if (Date.parse(link.expiresAt) <= Date.parse(input.now)) throw new Error('Portal invitation has expired or was already used.');

  const bound = await input.database.select({ memberId: members.id }).from(members)
    .where(eq(members.googleSubject, input.googleSubject)).get();
  if (bound && bound.memberId !== link.memberId) throw new Error('This Google account is already linked to another Member.');

  const member = await input.database.update(members)
    .set({ googleSubject: input.googleSubject, updatedAt: input.now })
    .where(and(eq(members.id, link.memberId), eq(members.state, 'active')))
    .returning({ memberId: members.id, name: members.name })
    .get();
  if (!member) throw new Error('Member was not found.');

  const consumed = await input.database.update(portalInvitations).set({ usedAt: input.now })
    .where(and(eq(portalInvitations.token, input.token), isNull(portalInvitations.usedAt)))
    .returning({ token: portalInvitations.token }).get();
  if (!consumed) throw new Error('Portal invitation was already used.');

  await input.control.insert(memberLogins).values({
    googleSubject: input.googleSubject,
    organizationId: input.organizationId,
    createdAt: input.now,
  }).onConflictDoUpdate({
    target: memberLogins.googleSubject,
    set: { organizationId: input.organizationId },
  }).run();
  return member;
};

/**
 * The one Portal page: the events this Member may answer for, and every Task
 * in the Organization with the ones they may complete marked.
 */
export const portalView = async (input: {
  database: OrganizationDatabase;
  member: PortalMember;
  now: string;
}): Promise<PortalView> => {
  const [registrations, allTasks] = await Promise.all([
    input.database.select({
      eventId: events.id,
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      location: events.location,
      registrationDeadline: events.attendanceDeadline,
      status: attendance.status,
      comment: attendance.comment,
    }).from(attendance)
      .innerJoin(events, eq(events.id, attendance.eventId))
      .where(and(eq(attendance.memberId, input.member.memberId), gte(events.endsAt, input.now)))
      .orderBy(asc(events.startsAt)).all(),
    input.database.select({
      taskId: tasks.id,
      title: tasks.title,
      deadline: tasks.deadline,
      assigneeRoleName: tasks.assigneeRoleName,
      assigneeName: tasks.assigneeName,
      assigneeMemberId: tasks.assigneeMemberId,
      sourceMessageSubject: tasks.sourceMessageSubject,
      description: tasks.description,
      remarks: tasks.remarks,
      completed: tasks.completed,
    }).from(tasks).orderBy(asc(tasks.completed), asc(tasks.deadline)).all(),
  ]);
  return {
    member: input.member,
    events: registrations.map((row) => ({
      eventId: row.eventId,
      title: row.title,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      location: row.location,
      registrationDeadline: row.registrationDeadline,
      status: row.status,
      comment: row.comment,
      open: canRegisterAttendance({ registrationDeadline: row.registrationDeadline, now: input.now }),
    })),
    tasks: allTasks.map(({ assigneeMemberId, ...task }) => ({
      ...task,
      mine: assigneeMemberId === input.member.memberId,
    })),
  };
};

/** Registrations are locked once the Registration Deadline passes. */
export const canRegisterAttendance = (input: {
  registrationDeadline: string | null;
  now: string;
}): boolean => input.registrationDeadline !== null
  && Date.parse(input.now) < Date.parse(input.registrationDeadline);

export const registerAttendance = async (input: {
  database: OrganizationDatabase;
  member: PortalMember;
  eventId: string;
  status: 'unanswered' | 'attending' | 'not_attending';
  comment: string;
  now: string;
}): Promise<{ eventId: string; status: string; comment: string }> => {
  const registration = await input.database.select({ registrationDeadline: events.attendanceDeadline })
    .from(attendance).innerJoin(events, eq(events.id, attendance.eventId))
    .where(and(eq(attendance.eventId, input.eventId), eq(attendance.memberId, input.member.memberId)))
    .get();
  if (!registration) throw new Error('この予定の出欠登録対象ではありません。');
  if (!canRegisterAttendance({ registrationDeadline: registration.registrationDeadline, now: input.now })) {
    throw new Error('出欠登録の期限を過ぎています。');
  }
  await input.database.update(attendance)
    .set({ status: input.status, comment: input.comment, updatedAt: input.now })
    .where(and(eq(attendance.eventId, input.eventId), eq(attendance.memberId, input.member.memberId)))
    .run();
  return { eventId: input.eventId, status: input.status, comment: input.comment };
};

/** A Member may read every Task in the Organization but complete only their own. */
export const completeOwnTask = async (input: {
  database: OrganizationDatabase;
  member: PortalMember;
  taskId: string;
  completed?: boolean | undefined;
  remarks?: string | undefined;
  now: string;
}): Promise<{ taskId: string; completed: boolean; remarks: string }> => {
  if (input.completed === undefined && input.remarks === undefined) throw new Error('変更内容がありません。');
  const updated = await input.database.update(tasks).set({
    ...(input.completed === undefined ? {} : { completed: input.completed, completedAt: input.completed ? input.now : null }),
    ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
    updatedAt: input.now,
  }).where(and(eq(tasks.id, input.taskId), eq(tasks.assigneeMemberId, input.member.memberId)))
    .returning({ taskId: tasks.id, completed: tasks.completed, remarks: tasks.remarks })
    .get();
  if (!updated) throw new Error('自分に割り当てられたタスクのみ完了できます。');
  return updated;
};

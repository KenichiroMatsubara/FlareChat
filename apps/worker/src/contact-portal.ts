import { and, asc, eq, gte, isNull } from 'drizzle-orm';

import { conflict, gone, invalid, noAccess, notFound } from './refusal';
import { contactLogins } from './storage/control-schema';
import { attendance, events, contacts, portalInvitations, tasks } from './storage/account-schema';
import type { ControlDatabase, AccountDatabase } from './storage/database';

export interface PortalContact {
  contactId: string;
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
  assigneeName: string;
  sourceMessageSubject: string;
  description: string;
  remarks: string;
  completed: boolean;
  mine: boolean;
}

export interface PortalView {
  contact: PortalContact;
  events: PortalEvent[];
  tasks: PortalTask[];
}

/** Resolves the Contact a signed-in Google account was bound to, if any. */
export const contactForGoogleSubject = async (
  database: AccountDatabase,
  googleSubject: string,
): Promise<PortalContact | null> => {
  const row = await database.select({ contactId: contacts.id, name: contacts.name })
    .from(contacts)
    .where(and(eq(contacts.googleSubject, googleSubject), eq(contacts.state, 'active')))
    .get();
  return row ?? null;
};

/**
 * Binds a Contact to one Google account through a single-use portal invitation.
 *
 * The invitation is the only way in: it reaches the Contact through their LINE
 * Destination, so a Contact with none has no Portal access. After this the
 * account's stable `sub` identifies them and the roster address is never used
 * to prove who they are.
 */
export const bindContactToGoogleAccount = async (input: {
  control: ControlDatabase;
  database: AccountDatabase;
  accountId: string;
  token: string;
  googleSubject: string;
  now: string;
}): Promise<PortalContact> => {
  const link = await input.database.select({ contactId: portalInvitations.contactId, expiresAt: portalInvitations.expiresAt })
    .from(portalInvitations)
    .where(and(eq(portalInvitations.token, input.token), isNull(portalInvitations.usedAt)))
    .get();
  if (!link) throw gone('Portal invitation has expired or was already used.');
  if (Date.parse(link.expiresAt) <= Date.parse(input.now)) throw gone('Portal invitation has expired or was already used.');

  const bound = await input.database.select({ contactId: contacts.id }).from(contacts)
    .where(eq(contacts.googleSubject, input.googleSubject)).get();
  if (bound && bound.contactId !== link.contactId) throw conflict('This Google account is already linked to another Contact.');

  const contact = await input.database.update(contacts)
    .set({ googleSubject: input.googleSubject, updatedAt: input.now })
    .where(and(eq(contacts.id, link.contactId), eq(contacts.state, 'active')))
    .returning({ contactId: contacts.id, name: contacts.name })
    .get();
  if (!contact) throw notFound('Contact was not found.');

  const consumed = await input.database.update(portalInvitations).set({ usedAt: input.now })
    .where(and(eq(portalInvitations.token, input.token), isNull(portalInvitations.usedAt)))
    .returning({ token: portalInvitations.token }).get();
  if (!consumed) throw gone('Portal invitation was already used.');

  await input.control.insert(contactLogins).values({
    googleSubject: input.googleSubject,
    accountId: input.accountId,
    createdAt: input.now,
  }).onConflictDoUpdate({
    target: contactLogins.googleSubject,
    set: { accountId: input.accountId },
  }).run();
  return contact;
};

/**
 * The one Portal page: the events this Contact may answer for, and every Task
 * in the Account with the ones they may complete marked.
 */
export const portalView = async (input: {
  database: AccountDatabase;
  contact: PortalContact;
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
      .where(and(eq(attendance.contactId, input.contact.contactId), gte(events.endsAt, input.now)))
      .orderBy(asc(events.startsAt)).all(),
    input.database.select({
      taskId: tasks.id,
      title: tasks.title,
      deadline: tasks.deadline,
      assigneeName: tasks.assigneeName,
      assigneeContactId: tasks.assigneeContactId,
      sourceMessageSubject: tasks.sourceMessageSubject,
      description: tasks.description,
      remarks: tasks.remarks,
      completed: tasks.completed,
    }).from(tasks).orderBy(asc(tasks.completed), asc(tasks.deadline)).all(),
  ]);
  return {
    contact: input.contact,
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
    tasks: allTasks.map(({ assigneeContactId, ...task }) => ({
      ...task,
      mine: assigneeContactId === input.contact.contactId,
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
  database: AccountDatabase;
  contact: PortalContact;
  eventId: string;
  status: 'unanswered' | 'attending' | 'not_attending';
  comment: string;
  now: string;
}): Promise<{ eventId: string; status: string; comment: string }> => {
  const registration = await input.database.select({ registrationDeadline: events.attendanceDeadline })
    .from(attendance).innerJoin(events, eq(events.id, attendance.eventId))
    .where(and(eq(attendance.eventId, input.eventId), eq(attendance.contactId, input.contact.contactId)))
    .get();
  if (!registration) throw conflict('この予定の出欠登録対象ではありません。');
  if (!canRegisterAttendance({ registrationDeadline: registration.registrationDeadline, now: input.now })) {
    throw conflict('出欠登録の期限を過ぎています。');
  }
  await input.database.update(attendance)
    .set({ status: input.status, comment: input.comment, updatedAt: input.now })
    .where(and(eq(attendance.eventId, input.eventId), eq(attendance.contactId, input.contact.contactId)))
    .run();
  return { eventId: input.eventId, status: input.status, comment: input.comment };
};

/** A Contact may read every Task in the Account but complete only their own. */
export const completeOwnTask = async (input: {
  database: AccountDatabase;
  contact: PortalContact;
  taskId: string;
  completed?: boolean | undefined;
  remarks?: string | undefined;
  now: string;
}): Promise<{ taskId: string; completed: boolean; remarks: string }> => {
  if (input.completed === undefined && input.remarks === undefined) throw invalid('変更内容がありません。');
  const updated = await input.database.update(tasks).set({
    ...(input.completed === undefined ? {} : { completed: input.completed, completedAt: input.completed ? input.now : null }),
    ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
    updatedAt: input.now,
  }).where(and(eq(tasks.id, input.taskId), eq(tasks.assigneeContactId, input.contact.contactId)))
    .returning({ taskId: tasks.id, completed: tasks.completed, remarks: tasks.remarks })
    .get();
  if (!updated) throw noAccess('自分に割り当てられたタスクのみ完了できます。');
  return updated;
};

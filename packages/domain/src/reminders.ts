import type { AttendanceStatus } from './index';

/**
 * Reminders are off until an Account turns them on (ADR 0163). Messaging a
 * roster is the one thing this product does that cannot be taken back, so it is
 * not something an Account should discover it had been doing.
 */
export const DEFAULT_REMINDERS_ENABLED = false;

/** The stored switch, or null when what is stored is not a switch at all. */
export const readRemindersEnabled = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
};

export const writeRemindersEnabled = (enabled: boolean): string => String(enabled);

export const ATTENDANCE_REMINDER_DAYS = [7, 3, 1] as const;

export const shouldSendAttendanceReminder = (input: { status: AttendanceStatus; daysUntilDeadline: number; alreadySent: boolean }): boolean =>
  input.status === 'unanswered' && !input.alreadySent && ATTENDANCE_REMINDER_DAYS.includes(input.daysUntilDeadline as 7 | 3 | 1);

/**
 * The milestones a Task reminds on when its Account has chosen none, counted in
 * whole days until the deadline. Seven, three, and one day out warn ahead of
 * time, 0 is the deadline day itself, and -1 is the day it falls overdue.
 */
export const DEFAULT_TASK_REMINDER_DAYS: readonly number[] = [7, 3, 1, 0, -1];

/**
 * A milestone may sit up to a year before the deadline and up to thirty days
 * after it. Reminding about work that is a month late has stopped being a
 * reminder, and nothing on the deadline side needs more than a year of warning.
 */
export const MIN_TASK_REMINDER_DAY = -30;
export const MAX_TASK_REMINDER_DAY = 365;

/** Enough milestones to describe any cadence an Account wants without becoming nagging. */
export const MAX_TASK_REMINDER_DAYS = 12;

export type TaskReminderDaysRejection = 'not_a_list' | 'not_a_number' | 'out_of_range' | 'too_many';

export type TaskReminderDaysResult =
  | { accepted: true; days: readonly number[] }
  | { accepted: false; reason: TaskReminderDaysRejection };

/**
 * Reads the milestones an Account configured, from either the list the
 * administration GUI sends or the comma-separated form the setting is stored
 * as. Duplicates are folded and the result is ordered furthest-from-deadline
 * first, so the stored value reads in the order the reminders actually fire.
 *
 * An empty list is accepted and means this Account reminds about Tasks never.
 * Unlike the Event Response window, where 0 was refused for being ambiguous,
 * an empty list of milestones says exactly one thing.
 */
export const readTaskReminderDays = (value: unknown): TaskReminderDaysResult => {
  const entries = typeof value === 'string'
    ? value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : value;
  if (!Array.isArray(entries)) return { accepted: false, reason: 'not_a_list' };
  const days: number[] = [];
  for (const entry of entries) {
    const day = typeof entry === 'string' ? Number(entry.trim()) : entry;
    if (typeof day !== 'number' || !Number.isInteger(day)) return { accepted: false, reason: 'not_a_number' };
    if (day < MIN_TASK_REMINDER_DAY || day > MAX_TASK_REMINDER_DAY) return { accepted: false, reason: 'out_of_range' };
    if (!days.includes(day)) days.push(day);
  }
  if (days.length > MAX_TASK_REMINDER_DAYS) return { accepted: false, reason: 'too_many' };
  return { accepted: true, days: days.sort((left, right) => right - left) };
};

/** The stored form of the milestones, read back by `readTaskReminderDays`. */
export const writeTaskReminderDays = (days: readonly number[]): string => days.join(',');

/**
 * ADR 0030 reminds only those who have not yet acted, so a completed Task and
 * one with nobody to remind never produce a reminder. Which milestones remain
 * is the Account's decision (ADR 0163) rather than this module's.
 */
export const shouldSendTaskReminder = (input: {
  completed: boolean;
  assigned: boolean;
  daysUntilDeadline: number;
  milestones: readonly number[];
}): boolean => !input.completed
  && input.assigned
  && input.milestones.includes(input.daysUntilDeadline);

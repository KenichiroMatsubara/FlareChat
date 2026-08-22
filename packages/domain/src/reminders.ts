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

/**
 * The milestones an Event Response reminds on when its Account has chosen none,
 * counted in whole days until the Response Deadline. They are the cadence
 * attendance reminders were fixed to before ADR 0164 let an Account choose.
 */
export const DEFAULT_ATTENDANCE_REMINDER_DAYS: readonly number[] = [7, 3, 1];

/**
 * ADR 0030 reminds only those who have not yet answered, so a Registration that
 * has said either yes or no produces nothing. Which milestones remain is the
 * Account's decision (ADR 0164) rather than this module's, exactly as it is for
 * a Task.
 */
export const shouldSendAttendanceReminder = (input: {
  status: AttendanceStatus;
  daysUntilDeadline: number;
  alreadySent: boolean;
  milestones: readonly number[];
}): boolean => input.status === 'unanswered'
  && !input.alreadySent
  && input.milestones.includes(input.daysUntilDeadline);

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
export const MIN_REMINDER_DAY = -30;
export const MAX_REMINDER_DAY = 365;

/**
 * Attendance never reminds past its Response Deadline. Late work is still work,
 * but a Registration answered after the deadline is one the product will not
 * accept, so asking for it would be asking for something that cannot be given
 * (ADR 0163). The deadline day itself is the last moment worth asking on.
 */
export const MIN_ATTENDANCE_REMINDER_DAY = 0;

/** Enough milestones to describe any cadence an Account wants without becoming nagging. */
export const MAX_REMINDER_DAYS = 12;

export type ReminderDaysRejection = 'not_a_list' | 'not_a_number' | 'out_of_range' | 'too_many';

export type ReminderDaysResult =
  | { accepted: true; days: readonly number[] }
  | { accepted: false; reason: ReminderDaysRejection };

/**
 * Reads the milestones an Account configured, for Tasks or for Event Responses
 * alike, from either the list the administration GUI sends or the
 * comma-separated form the setting is stored as. Duplicates are folded and the result is ordered furthest-from-deadline
 * first, so the stored value reads in the order the reminders actually fire.
 *
 * An empty list is accepted and means this Account reminds about Tasks never.
 * Unlike the Event Response window, where 0 was refused for being ambiguous,
 * an empty list of milestones says exactly one thing.
 *
 * The nearest milestone a caller will accept is its own to say: attendance
 * stops at the deadline day where a Task may still remind after it.
 */
export const readReminderDays = (value: unknown, minimum: number = MIN_REMINDER_DAY): ReminderDaysResult => {
  const entries = typeof value === 'string'
    ? value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : value;
  if (!Array.isArray(entries)) return { accepted: false, reason: 'not_a_list' };
  const days: number[] = [];
  for (const entry of entries) {
    const day = typeof entry === 'string' ? Number(entry.trim()) : entry;
    if (typeof day !== 'number' || !Number.isInteger(day)) return { accepted: false, reason: 'not_a_number' };
    if (day < minimum || day > MAX_REMINDER_DAY) return { accepted: false, reason: 'out_of_range' };
    if (!days.includes(day)) days.push(day);
  }
  if (days.length > MAX_REMINDER_DAYS) return { accepted: false, reason: 'too_many' };
  return { accepted: true, days: days.sort((left, right) => right - left) };
};

/** The stored form of the milestones, read back by `readReminderDays`. */
export const writeReminderDays = (days: readonly number[]): string => days.join(',');

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

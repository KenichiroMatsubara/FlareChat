import type { AttendanceStatus } from './index';

export const ATTENDANCE_REMINDER_DAYS = [7, 3, 1] as const;

export const shouldSendAttendanceReminder = (input: { status: AttendanceStatus; daysUntilDeadline: number; alreadySent: boolean }): boolean =>
  input.status === 'unanswered' && !input.alreadySent && ATTENDANCE_REMINDER_DAYS.includes(input.daysUntilDeadline as 7 | 3 | 1);

export const TASK_REMINDER_DAYS = [7, 3, 1] as const;

/**
 * ADR 0030 reminds only those who have not yet acted, so a completed Task and
 * one with nobody to remind never produce a reminder.
 */
export const shouldSendTaskReminder = (input: {
  completed: boolean;
  assigned: boolean;
  daysUntilDeadline: number;
}): boolean => !input.completed
  && input.assigned
  && TASK_REMINDER_DAYS.includes(input.daysUntilDeadline as 7 | 3 | 1);

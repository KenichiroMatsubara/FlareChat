import type { AttendanceStatus } from './index';

export const ATTENDANCE_REMINDER_DAYS = [7, 3, 1] as const;

export const shouldSendAttendanceReminder = (input: { status: AttendanceStatus; daysUntilDeadline: number; alreadySent: boolean }): boolean =>
  input.status === 'unanswered' && !input.alreadySent && ATTENDANCE_REMINDER_DAYS.includes(input.daysUntilDeadline as 7 | 3 | 1);

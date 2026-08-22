import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TASK_REMINDER_DAYS,
  MAX_TASK_REMINDER_DAY,
  MAX_TASK_REMINDER_DAYS,
  MIN_TASK_REMINDER_DAY,
  readTaskReminderDays,
  shouldSendAttendanceReminder,
  shouldSendTaskReminder,
  writeTaskReminderDays,
} from './reminders';

describe('attendance reminders', () => {
  it('targets only unanswered registrations at the 7, 3, and 1 day milestones before the deadline', () => {
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 3, alreadySent: false })).toBe(true);
    expect(shouldSendAttendanceReminder({ status: 'attending', daysUntilDeadline: 3, alreadySent: false })).toBe(false);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 2, alreadySent: false })).toBe(false);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 1, alreadySent: true })).toBe(false);
  });
});

describe('Task deadline reminders', () => {
  const milestones = DEFAULT_TASK_REMINDER_DAYS;

  it('reminds only the assignee of an unfinished Task at a configured milestone', () => {
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: 3, milestones })).toBe(true);
    expect(shouldSendTaskReminder({ completed: true, assigned: true, daysUntilDeadline: 3, milestones })).toBe(false);
    expect(shouldSendTaskReminder({ completed: false, assigned: false, daysUntilDeadline: 3, milestones })).toBe(false);
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: 2, milestones })).toBe(false);
  });

  it('reminds by default on the deadline day and the day it falls overdue', () => {
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: 0, milestones })).toBe(true);
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: -1, milestones })).toBe(true);
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: -2, milestones })).toBe(false);
  });

  it('follows the milestones it is given rather than the product default', () => {
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: 3, milestones: [14] })).toBe(false);
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: 14, milestones: [14] })).toBe(true);
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: 0, milestones: [] })).toBe(false);
  });
});

describe('reading configured Task reminder milestones', () => {
  it('accepts the list the GUI sends and the string the setting is stored as', () => {
    expect(readTaskReminderDays([7, 3, 1, 0, -1])).toEqual({ accepted: true, days: [7, 3, 1, 0, -1] });
    expect(readTaskReminderDays('7,3,1,0,-1')).toEqual({ accepted: true, days: [7, 3, 1, 0, -1] });
    expect(readTaskReminderDays(['7', ' 3 '])).toEqual({ accepted: true, days: [7, 3] });
  });

  it('folds duplicates and orders furthest from the deadline first', () => {
    expect(readTaskReminderDays([1, 7, 1, -1, 0])).toEqual({ accepted: true, days: [7, 1, 0, -1] });
  });

  it('accepts an empty list as reminding never', () => {
    expect(readTaskReminderDays([])).toEqual({ accepted: true, days: [] });
    expect(readTaskReminderDays('')).toEqual({ accepted: true, days: [] });
  });

  it('refuses what is not a list of whole days inside the supported range', () => {
    expect(readTaskReminderDays(3)).toEqual({ accepted: false, reason: 'not_a_list' });
    expect(readTaskReminderDays([1.5])).toEqual({ accepted: false, reason: 'not_a_number' });
    expect(readTaskReminderDays(['soon'])).toEqual({ accepted: false, reason: 'not_a_number' });
    expect(readTaskReminderDays([MAX_TASK_REMINDER_DAY + 1])).toEqual({ accepted: false, reason: 'out_of_range' });
    expect(readTaskReminderDays([MIN_TASK_REMINDER_DAY - 1])).toEqual({ accepted: false, reason: 'out_of_range' });
    expect(readTaskReminderDays(Array.from({ length: MAX_TASK_REMINDER_DAYS + 1 }, (_, index) => index)))
      .toEqual({ accepted: false, reason: 'too_many' });
  });

  it('writes a form it can read back', () => {
    const written = writeTaskReminderDays(DEFAULT_TASK_REMINDER_DAYS);

    expect(readTaskReminderDays(written)).toEqual({ accepted: true, days: [...DEFAULT_TASK_REMINDER_DAYS] });
  });
});

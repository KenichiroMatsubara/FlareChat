import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ATTENDANCE_REMINDER_DAYS,
  MIN_ATTENDANCE_REMINDER_DAY,
  DEFAULT_TASK_REMINDER_DAYS,
  MAX_REMINDER_DAY,
  MAX_REMINDER_DAYS,
  MIN_REMINDER_DAY,
  readReminderDays,
  shouldSendAttendanceReminder,
  shouldSendTaskReminder,
  writeReminderDays,
} from './reminders';

describe('attendance reminders', () => {
  const milestones = DEFAULT_ATTENDANCE_REMINDER_DAYS;

  it('targets only unanswered registrations at a configured milestone before the deadline', () => {
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 3, alreadySent: false, milestones })).toBe(true);
    expect(shouldSendAttendanceReminder({ status: 'attending', daysUntilDeadline: 3, alreadySent: false, milestones })).toBe(false);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 2, alreadySent: false, milestones })).toBe(false);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 1, alreadySent: true, milestones })).toBe(false);
  });

  it('follows the milestones it is given rather than the product default', () => {
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 3, alreadySent: false, milestones: [14] })).toBe(false);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 14, alreadySent: false, milestones: [14] })).toBe(true);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 0, alreadySent: false, milestones: [] })).toBe(false);
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
    expect(readReminderDays([7, 3, 1, 0, -1])).toEqual({ accepted: true, days: [7, 3, 1, 0, -1] });
    expect(readReminderDays('7,3,1,0,-1')).toEqual({ accepted: true, days: [7, 3, 1, 0, -1] });
    expect(readReminderDays(['7', ' 3 '])).toEqual({ accepted: true, days: [7, 3] });
  });

  it('folds duplicates and orders furthest from the deadline first', () => {
    expect(readReminderDays([1, 7, 1, -1, 0])).toEqual({ accepted: true, days: [7, 1, 0, -1] });
  });

  it('accepts an empty list as reminding never', () => {
    expect(readReminderDays([])).toEqual({ accepted: true, days: [] });
    expect(readReminderDays('')).toEqual({ accepted: true, days: [] });
  });

  it('refuses what is not a list of whole days inside the supported range', () => {
    expect(readReminderDays(3)).toEqual({ accepted: false, reason: 'not_a_list' });
    expect(readReminderDays([1.5])).toEqual({ accepted: false, reason: 'not_a_number' });
    expect(readReminderDays(['soon'])).toEqual({ accepted: false, reason: 'not_a_number' });
    expect(readReminderDays([MAX_REMINDER_DAY + 1])).toEqual({ accepted: false, reason: 'out_of_range' });
    expect(readReminderDays([MIN_REMINDER_DAY - 1])).toEqual({ accepted: false, reason: 'out_of_range' });
    expect(readReminderDays(Array.from({ length: MAX_REMINDER_DAYS + 1 }, (_, index) => index)))
      .toEqual({ accepted: false, reason: 'too_many' });
  });

  it('refuses a milestone nearer than the caller allows, so attendance stops at the deadline day', () => {
    expect(readReminderDays([0], MIN_ATTENDANCE_REMINDER_DAY)).toEqual({ accepted: true, days: [0] });
    expect(readReminderDays([-1], MIN_ATTENDANCE_REMINDER_DAY)).toEqual({ accepted: false, reason: 'out_of_range' });
    expect(readReminderDays([-1])).toEqual({ accepted: true, days: [-1] });
  });

  it('writes a form it can read back', () => {
    const written = writeReminderDays(DEFAULT_TASK_REMINDER_DAYS);

    expect(readReminderDays(written)).toEqual({ accepted: true, days: [...DEFAULT_TASK_REMINDER_DAYS] });
  });
});

import { describe, expect, it } from 'vitest';

import { shouldSendAttendanceReminder, shouldSendTaskReminder } from './reminders';

describe('attendance reminders', () => {
  it('targets only unanswered registrations at the 7, 3, and 1 day milestones before the deadline', () => {
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 3, alreadySent: false })).toBe(true);
    expect(shouldSendAttendanceReminder({ status: 'attending', daysUntilDeadline: 3, alreadySent: false })).toBe(false);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 2, alreadySent: false })).toBe(false);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 1, alreadySent: true })).toBe(false);
  });
});

describe('Task deadline reminders', () => {
  it('reminds only the assignee of an unfinished Task at the 7, 3, and 1 day milestones', () => {
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: 3 })).toBe(true);
    expect(shouldSendTaskReminder({ completed: true, assigned: true, daysUntilDeadline: 3 })).toBe(false);
    expect(shouldSendTaskReminder({ completed: false, assigned: false, daysUntilDeadline: 3 })).toBe(false);
    expect(shouldSendTaskReminder({ completed: false, assigned: true, daysUntilDeadline: 2 })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { shouldSendAttendanceReminder } from './reminders';

describe('attendance reminders', () => {
  it('targets only unanswered registrations at the 7, 3, and 1 day milestones before the deadline', () => {
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 3, alreadySent: false })).toBe(true);
    expect(shouldSendAttendanceReminder({ status: 'attending', daysUntilDeadline: 3, alreadySent: false })).toBe(false);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 2, alreadySent: false })).toBe(false);
    expect(shouldSendAttendanceReminder({ status: 'unanswered', daysUntilDeadline: 1, alreadySent: true })).toBe(false);
  });
});

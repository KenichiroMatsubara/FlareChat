import { afterEach, describe, expect, it } from 'vitest';

import { enqueueDueAttendanceReminders } from './attendance-reminders';
import { claimDueJobs } from './jobs';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { seedAttendanceRegistration, seedScheduledEvent } from '../test/seed';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const databaseAtMilestone = (
  daysUntilDeadline: 7 | 3 | 1,
): { database: TestD1Database; now: string } => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  const deadline = '2026-08-03T00:00:00.000Z';
  seedScheduledEvent(database, { id: `event-${daysUntilDeadline}`, attendanceDeadline: deadline });
  seedAttendanceRegistration(database, {
    eventId: `event-${daysUntilDeadline}`,
    memberId: `recipient-${daysUntilDeadline}`,
    destination: `${daysUntilDeadline}@example.com`,
  });
  return {
    database,
    now: new Date(Date.parse(deadline) - daysUntilDeadline * 86_400_000).toISOString(),
  };
};

describe('Attendance reminder scheduling', () => {
  it('makes one durable reminder claimable at each 7, 3, and 1-day milestone', async () => {
    for (const milestone of [7, 3, 1] as const) {
      const { database, now } = databaseAtMilestone(milestone);

      await expect(enqueueDueAttendanceReminders(database.binding, now)).resolves.toBe(1);
      const reminders = await claimDueJobs(database.binding, now);

      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toMatchObject({
        kind: 'attendance_reminder',
        idempotencyKey: `attendance-reminder:event-${milestone}:recipient-${milestone}:${milestone}`,
      });
      expect(JSON.parse(reminders[0]!.payload)).toMatchObject({
        destination: `${milestone}@example.com`,
        milestone,
      });
    }
  });

  it('does not queue reminders for answered registrations or duplicate a milestone', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    seedScheduledEvent(database, { id: 'event-1', attendanceDeadline: '2026-08-03T00:00:00.000Z' });
    seedAttendanceRegistration(database, {
      eventId: 'event-1',
      memberId: 'unanswered',
      destination: 'unanswered@example.com',
    });
    seedAttendanceRegistration(database, {
      eventId: 'event-1',
      memberId: 'attending',
      destination: 'attending@example.com',
      status: 'attending',
    });

    const now = '2026-07-31T00:00:00.000Z';
    await expect(enqueueDueAttendanceReminders(database.binding, now)).resolves.toBe(1);
    await expect(enqueueDueAttendanceReminders(database.binding, now)).resolves.toBe(0);

    const reminders = await claimDueJobs(database.binding, now);
    expect(reminders.map((job) => JSON.parse(job.payload))).toEqual([
      expect.objectContaining({ destination: 'unanswered@example.com' }),
    ]);
  });
});

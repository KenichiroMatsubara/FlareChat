import { afterEach, describe, expect, it } from 'vitest';

import {
  accountAttendanceRemindersEnabled,
  enqueueDueAttendanceReminders,
  saveAccountAttendanceRemindersEnabled,
  upcomingAttendanceReminders,
} from './attendance-reminders';
import { accountDatabase } from './storage/database';
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
  // Reminders are off until an Account turns them on (ADR 0163).
  database.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES ('attendance_reminders_enabled', 'true', '2026-08-01')`,
  );
  const deadline = '2026-08-03T00:00:00.000Z';
  seedScheduledEvent(database, { id: `event-${daysUntilDeadline}`, attendanceDeadline: deadline });
  seedAttendanceRegistration(database, {
    eventId: `event-${daysUntilDeadline}`,
    contactId: `recipient-${daysUntilDeadline}`,
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
    database.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ('attendance_reminders_enabled', 'true', '2026-08-01')`,
    );
    seedScheduledEvent(database, { id: 'event-1', attendanceDeadline: '2026-08-03T00:00:00.000Z' });
    seedAttendanceRegistration(database, {
      eventId: 'event-1',
      contactId: 'unanswered',
      destination: 'unanswered@example.com',
    });
    seedAttendanceRegistration(database, {
      eventId: 'event-1',
      contactId: 'attending',
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

describe('the attendance reminder switch', () => {
  it('is off until an Account turns it on, so an upgrade messages nobody', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    seedScheduledEvent(database, { id: 'event-1', attendanceDeadline: '2026-08-03T00:00:00.000Z' });
    seedAttendanceRegistration(database, { eventId: 'event-1', contactId: 'contact-1', destination: 'Ucontact-1' });

    await expect(accountAttendanceRemindersEnabled(accountDatabase(database.binding))).resolves.toBe(false);
    await expect(enqueueDueAttendanceReminders(database.binding, '2026-07-31T00:00:00.000Z')).resolves.toBe(0);
  });

  it('queues once it is turned on, and stops again when it is turned off', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    seedScheduledEvent(database, { id: 'event-1', attendanceDeadline: '2026-08-03T00:00:00.000Z' });
    seedAttendanceRegistration(database, { eventId: 'event-1', contactId: 'contact-1', destination: 'Ucontact-1' });

    await saveAccountAttendanceRemindersEnabled(accountDatabase(database.binding), true, '2026-07-01T00:00:00.000Z');
    await expect(enqueueDueAttendanceReminders(database.binding, '2026-07-31T00:00:00.000Z')).resolves.toBe(1);

    await saveAccountAttendanceRemindersEnabled(accountDatabase(database.binding), false, '2026-07-01T00:00:00.000Z');
    await expect(enqueueDueAttendanceReminders(database.binding, '2026-07-27T00:00:00.000Z')).resolves.toBe(0);
  });

  it('previews what it would send even while it is off', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    seedScheduledEvent(database, { id: 'event-1', attendanceDeadline: '2026-08-03T00:00:00.000Z' });
    seedAttendanceRegistration(database, { eventId: 'event-1', contactId: 'contact-1', destination: 'Ucontact-1' });

    const scheduled = await upcomingAttendanceReminders(database.binding, '2026-07-20T00:00:00.000Z');

    expect(await accountAttendanceRemindersEnabled(accountDatabase(database.binding))).toBe(false);
    expect(scheduled.map((reminder) => [reminder.sendOn, reminder.milestone])).toEqual([
      ['2026-07-27', 7],
      ['2026-07-31', 3],
      ['2026-08-02', 1],
    ]);
    expect(scheduled[0]?.text).toContain('回答期限まであと7日');
  });

  it('previews nothing for somebody who has already answered', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    seedScheduledEvent(database, { id: 'event-1', attendanceDeadline: '2026-08-03T00:00:00.000Z' });
    seedAttendanceRegistration(database, {
      eventId: 'event-1',
      contactId: 'contact-1',
      destination: 'Ucontact-1',
      status: 'attending',
    });

    await expect(upcomingAttendanceReminders(database.binding, '2026-07-20T00:00:00.000Z')).resolves.toEqual([]);
  });
});

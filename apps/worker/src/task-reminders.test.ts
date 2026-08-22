import { afterEach, describe, expect, it } from 'vitest';

import { claimDueJobs } from './jobs';
import {
  accountTaskReminderDays,
  accountTaskRemindersEnabled,
  enqueueDueTaskReminders,
  saveAccountTaskReminderDays,
  saveAccountTaskRemindersEnabled,
  upcomingTaskReminders,
} from './task-reminders';
import { accountDatabase } from './storage/database';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { seedContact } from '../test/seed';

const openDatabases: TestD1Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const databaseWithTask = (input: {
  deadline: string;
  assigned?: boolean;
  completed?: boolean;
}): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  // Reminders are off until an Account turns them on (ADR 0163); these cover what
  // an Account that has turned them on then receives.
  database.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES ('task_reminders_enabled', 'true', '2026-08-01')`,
  );
  seedContact(database, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember-1' });
  database.execute(
    `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
     VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')`,
  );
  database.execute(
    `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline,
       assignee_member_id, assignee_name, description, completed, created_at, updated_at)
     VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '参加費を振り込む', ?, ?, '山田花子', '指定口座へ送金する', ?, '2026-08-01', '2026-08-01')`,
    input.deadline,
    input.assigned === false ? null : 'member-1',
    input.completed ? 1 : 0,
  );
  return database;
};

describe('Task deadline reminders', () => {
  it('makes one durable reminder claimable for the assignee at each milestone', async () => {
    for (const milestone of [7, 3, 1] as const) {
      const deadline = '2026-08-20T00:00:00.000Z';
      const database = databaseWithTask({ deadline });
      const now = new Date(Date.parse(deadline) - milestone * 86_400_000).toISOString();

      await expect(enqueueDueTaskReminders(database.binding, now)).resolves.toBe(1);
      const reminders = await claimDueJobs(database.binding, now);

      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toMatchObject({
        kind: 'task_reminder',
        idempotencyKey: `task-reminder:task-1:${milestone}`,
      });
      expect(JSON.parse(reminders[0]!.payload)).toMatchObject({
        taskId: 'task-1',
        contactId: 'member-1',
        destination: 'Umember-1',
        milestone,
      });
    }
  });

  it('reminds nobody about a completed Task, an unassigned one, or a day that is not a milestone', async () => {
    const deadline = '2026-08-20T00:00:00.000Z';
    const threeDaysBefore = '2026-08-17T00:00:00.000Z';

    await expect(enqueueDueTaskReminders(databaseWithTask({ deadline, completed: true }).binding, threeDaysBefore))
      .resolves.toBe(0);
    await expect(enqueueDueTaskReminders(databaseWithTask({ deadline, assigned: false }).binding, threeDaysBefore))
      .resolves.toBe(0);
    await expect(enqueueDueTaskReminders(databaseWithTask({ deadline }).binding, '2026-08-18T00:00:00.000Z'))
      .resolves.toBe(0);
  });

  it('does not duplicate a milestone it already queued', async () => {
    const database = databaseWithTask({ deadline: '2026-08-20T00:00:00.000Z' });
    const now = '2026-08-17T00:00:00.000Z';

    await expect(enqueueDueTaskReminders(database.binding, now)).resolves.toBe(1);
    await expect(enqueueDueTaskReminders(database.binding, now)).resolves.toBe(0);
  });

  it('reminds on the deadline day and the day it falls overdue without being configured to', async () => {
    const deadline = '2026-08-20T00:00:00.000Z';

    await expect(enqueueDueTaskReminders(databaseWithTask({ deadline }).binding, deadline)).resolves.toBe(1);
    await expect(enqueueDueTaskReminders(databaseWithTask({ deadline }).binding, '2026-08-21T00:00:00.000Z')).resolves.toBe(1);
    await expect(enqueueDueTaskReminders(databaseWithTask({ deadline }).binding, '2026-08-22T00:00:00.000Z')).resolves.toBe(0);
  });
});

describe('the Task reminder switch', () => {
  const deadline = '2026-08-20T00:00:00.000Z';

  it('is off until an Account turns it on, so an upgrade messages nobody', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    seedContact(database, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember-1' });
    database.execute(
      `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')`,
    );
    database.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline,
         assignee_member_id, assignee_name, description, completed, created_at, updated_at)
       VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '参加費を振り込む', ?, 'member-1', '山田花子', '送金する', 0, '2026-08-01', '2026-08-01')`,
      deadline,
    );

    await expect(accountTaskRemindersEnabled(accountDatabase(database.binding))).resolves.toBe(false);
    await expect(enqueueDueTaskReminders(database.binding, '2026-08-17T00:00:00.000Z')).resolves.toBe(0);
    // The preview still answers what turning it on would send.
    await expect(upcomingTaskReminders(database.binding, '2026-08-17T00:00:00.000Z')).resolves.not.toEqual([]);
  });

  it('stops queueing again when it is turned off, and keeps the cadence it was given', async () => {
    const database = databaseWithTask({ deadline });
    await saveAccountTaskReminderDays(accountDatabase(database.binding), [3], '2026-08-01T00:00:00.000Z');

    await saveAccountTaskRemindersEnabled(accountDatabase(database.binding), false, '2026-08-01T00:00:00.000Z');
    await expect(enqueueDueTaskReminders(database.binding, '2026-08-17T00:00:00.000Z')).resolves.toBe(0);

    await saveAccountTaskRemindersEnabled(accountDatabase(database.binding), true, '2026-08-01T00:00:00.000Z');
    await expect(accountTaskReminderDays(accountDatabase(database.binding))).resolves.toEqual([3]);
    await expect(enqueueDueTaskReminders(database.binding, '2026-08-17T00:00:00.000Z')).resolves.toBe(1);
  });
});

describe('the Task reminder milestones an Account configured', () => {
  const deadline = '2026-08-20T00:00:00.000Z';

  it('is the product default until the Account chooses otherwise', async () => {
    const database = databaseWithTask({ deadline });

    await expect(accountTaskReminderDays(accountDatabase(database.binding))).resolves.toEqual([7, 3, 1, 0, -1]);
  });

  it('replaces the default rather than adding to it', async () => {
    const database = databaseWithTask({ deadline });
    await saveAccountTaskReminderDays(accountDatabase(database.binding), [14], '2026-08-01T00:00:00.000Z');

    // Three days out is a default milestone this Account no longer reminds on.
    await expect(enqueueDueTaskReminders(database.binding, '2026-08-17T00:00:00.000Z')).resolves.toBe(0);
    await expect(enqueueDueTaskReminders(database.binding, '2026-08-06T00:00:00.000Z')).resolves.toBe(1);
  });

  it('queues nothing at all once the Account empties the list', async () => {
    const database = databaseWithTask({ deadline });
    await saveAccountTaskReminderDays(accountDatabase(database.binding), [], '2026-08-01T00:00:00.000Z');

    await expect(enqueueDueTaskReminders(database.binding, '2026-08-17T00:00:00.000Z')).resolves.toBe(0);
    await expect(enqueueDueTaskReminders(database.binding, deadline)).resolves.toBe(0);
  });

  it('previews every reminder still ahead, worded as it will arrive', async () => {
    const database = databaseWithTask({ deadline: '2026-08-20T00:00:00.000Z' });
    await saveAccountTaskReminderDays(accountDatabase(database.binding), [3, 0, -1], '2026-08-01T00:00:00.000Z');

    const scheduled = await upcomingTaskReminders(database.binding, '2026-08-15T00:00:00.000Z');

    expect(scheduled.map((reminder) => [reminder.sendOn, reminder.milestone])).toEqual([
      ['2026-08-17', 3],
      ['2026-08-20', 0],
      ['2026-08-21', -1],
    ]);
    expect(scheduled[0]).toMatchObject({ contactName: '山田花子', channel: 'line' });
    expect(scheduled[0]?.text).toContain('締め切りまであと3日');
    expect(scheduled[1]?.text).toContain('本日が締め切りです');
    expect(scheduled[2]?.text).toContain('期限切れです');
  });

  it('leaves out the reminders whose day has already passed', async () => {
    const database = databaseWithTask({ deadline: '2026-08-20T00:00:00.000Z' });

    const scheduled = await upcomingTaskReminders(database.binding, '2026-08-19T00:00:00.000Z');

    expect(scheduled.map((reminder) => reminder.milestone)).toEqual([1, 0, -1]);
  });

  it('previews nothing for a completed Task or an Account that reminds never', async () => {
    await expect(upcomingTaskReminders(
      databaseWithTask({ deadline: '2026-08-20T00:00:00.000Z', completed: true }).binding,
      '2026-08-15T00:00:00.000Z',
    )).resolves.toEqual([]);

    const off = databaseWithTask({ deadline: '2026-08-20T00:00:00.000Z' });
    await saveAccountTaskReminderDays(accountDatabase(off.binding), [], '2026-08-01T00:00:00.000Z');
    await expect(upcomingTaskReminders(off.binding, '2026-08-15T00:00:00.000Z')).resolves.toEqual([]);
  });

  it('masks the LINE destination it previews, as every other Account API does', async () => {
    const database = databaseWithTask({ deadline: '2026-08-20T00:00:00.000Z' });

    const scheduled = await upcomingTaskReminders(database.binding, '2026-08-15T00:00:00.000Z');

    expect(scheduled[0]?.destination).not.toBe('Umember-1');
    expect(scheduled[0]?.destination.startsWith('Umemb')).toBe(true);
  });

  it('falls back to the default when the stored value stops reading as milestones', async () => {
    const database = databaseWithTask({ deadline });
    database.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ('task_reminder_days', 'whenever', '2026-08-01')`,
    );

    await expect(accountTaskReminderDays(accountDatabase(database.binding))).resolves.toEqual([7, 3, 1, 0, -1]);
  });
});

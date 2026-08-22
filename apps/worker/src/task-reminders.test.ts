import { afterEach, describe, expect, it } from 'vitest';

import { claimDueJobs } from './jobs';
import { enqueueDueTaskReminders } from './task-reminders';
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
});

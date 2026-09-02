import { afterEach, describe, expect, it } from 'vitest';

import { app } from './app';
import { claimDueJobs } from './jobs';
import { enqueueDueReminders, reminderJobHandler, reminderSettings, scheduleReminder, upcomingReminders } from './reminders';
import { accountDatabase } from './storage/database';
import type { ClaimedJob } from './jobs';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { memoryProviders, type MemoryProviders } from '../test/providers';
import { seedAttendanceRegistration, seedContact, seedScheduledEvent } from '../test/seed';

const openDatabases: TestD1Database[] = [];
let fixture: TestApp | undefined;

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  fixture?.close();
  fixture = undefined;
});

const DEADLINE = '2026-08-20T00:00:00.000Z';
const CREATED_AT = '2026-08-01T00:00:00.000Z';

const enable = (database: TestD1Database, key: 'task_reminders_enabled' | 'attendance_reminders_enabled'): void => {
  database.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('${key}', 'true', '2026-08-01')`);
};

const seedTask = (database: TestD1Database, input: { deadline?: string; assigned?: boolean; completed?: boolean } = {}): void => {
  database.execute(
    `INSERT OR IGNORE INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
     VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')`,
  );
  database.execute(
    `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline,
       assignee_member_id, assignee_name, description, completed, created_at, updated_at)
     VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '参加費を振り込む', ?, ?, '山田花子', '指定口座へ送金する', ?, '2026-08-01', '2026-08-01')`,
    input.deadline ?? DEADLINE,
    input.assigned === false ? null : 'member-1',
    input.completed ? 1 : 0,
  );
};

/** An Account that turned Task reminders on and holds one LINE-reachable assignee. */
const databaseWithTask = (input: { deadline?: string; assigned?: boolean; completed?: boolean } = {}): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  enable(database, 'task_reminders_enabled');
  seedContact(database, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember-1' });
  seedTask(database, input);
  return database;
};

/** An Account that turned attendance reminders on and holds one unanswered LINE-reachable Registration. */
const databaseWithRegistration = (input: { deadline?: string; status?: 'unanswered' | 'attending'; enabled?: boolean } = {}): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  if (input.enabled !== false) enable(database, 'attendance_reminders_enabled');
  seedScheduledEvent(database, { id: 'event-1', attendanceDeadline: input.deadline ?? '2026-08-03T00:00:00.000Z' });
  seedAttendanceRegistration(database, { eventId: 'event-1', contactId: 'contact-1', destination: 'Ucontact-1', ...(input.status ? { status: input.status } : {}) });
  return database;
};

const daysBefore = (deadline: string, days: number): string => new Date(Date.parse(deadline) - days * 86_400_000).toISOString();

describe('queueing due reminders', () => {
  it('makes one durable Task reminder claimable for the assignee at each milestone', async () => {
    for (const milestone of [7, 3, 1] as const) {
      const database = databaseWithTask();
      const now = daysBefore(DEADLINE, milestone);

      await expect(enqueueDueReminders(database.binding, now)).resolves.toBe(1);
      const reminders = await claimDueJobs(database.binding, now);

      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toMatchObject({ kind: 'reminder', idempotencyKey: `reminder:task:task-1:member-1:${milestone}` });
      expect(JSON.parse(reminders[0]!.payload)).toEqual({ subject: 'task', taskId: 'task-1', contactId: 'member-1', milestone });
    }
  });

  it('makes one durable attendance reminder claimable at each 7, 3, and 1-day milestone', async () => {
    for (const milestone of [7, 3, 1] as const) {
      const database = databaseWithRegistration();
      const now = daysBefore('2026-08-03T00:00:00.000Z', milestone);

      await expect(enqueueDueReminders(database.binding, now)).resolves.toBe(1);
      const reminders = await claimDueJobs(database.binding, now);

      expect(reminders[0]).toMatchObject({ kind: 'reminder', idempotencyKey: `reminder:registration:event-1:contact-1:${milestone}` });
      expect(JSON.parse(reminders[0]!.payload)).toEqual({ subject: 'registration', eventId: 'event-1', contactId: 'contact-1', milestone });
    }
  });

  it('reminds nobody about a completed Task, an unassigned one, an answered Registration, or a day that is not a milestone', async () => {
    const threeDaysBefore = daysBefore(DEADLINE, 3);
    await expect(enqueueDueReminders(databaseWithTask({ completed: true }).binding, threeDaysBefore)).resolves.toBe(0);
    await expect(enqueueDueReminders(databaseWithTask({ assigned: false }).binding, threeDaysBefore)).resolves.toBe(0);
    await expect(enqueueDueReminders(databaseWithTask().binding, daysBefore(DEADLINE, 2))).resolves.toBe(0);
    await expect(enqueueDueReminders(databaseWithRegistration({ status: 'attending' }).binding, '2026-07-31T00:00:00.000Z')).resolves.toBe(0);
  });

  it('does not duplicate a milestone it already queued', async () => {
    const database = databaseWithTask();
    const now = daysBefore(DEADLINE, 3);

    await expect(enqueueDueReminders(database.binding, now)).resolves.toBe(1);
    await expect(enqueueDueReminders(database.binding, now)).resolves.toBe(0);
  });

  it('reminds on the deadline day and the day a Task falls overdue, but never after an attendance deadline', async () => {
    await expect(enqueueDueReminders(databaseWithTask().binding, DEADLINE)).resolves.toBe(1);
    await expect(enqueueDueReminders(databaseWithTask().binding, daysBefore(DEADLINE, -1))).resolves.toBe(1);
    await expect(enqueueDueReminders(databaseWithTask().binding, daysBefore(DEADLINE, -2))).resolves.toBe(0);
    await expect(enqueueDueReminders(databaseWithRegistration().binding, '2026-08-03T00:00:00.000Z')).resolves.toBe(0);
  });

  it('queues both subjects in one pass, each under its own switch', async () => {
    const database = databaseWithTask({ deadline: '2026-08-03T00:00:00.000Z' });
    enable(database, 'attendance_reminders_enabled');
    seedScheduledEvent(database, { id: 'event-1', attendanceDeadline: '2026-08-03T00:00:00.000Z' });
    seedAttendanceRegistration(database, { eventId: 'event-1', contactId: 'contact-1', destination: 'Ucontact-1' });

    await expect(enqueueDueReminders(database.binding, '2026-07-31T00:00:00.000Z')).resolves.toBe(2);
    await reminderSettings(accountDatabase(database.binding), 'task').saveEnabled(false, '2026-07-31T00:00:00.000Z');
    await expect(enqueueDueReminders(database.binding, '2026-08-02T00:00:00.000Z')).resolves.toBe(1);
  });
});

describe('the reminder switches', () => {
  it('are off until an Account turns them on, so an upgrade messages nobody', async () => {
    const task = createMigratedTestD1('organization');
    openDatabases.push(task);
    seedContact(task, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember-1' });
    seedTask(task);
    const registration = databaseWithRegistration({ enabled: false });

    await expect(reminderSettings(accountDatabase(task.binding), 'task').enabled()).resolves.toBe(false);
    await expect(enqueueDueReminders(task.binding, daysBefore(DEADLINE, 3))).resolves.toBe(0);
    // The preview still answers what turning it on would send.
    await expect(upcomingReminders(task.binding, daysBefore(DEADLINE, 3))).resolves.not.toEqual([]);
    await expect(reminderSettings(accountDatabase(registration.binding), 'registration').enabled()).resolves.toBe(false);
    await expect(enqueueDueReminders(registration.binding, '2026-07-31T00:00:00.000Z')).resolves.toBe(0);
    await expect(upcomingReminders(registration.binding, '2026-07-20T00:00:00.000Z')).resolves.toMatchObject([
      { sendOn: '2026-07-27', milestone: 7 }, { sendOn: '2026-07-31', milestone: 3 }, { sendOn: '2026-08-02', milestone: 1 },
    ]);
  });

  it('stop queueing again when turned off, and keep the cadence they were given', async () => {
    const database = databaseWithTask();
    const settings = reminderSettings(accountDatabase(database.binding), 'task');
    await settings.saveDays([3], '2026-08-01T00:00:00.000Z');

    await settings.saveEnabled(false, '2026-08-01T00:00:00.000Z');
    await expect(enqueueDueReminders(database.binding, daysBefore(DEADLINE, 3))).resolves.toBe(0);

    await settings.saveEnabled(true, '2026-08-01T00:00:00.000Z');
    await expect(settings.days()).resolves.toEqual([3]);
    await expect(enqueueDueReminders(database.binding, daysBefore(DEADLINE, 3))).resolves.toBe(1);
  });
});

describe('the Reminder Milestones an Account chose', () => {
  it('are the product defaults until the Account chooses otherwise', async () => {
    const database = databaseWithTask();
    await expect(reminderSettings(accountDatabase(database.binding), 'task').days()).resolves.toEqual([7, 3, 1, 0, -1]);
    await expect(reminderSettings(accountDatabase(database.binding), 'registration').days()).resolves.toEqual([7, 3, 1]);
  });

  it('replace the default rather than adding to it', async () => {
    const database = databaseWithTask();
    await reminderSettings(accountDatabase(database.binding), 'task').saveDays([14], '2026-08-01T00:00:00.000Z');

    await expect(enqueueDueReminders(database.binding, daysBefore(DEADLINE, 3))).resolves.toBe(0);
    await expect(enqueueDueReminders(database.binding, daysBefore(DEADLINE, 14))).resolves.toBe(1);
  });

  it('queue on a chosen attendance milestone and no longer on one that was dropped', async () => {
    const database = databaseWithRegistration();
    await reminderSettings(accountDatabase(database.binding), 'registration').saveDays([14, 0], '2026-07-01T00:00:00.000Z');

    await expect(enqueueDueReminders(database.binding, '2026-07-31T00:00:00.000Z')).resolves.toBe(0);
    await expect(enqueueDueReminders(database.binding, '2026-07-20T00:00:00.000Z')).resolves.toBe(1);
    await expect(enqueueDueReminders(database.binding, '2026-08-03T00:00:00.000Z')).resolves.toBe(1);
  });

  it('queue nothing at all once the Account empties the list', async () => {
    const database = databaseWithTask();
    await reminderSettings(accountDatabase(database.binding), 'task').saveDays([], '2026-08-01T00:00:00.000Z');

    await expect(enqueueDueReminders(database.binding, daysBefore(DEADLINE, 3))).resolves.toBe(0);
    await expect(enqueueDueReminders(database.binding, DEADLINE)).resolves.toBe(0);
    await expect(upcomingReminders(database.binding, daysBefore(DEADLINE, 5))).resolves.toEqual([]);
  });

  it('fall back to the default when the stored value stops reading as milestones', async () => {
    const database = databaseWithTask();
    database.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('task_reminder_days', 'whenever', '2026-08-01')`);

    await expect(reminderSettings(accountDatabase(database.binding), 'task').days()).resolves.toEqual([7, 3, 1, 0, -1]);
  });
});

describe('the Reminder Schedule', () => {
  it('previews every reminder still ahead, worded as it will arrive, with its subject', async () => {
    const database = databaseWithTask();
    await reminderSettings(accountDatabase(database.binding), 'task').saveDays([3, 0, -1], '2026-08-01T00:00:00.000Z');
    seedScheduledEvent(database, { id: 'event-1', attendanceDeadline: '2026-08-18T00:00:00.000Z' });
    seedAttendanceRegistration(database, { eventId: 'event-1', contactId: 'contact-1', destination: 'Ucontact-1' });

    const scheduled = await upcomingReminders(database.binding, '2026-08-15T00:00:00.000Z');

    expect(scheduled.map((reminder) => [reminder.subject, reminder.sendOn, reminder.milestone])).toEqual([
      ['registration', '2026-08-15', 3],
      ['registration', '2026-08-17', 1],
      ['task', '2026-08-17', 3],
      ['task', '2026-08-20', 0],
      ['task', '2026-08-21', -1],
    ]);
    expect(scheduled[1]?.text).toContain('回答期限まであと1日');
    expect(scheduled[2]).toMatchObject({ subjectId: 'task-1', contactName: '山田花子', channel: 'line' });
    expect(scheduled[2]?.text).toContain('締め切りまであと3日');
    expect(scheduled[2]?.text).toContain('元メール：年次行事');
    expect(scheduled[2]?.text).toContain('指定口座へ送金する');
    expect(scheduled[3]?.text).toContain('本日が締め切りです');
    expect(scheduled[4]?.text).toContain('期限切れです');
    expect(await upcomingReminders(database.binding, '2026-08-15T00:00:00.000Z', 'task')).toHaveLength(3);
  });

  it('leaves out the reminders whose day has already passed and the people who already answered', async () => {
    const database = databaseWithTask();
    await expect(upcomingReminders(database.binding, daysBefore(DEADLINE, 1))).resolves.toMatchObject([{ milestone: 1 }, { milestone: 0 }, { milestone: -1 }]);
    await expect(upcomingReminders(databaseWithRegistration({ status: 'attending' }).binding, '2026-07-20T00:00:00.000Z')).resolves.toEqual([]);
    await expect(upcomingReminders(databaseWithTask({ completed: true }).binding, daysBefore(DEADLINE, 5))).resolves.toEqual([]);
  });

  it('masks the LINE destination it previews, as every other Account API does', async () => {
    const [reminder] = await upcomingReminders(databaseWithTask().binding, daysBefore(DEADLINE, 5));

    expect(reminder?.destination).not.toBe('Umember-1');
    expect(reminder?.destination.startsWith('Umemb')).toBe(true);
  });
});

describe('delivering a queued reminder', () => {
  const job: ClaimedJob = { id: 'job-1', kind: 'reminder', payload: '{}', attempts: 1, idempotencyKey: 'reminder-1' };

  const connect = async (kind: 'line' | 'discord'): Promise<void> => {
    const response = await app.fetch(fixture!.jsonRequest(
      `/api/organizations/organization-1/connections/${kind}`,
      kind === 'line' ? { channelAccessToken: 'line-token', channelSecret: 'line-secret' } : { botToken: 'bot-token', applicationPublicKey: 'a'.repeat(64) },
      'PUT',
    ), fixture!.environment);
    expect(response.status).toBe(200);
  };

  const seedLineContact = (): void => {
    fixture!.account.execute(
      `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
       VALUES ('contact-1', 'organization-1', '一郎', 'contact-1@example.com', 'active', '[]', ?, ?)`,
      CREATED_AT, CREATED_AT,
    );
    fixture!.account.execute(
      `INSERT INTO line_destinations (id, connection_id, destination_id, kind, display_name, status, source, discovered_at, updated_at)
       VALUES ('dest-1', (SELECT id FROM connections WHERE kind = 'line' LIMIT 1), 'Ucontact-1', 'user', '一郎', 'discovered', 'manual', ?, ?)`,
      CREATED_AT, CREATED_AT,
    );
    fixture!.account.execute(
      `INSERT INTO member_line_destinations (member_id, line_destination_id, created_at) VALUES ('contact-1', 'dest-1', ?)`,
      CREATED_AT,
    );
  };

  const seedDiscordContact = (): void => {
    fixture!.account.execute(
      `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
       VALUES ('contact-1', 'organization-1', '一郎', 'contact-1@example.com', 'active', '[]', ?, ?)`,
      CREATED_AT, CREATED_AT,
    );
    fixture!.account.execute(
      `INSERT INTO channel_handles
        (id, contact_id, channel, connection_id, external_id, reply_target, kind, display_name, source, is_primary, created_at, updated_at)
       VALUES ('handle-1', 'contact-1', 'discord', (SELECT id FROM connections WHERE kind = 'discord' LIMIT 1),
               'user-1', 'channel-9', 'single', '一郎', 'inbound', 1, ?, ?)`,
      CREATED_AT, CREATED_AT,
    );
  };

  const deliver = (providers: MemoryProviders, payload: Record<string, unknown>, at: string): Promise<void> =>
    reminderJobHandler(fixture!.environment, providers)({ database: fixture!.account.binding, accountId: 'organization-1', job, payload, at });

  const lineTexts = (providers: MemoryProviders): string[] => providers.transport.sends
    .filter(({ url }) => url.includes('api.line.me'))
    .flatMap(({ body }) => (body as { messages: Array<{ text: string }> }).messages.map(({ text }) => text));

  it('sends the Task milestone it was queued for, worded for the day it arrives', async () => {
    fixture = await createAutomationTestApp();
    await connect('line');
    seedLineContact();
    fixture.account.execute(
      `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', ?, 'processed')`, CREATED_AT,
    );
    fixture.account.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline, assignee_member_id, assignee_name, description, completed, created_at, updated_at)
       VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '参加費を振り込む', ?, 'contact-1', '一郎', '指定口座へ送金する', 0, ?, ?)`,
      DEADLINE, CREATED_AT, CREATED_AT,
    );
    const providers = memoryProviders();

    await deliver(providers, { subject: 'task', taskId: 'task-1', contactId: 'contact-1', milestone: 0 }, DEADLINE);

    expect(lineTexts(providers)).toHaveLength(1);
    expect(lineTexts(providers)[0]).toContain('本日が締め切りです');
    expect(lineTexts(providers)[0]).toContain('元メール：年次行事');
    expect(lineTexts(providers)[0]).toContain('指定口座へ送金する');
    expect(fixture.account.rows('SELECT outcome FROM deliveries')).toEqual([{ outcome: 'succeeded' }]);

    // The backlog guard: a milestone that is no longer today, a completed Task,
    // a Task handed to somebody else, and a Task that no longer exists all say nothing.
    await deliver(providers, { subject: 'task', taskId: 'task-1', contactId: 'contact-1', milestone: 3 }, DEADLINE);
    fixture.account.execute("UPDATE tasks SET completed = 1 WHERE id = 'task-1'");
    await deliver(providers, { subject: 'task', taskId: 'task-1', contactId: 'contact-1', milestone: 0 }, DEADLINE);
    fixture.account.execute("UPDATE tasks SET completed = 0, assignee_member_id = NULL WHERE id = 'task-1'");
    await deliver(providers, { subject: 'task', taskId: 'task-1', contactId: 'contact-1', milestone: 0 }, DEADLINE);
    await deliver(providers, { subject: 'task', taskId: 'task-missing', contactId: 'contact-1', milestone: 0 }, DEADLINE);
    expect(lineTexts(providers)).toHaveLength(1);
  });

  it('sends an attendance reminder only to a Registration still unanswered on the milestone day', async () => {
    fixture = await createAutomationTestApp();
    await connect('line');
    seedLineContact();
    seedScheduledEvent(fixture.account, { id: 'event-1', title: '例会', attendanceDeadline: DEADLINE });
    fixture.account.execute(
      "INSERT INTO attendance (event_id, member_id, status, comment, updated_at) VALUES ('event-1', 'contact-1', 'unanswered', '', ?)",
      CREATED_AT,
    );
    const providers = memoryProviders();

    await deliver(providers, { subject: 'registration', eventId: 'event-1', contactId: 'contact-1', milestone: 3 }, daysBefore(DEADLINE, 3));
    expect(lineTexts(providers)).toEqual([expect.stringContaining('回答期限まであと3日')]);

    await deliver(providers, { subject: 'registration', eventId: 'event-1', contactId: 'contact-1', milestone: 7 }, daysBefore(DEADLINE, 3));
    fixture.account.execute("UPDATE attendance SET status = 'attending' WHERE event_id = 'event-1'");
    await deliver(providers, { subject: 'registration', eventId: 'event-1', contactId: 'contact-1', milestone: 3 }, daysBefore(DEADLINE, 3));
    expect(lineTexts(providers)).toHaveLength(1);
  });

  it('delivers a reminder scheduled from outside on the Channel it named, Discord included', async () => {
    fixture = await createAutomationTestApp();
    await connect('discord');
    seedDiscordContact();
    const providers = memoryProviders();

    await deliver(providers, { subject: 'scheduled', contactId: 'contact-1', channel: 'discord', text: '明日9時です' }, DEADLINE);

    expect(providers.transport.sends.filter(({ url }) => url.includes('discord.com')).map(({ body }) => body)).toEqual([{ content: '明日9時です' }]);
    expect(fixture.account.rows('SELECT channel, outcome FROM deliveries')).toEqual([{ channel: 'discord', outcome: 'succeeded' }]);
  });

  it('fails loudly when the Contact holds no handle on that Channel, and refuses a payload that names nobody', async () => {
    fixture = await createAutomationTestApp();
    await connect('discord');
    seedDiscordContact();
    const providers = memoryProviders();

    await expect(deliver(providers, { subject: 'scheduled', contactId: 'contact-1', channel: 'line', text: '明日9時です' }, DEADLINE)).rejects.toThrow(/LINE/u);
    await expect(deliver(providers, { subject: 'scheduled', text: '明日9時です' }, DEADLINE)).rejects.toThrow(/Contact/u);
    await expect(deliver(providers, { subject: 'task', contactId: 'contact-1', milestone: 0 }, DEADLINE)).rejects.toThrow(/Task/u);
  });

  it('records a reminder scheduled from outside as a Job due at the stated time', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);

    await expect(scheduleReminder(database.binding, { contactId: 'contact-1', channel: 'line', text: '明日9時', at: '2099-01-01T00:00:00.000Z' }))
      .resolves.toEqual({ scheduled: true, at: '2099-01-01T00:00:00.000Z', contactId: 'contact-1' });
    await expect(scheduleReminder(database.binding, { contactId: 'contact-1', channel: 'fax', text: '明日9時', at: '2099-01-01T00:00:00.000Z' }))
      .rejects.toThrow(/fax/u);

    expect(database.rows('SELECT kind, available_at, idempotency_key FROM jobs')).toEqual([{
      kind: 'reminder',
      available_at: '2099-01-01T00:00:00.000Z',
      idempotency_key: 'reminder:scheduled:contact-1:2099-01-01T00:00:00.000Z:明日9時',
    }]);
    expect(await claimDueJobs(database.binding, '2098-12-31T00:00:00.000Z')).toEqual([]);
  });
});

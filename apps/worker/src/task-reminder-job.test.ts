import { afterEach, describe, expect, it, vi } from 'vitest';

import { app as api } from './api';
import { taskReminderJobHandler } from './task-reminder-job';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import type { ClaimedJob } from './jobs';

const CREATED_AT = '2026-08-01T00:00:00.000Z';
const DEADLINE = '2026-08-20T00:00:00.000Z';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

const job: ClaimedJob = {
  id: 'job-1',
  kind: 'task_reminder',
  payload: '{}',
  attempts: 1,
  idempotencyKey: 'task-reminder:task-1:0',
};

const seedTask = (app: TestApp, input: { completed?: boolean; assignee?: string | null } = {}): void => {
  app.account.execute(
    `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
     VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', ?, 'processed')`,
    CREATED_AT,
  );
  app.account.execute(
    `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline,
       assignee_member_id, assignee_name, description, completed, created_at, updated_at)
     VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '参加費を振り込む', ?, ?, '一郎', '指定口座へ送金する', ?, ?, ?)`,
    DEADLINE,
    input.assignee === undefined ? 'contact-1' : input.assignee,
    input.completed ? 1 : 0,
    CREATED_AT,
    CREATED_AT,
  );
};

/** A real LINE Connection, so the credential this handler unwraps is a real envelope. */
const connectLine = async (app_: TestApp): Promise<void> => {
  const response = await api.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/connections/line',
    { channelAccessToken: 'line-token', channelSecret: 'line-secret' },
    'PUT',
  ), app_.environment);
  expect(response.status).toBe(200);
};

const seedLineContact = (app_: TestApp): void => {
  app_.account.execute(
    `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
     VALUES ('contact-1', 'organization-1', '一郎', 'contact-1@example.com', 'active', '[]', ?, ?)`,
    CREATED_AT,
    CREATED_AT,
  );
  app_.account.execute(
    `INSERT INTO line_destinations (id, connection_id, destination_id, kind, display_name, status, source, discovered_at, updated_at)
     VALUES ('dest-1', (SELECT id FROM connections WHERE kind = 'line' LIMIT 1), 'Ucontact-1', 'user', '一郎', 'discovered', 'manual', ?, ?)`,
    CREATED_AT,
    CREATED_AT,
  );
  app_.account.execute(
    `INSERT INTO member_line_destinations (member_id, line_destination_id, created_at)
     VALUES ('contact-1', 'dest-1', ?)`,
    CREATED_AT,
  );
};

const deliver = async (app: TestApp, payload: Record<string, unknown>, at: string): Promise<void> =>
  await taskReminderJobHandler(app.environment)({
    database: app.account.binding,
    accountId: 'organization-1',
    job,
    payload,
    at,
  });

describe('Task reminder delivery', () => {
  it('sends the milestone it was queued for, worded for the day it arrives', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedLineContact(fixture);
    seedTask(fixture);
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await deliver(fixture, { taskId: 'task-1', contactId: 'contact-1', milestone: 0 }, DEADLINE);

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('本日が締め切りです');
    expect(fixture.account.rows('SELECT outcome FROM deliveries')).toEqual([{ outcome: 'succeeded' }]);
  });

  /**
   * The backlog this guard exists for: nothing handled this kind before, so every
   * Account holds rows queued on milestones that have long passed.
   */
  it('says nothing for a milestone that is no longer today', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedLineContact(fixture);
    seedTask(fixture);
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async () => {
      sent.push('sent');
      return new Response('{}', { status: 200 });
    });

    await deliver(fixture, { taskId: 'task-1', contactId: 'contact-1', milestone: 3 }, DEADLINE);

    expect(sent).toEqual([]);
    expect(fixture.account.rows('SELECT outcome FROM deliveries')).toEqual([]);
  });

  it('says nothing about a Task completed since it was queued', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedLineContact(fixture);
    seedTask(fixture, { completed: true });
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async () => {
      sent.push('sent');
      return new Response('{}', { status: 200 });
    });

    await deliver(fixture, { taskId: 'task-1', contactId: 'contact-1', milestone: 0 }, DEADLINE);

    expect(sent).toEqual([]);
  });

  it('says nothing to a Contact the Task was taken away from', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedLineContact(fixture);
    seedTask(fixture, { assignee: null });
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async () => {
      sent.push('sent');
      return new Response('{}', { status: 200 });
    });

    await deliver(fixture, { taskId: 'task-1', contactId: 'contact-1', milestone: 0 }, DEADLINE);

    expect(sent).toEqual([]);
  });

  it('says nothing about a Task that no longer exists', async () => {
    fixture = await createAutomationTestApp();
    await connectLine(fixture);
    seedLineContact(fixture);

    await expect(deliver(fixture, { taskId: 'task-1', contactId: 'contact-1', milestone: 0 }, DEADLINE))
      .resolves.toBeUndefined();
  });

  it('refuses a payload that names no Task', async () => {
    fixture = await createAutomationTestApp();

    await expect(deliver(fixture, { contactId: 'contact-1', milestone: 0 }, DEADLINE)).rejects.toThrow(/Task/u);
  });
});

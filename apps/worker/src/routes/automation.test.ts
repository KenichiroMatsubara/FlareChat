import { afterEach, describe, expect, it } from 'vitest';

import { automationRoutes } from './automation';
import { createTestApp, type TestApp } from '../../test/app';
import { seedContact } from '../../test/seed';
import { enqueueDueReminders } from '../reminders';

let fixture: TestApp | undefined;

afterEach(() => fixture?.close());

describe('Account Automation routes', () => {
  it('reads Automation Inbox behavior for the authenticated Account', async () => {
    fixture = createTestApp();

    const response = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/automation'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { email: 'owner@example.com', displayName: 'Owner', enabled: true },
    });
  });

  it('reports an Inbox that needs reauthentication so the dashboard can offer recovery', async () => {
    fixture = createTestApp();
    fixture.account.execute(
      "UPDATE google_connections SET status = 'reauthentication_required', last_error = 'Token has been expired or revoked.' WHERE kind = 'automation_inbox'",
    );

    const response = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/automation'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        status: 'reauthentication_required',
        lastError: 'Token has been expired or revoked.',
      },
    });
  });

  it('does not enable Automation until an AI Connection is configured', async () => {
    fixture = createTestApp();
    fixture.account.execute("UPDATE google_connections SET enabled = 0 WHERE kind = 'automation_inbox'");

    const response = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/automation/enabled', { enabled: true }),
      fixture.environment,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { message: '自動化を有効にする前に OpenAI 互換 API を設定してください。' },
    });
  });

  it('answers the product default Attachment Folder Path until an Account saves its own', async () => {
    fixture = createTestApp();

    const initial = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/attachment-folder'),
      fixture.environment,
    );
    await expect(initial.json()).resolves.toMatchObject({ data: { path: 'Mail Automation' } });

    const saved = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/attachment-folder', { path: '/会計 2026//添付/' }, 'PUT'),
      fixture.environment,
    );

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ data: { path: '会計 2026/添付' } });
  });

  it('answers the default Event Response Window until an Account sets its own', async () => {
    fixture = createTestApp();

    const initial = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/response-window'),
      fixture.environment,
    );
    await expect(initial.json()).resolves.toMatchObject({ data: { days: 60 } });

    const saved = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/response-window', { days: 21 }, 'PUT'),
      fixture.environment,
    );
    const reread = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/response-window'),
      fixture.environment,
    );

    expect(saved.status).toBe(200);
    await expect(reread.json()).resolves.toMatchObject({ data: { days: 21 } });
  });

  it('refuses an Event Response Window of no days, which would discard every response', async () => {
    fixture = createTestApp();

    const response = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/response-window', { days: 0 }, 'PUT'),
      fixture.environment,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: '日数は1〜365日の範囲で入力してください。' },
    });
  });

  /**
   * The whole point of the switch: an operator flips it in the GUI and reminders
   * actually start being queued. Asserting the stored value alone would pass
   * even if nothing read it.
   */
  it('queues no Task reminder until the switch is turned on through the API, then queues one', async () => {
    fixture = createTestApp();
    seedContact(fixture.account, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember-1' });
    fixture.account.execute(
      `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')`,
    );
    fixture.account.execute(
      `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline,
         assignee_member_id, assignee_name, description, completed, created_at, updated_at)
       VALUES ('task-1', 'organization-1', 'source-1', '年次行事', '参加費を振り込む', '2026-08-20T00:00:00.000Z',
               'member-1', '山田花子', '送金する', 0, '2026-08-01', '2026-08-01')`,
    );
    const threeDaysBefore = '2026-08-17T00:00:00.000Z';

    await expect(enqueueDueReminders(fixture.account.binding, threeDaysBefore)).resolves.toBe(0);

    const turnedOn = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/task-reminders', { enabled: true }, 'PUT'),
      fixture.environment,
    );
    expect(turnedOn.status).toBe(200);

    await expect(enqueueDueReminders(fixture.account.binding, threeDaysBefore)).resolves.toBe(1);

    await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/task-reminders', { enabled: false }, 'PUT'),
      fixture.environment,
    );
    await expect(enqueueDueReminders(fixture.account.binding, '2026-08-19T00:00:00.000Z')).resolves.toBe(0);
  });

  it('reports both reminder kinds as off until an Account turns them on', async () => {
    fixture = createTestApp();

    const task = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/task-reminders'),
      fixture.environment,
    );
    const attendance = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/attendance-reminders'),
      fixture.environment,
    );

    await expect(task.json()).resolves.toMatchObject({ data: { enabled: false } });
    await expect(attendance.json()).resolves.toMatchObject({ data: { enabled: false, days: [7, 3, 1] } });
  });

  it('turns reminders on without being told the cadence again', async () => {
    fixture = createTestApp();
    await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/task-reminders', { days: [5] }, 'PUT'),
      fixture.environment,
    );

    const enabled = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/task-reminders', { enabled: true }, 'PUT'),
      fixture.environment,
    );

    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({ data: { enabled: true, days: [5] } });
  });

  it('answers the default attendance milestones until an Account chooses its own', async () => {
    fixture = createTestApp();

    const saved = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/attendance-reminders', { days: [1, 14, 0, 1] }, 'PUT'),
      fixture.environment,
    );
    const reread = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/attendance-reminders'),
      fixture.environment,
    );

    expect(saved.status).toBe(200);
    await expect(reread.json()).resolves.toMatchObject({ data: { enabled: false, days: [14, 1, 0] } });
  });

  it('refuses an attendance milestone past the deadline, which can no longer be answered', async () => {
    fixture = createTestApp();

    const rejected = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/attendance-reminders', { days: [-1] }, 'PUT'),
      fixture.environment,
    );

    const reread = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/attendance-reminders'),
      fixture.environment,
    );

    expect(rejected.status).toBe(400);
    await expect(reread.json()).resolves.toMatchObject({ data: { days: [7, 3, 1] } });
  });

  it('turns the attendance reminders on and off', async () => {
    fixture = createTestApp();

    const on = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/attendance-reminders', { enabled: true }, 'PUT'),
      fixture.environment,
    );
    await expect(on.json()).resolves.toMatchObject({ data: { enabled: true } });

    await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/attendance-reminders', { enabled: false }, 'PUT'),
      fixture.environment,
    );
    const reread = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/attendance-reminders'),
      fixture.environment,
    );

    await expect(reread.json()).resolves.toMatchObject({ data: { enabled: false } });
  });

  it('answers the default Task Reminder Milestones until an Account chooses its own', async () => {
    fixture = createTestApp();

    const initial = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/task-reminders'),
      fixture.environment,
    );
    await expect(initial.json()).resolves.toMatchObject({ data: { days: [7, 3, 1, 0, -1] } });

    const saved = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/task-reminders', { days: [1, 14, 0, 1] }, 'PUT'),
      fixture.environment,
    );
    const reread = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/task-reminders'),
      fixture.environment,
    );

    expect(saved.status).toBe(200);
    await expect(reread.json()).resolves.toMatchObject({ data: { days: [14, 1, 0] } });
  });

  it('accepts no Task Reminder Milestones at all as reminding never', async () => {
    fixture = createTestApp();

    const saved = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/task-reminders', { days: [] }, 'PUT'),
      fixture.environment,
    );
    const reread = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/task-reminders'),
      fixture.environment,
    );

    expect(saved.status).toBe(200);
    await expect(reread.json()).resolves.toMatchObject({ data: { days: [] } });
  });

  it('answers what the configured milestones will send, so a cadence can be checked', async () => {
    fixture = createTestApp();

    const response = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/reminders/schedule'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: expect.any(Array) });
  });

  it('refuses a Task Reminder Milestone too far past the deadline to still be a reminder', async () => {
    fixture = createTestApp();

    const response = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/task-reminders', { days: [-31] }, 'PUT'),
      fixture.environment,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'リマインドする日は締め切りの365日前から30日後までの範囲で入力してください。' },
    });
  });

  it('refuses an empty Attachment Folder Path, because an empty path is the Drive root', async () => {
    fixture = createTestApp();

    const response = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/attachment-folder', { path: '   ' }, 'PUT'),
      fixture.environment,
    );

    expect(response.status).toBe(400);
  });
});

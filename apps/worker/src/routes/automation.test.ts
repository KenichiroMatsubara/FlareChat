import { afterEach, describe, expect, it } from 'vitest';

import { automationRoutes } from './automation';
import { createTestApp, type TestApp } from '../../test/app';

let fixture: TestApp | undefined;

afterEach(() => fixture?.close());

describe('Organization Automation routes', () => {
  it('reads Automation Inbox behavior for the authenticated Organization', async () => {
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
    fixture.organization.execute(
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
    fixture.organization.execute("UPDATE google_connections SET enabled = 0 WHERE kind = 'automation_inbox'");

    const response = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/automation/enabled', { enabled: true }),
      fixture.environment,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { message: '自動化を有効にする前に OpenAI 互換 API を設定してください。' },
    });
  });

  it('answers the product default Attachment Folder Path until an Organization saves its own', async () => {
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

  it('answers the default Event Response Window until an Organization sets its own', async () => {
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

  it('refuses an empty Attachment Folder Path, because an empty path is the Drive root', async () => {
    fixture = createTestApp();

    const response = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/attachment-folder', { path: '   ' }, 'PUT'),
      fixture.environment,
    );

    expect(response.status).toBe(400);
  });
});

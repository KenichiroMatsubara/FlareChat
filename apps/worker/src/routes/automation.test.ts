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

  it('refuses an empty Attachment Folder Path, because an empty path is the Drive root', async () => {
    fixture = createTestApp();

    const response = await automationRoutes.fetch(
      fixture.jsonRequest('/organizations/organization-1/attachment-folder', { path: '   ' }, 'PUT'),
      fixture.environment,
    );

    expect(response.status).toBe(400);
  });
});

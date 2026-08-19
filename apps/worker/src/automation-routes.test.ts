import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

const seedPromptAndList = (app_: TestApp): void => {
  app_.account.execute(
    `INSERT INTO prompts (id, organization_id, name, instructions, current_revision, published, created_at, updated_at)
     VALUES ('prompt-1', 'organization-1', 'morning', '未回答の Contact にリマインドしてください。', 1, 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  app_.account.execute(
    `INSERT INTO contact_lists (id, account_id, name, description, created_at, updated_at)
     VALUES ('list-1', 'organization-1', 'reachable', '', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
};

const save = async (app_: TestApp, body: Record<string, unknown>): Promise<Response> =>
  app.fetch(app_.jsonRequest('/api/organizations/organization-1/automations/automation-1', body, 'PUT'), app_.environment);

const valid = {
  name: '朝の確認',
  promptId: 'prompt-1',
  contactListId: 'list-1',
  schedule: 'daily 09:00',
  offsetMinutes: 540,
  executionMode: 'unattended',
  suppressionWindow: 'day',
  state: 'active',
  tools: ['query_attendance', 'channel.send'],
};

describe('Automation configuration', () => {
  it('saves an Automation and gives it the next time it is due', async () => {
    fixture = await createAutomationTestApp();
    seedPromptAndList(fixture);

    const response = await save(fixture, valid);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { state: 'active' } });
    const rows = fixture.account.rows<{ state: string; next_run_at: string | null }>('SELECT state, next_run_at FROM automations');
    expect(rows[0]?.state).toBe('active');
    expect(rows[0]?.next_run_at).toBeTruthy();
  });

  it('refuses a schedule it cannot run rather than storing it', async () => {
    fixture = await createAutomationTestApp();
    seedPromptAndList(fixture);

    const response = await save(fixture, { ...valid, schedule: '*/5 * * * *' });

    expect(response.status).toBe(400);
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM automations')).toEqual([{ count: 0 }]);
  });

  it('refuses to grant a send without naming who may be reached', async () => {
    fixture = await createAutomationTestApp();
    seedPromptAndList(fixture);

    const response = await save(fixture, { ...valid, contactListId: null });

    expect(response.status).toBe(400);
    expect(fixture.account.rows<{ count: number }>('SELECT COUNT(*) AS count FROM automations')).toEqual([{ count: 0 }]);
  });

  it('leaves a draft Automation with no due time, so it cannot fire', async () => {
    fixture = await createAutomationTestApp();
    seedPromptAndList(fixture);

    await save(fixture, { ...valid, state: 'draft' });

    expect(fixture.account.rows<{ next_run_at: string | null }>('SELECT next_run_at FROM automations'))
      .toEqual([{ next_run_at: null }]);
  });

  it('records the Tool Grant it was given and replaces it on the next save', async () => {
    fixture = await createAutomationTestApp();
    seedPromptAndList(fixture);
    await save(fixture, valid);

    await save(fixture, { ...valid, tools: ['query_attendance'] });

    expect(fixture.account.rows<{ tool: string }>('SELECT tool FROM automation_tools ORDER BY tool'))
      .toEqual([{ tool: 'query_attendance' }]);
  });

  it('lists what it stored', async () => {
    fixture = await createAutomationTestApp();
    seedPromptAndList(fixture);
    await save(fixture, valid);

    const response = await app.fetch(fixture.request('/api/organizations/organization-1/automations'), fixture.environment);

    await expect(response.json()).resolves.toMatchObject({
      data: [{ name: '朝の確認', schedule: 'daily 09:00', offsetMinutes: 540, tools: ['channel.send', 'query_attendance'] }],
    });
  });
});

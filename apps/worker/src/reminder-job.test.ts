import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import { reminderJobHandler } from './reminder-job';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';
import type { ClaimedJob } from './jobs';

const CREATED_AT = '2026-08-01T00:00:00.000Z';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

const job: ClaimedJob = {
  id: 'job-1',
  kind: 'mcp.reminder',
  payload: '{}',
  attempts: 1,
  idempotencyKey: 'reminder-1',
};

const connectDiscord = async (app_: TestApp): Promise<void> => {
  const response = await app.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/connections/discord',
    { botToken: 'bot-token', applicationPublicKey: 'a'.repeat(64) },
    'PUT',
  ), app_.environment);
  expect(response.status).toBe(200);
};

const seedDiscordContact = (app_: TestApp): void => {
  app_.account.execute(
    `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
     VALUES ('contact-1', 'organization-1', '一郎', 'contact-1@example.com', 'active', '[]', ?, ?)`,
    CREATED_AT,
    CREATED_AT,
  );
  app_.account.execute(
    `INSERT INTO channel_handles
      (id, contact_id, channel, connection_id, external_id, reply_target, kind, display_name, source, is_primary, created_at, updated_at)
     VALUES ('handle-1', 'contact-1', 'discord', (SELECT id FROM connections WHERE kind = 'discord' LIMIT 1),
             'user-1', 'channel-9', 'single', '一郎', 'inbound', 1, ?, ?)`,
    CREATED_AT,
    CREATED_AT,
  );
};

describe('scheduled reminder delivery', () => {
  it('delivers on the Channel the reminder named, Discord included', async () => {
    fixture = await createAutomationTestApp();
    await connectDiscord(fixture);
    seedDiscordContact(fixture);
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'discord-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await reminderJobHandler(fixture.environment)({
      database: fixture.account.binding,
      accountId: 'organization-1',
      job,
      payload: { contactId: 'contact-1', channel: 'discord', text: '明日9時です' },
    });

    expect(sent).toEqual([{ content: '明日9時です' }]);
    expect(fixture.account.rows('SELECT channel, outcome FROM deliveries')).toEqual([{ channel: 'discord', outcome: 'succeeded' }]);
  });

  it('fails loudly when the Contact holds no handle on that Channel', async () => {
    fixture = await createAutomationTestApp();
    await connectDiscord(fixture);
    seedDiscordContact(fixture);

    await expect(reminderJobHandler(fixture.environment)({
      database: fixture.account.binding,
      accountId: 'organization-1',
      job,
      payload: { contactId: 'contact-1', channel: 'line', text: '明日9時です' },
    })).rejects.toThrow(/LINE/u);
  });

  it('refuses a payload that names no Contact', async () => {
    fixture = await createAutomationTestApp();

    await expect(reminderJobHandler(fixture.environment)({
      database: fixture.account.binding,
      accountId: 'organization-1',
      job,
      payload: { text: '明日9時です' },
    })).rejects.toThrow(/Contact/u);
  });
});

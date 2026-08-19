import { afterEach, describe, expect, it, vi } from 'vitest';

import { advanceAutomation, automationWriteHandlers, dueAutomations, runAutomation, type DueAutomation } from './automation-run';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import type { ChatModelPort } from './chat';
import type { McpServerPorts } from './mcp-server';

const openDatabases: TestD1Database[] = [];

const accountDatabase = (): TestD1Database => {
  const database = createMigratedTestD1('organization');
  openDatabases.push(database);
  return database;
};

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

const at = new Date('2026-08-18T09:00:00.000Z');

const seedAutomation = (database: TestD1Database, overrides: { state?: string; nextRunAt?: string; window?: string } = {}): void => {
  database.execute(
    `INSERT INTO prompts (id, organization_id, name, instructions, current_revision, published, created_at, updated_at)
     VALUES ('prompt-1', 'organization-1', 'morning', '未回答の Contact にリマインドしてください。', 1, 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  database.execute(
    `INSERT INTO contact_lists (id, account_id, name, description, created_at, updated_at)
     VALUES ('list-1', 'organization-1', 'reachable', '', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  database.execute(
    `INSERT INTO members (id, organization_id, name, email, state, tags, created_at, updated_at)
     VALUES ('contact-1', 'organization-1', '田中', 'tanaka@example.com', 'active', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  database.execute(`INSERT INTO contact_list_members (list_id, contact_id) VALUES ('list-1', 'contact-1')`);
  database.execute(
    `INSERT INTO automations (id, account_id, name, prompt_id, contact_list_id, schedule, offset_minutes, execution_mode, suppression_window, state, next_run_at, created_at, updated_at)
     VALUES ('automation-1', 'organization-1', '朝の確認', 'prompt-1', 'list-1', 'daily 09:00', 0, 'unattended', '${overrides.window ?? 'day'}', '${overrides.state ?? 'active'}', '${overrides.nextRunAt ?? '2026-08-18T09:00:00.000Z'}', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  );
  database.execute(`INSERT INTO automation_tools (automation_id, tool) VALUES ('automation-1', 'query_attendance')`);
  database.execute(`INSERT INTO automation_tools (automation_id, tool) VALUES ('automation-1', 'channel.send')`);
};

const model = (turns: Array<{ content: string; toolCalls?: Array<{ name: string; arguments: string }> }>): ChatModelPort => {
  let index = 0;
  return {
    complete: async () => {
      const turn = turns[index] ?? turns[turns.length - 1];
      index += 1;
      return {
        model: 'test-model',
        content: turn?.content ?? '',
        toolCalls: (turn?.toolCalls ?? []).map((call, position) => ({ id: `call-${position}`, name: call.name, arguments: call.arguments })),
        totalTokens: 5,
      };
    },
  };
};

const ports = (): McpServerPorts => ({
  searchContacts: vi.fn(async () => []),
  sendToContact: vi.fn(async () => ({ delivered: true })),
  scheduleReminder: vi.fn(async () => ({ scheduled: true })),
});

const memorySuppression = () => {
  const held = new Set<string>();
  return { held, check: async (key: string) => held.has(key), record: async (key: string) => { held.add(key); } };
};

const automation = (overrides: Partial<DueAutomation> = {}): DueAutomation => ({
  id: 'automation-1',
  name: '朝の確認',
  instructions: '未回答の Contact にリマインドしてください。',
  contactListId: 'list-1',
  schedule: 'daily 09:00',
  offsetMinutes: 0,
  executionMode: 'unattended',
  suppressionWindow: 'day',
  grant: ['query_attendance', 'channel.send'],
  ...overrides,
});

const noServers = { servers: [], fetch: (async () => new Response('{}')) as never };

describe('finding due Automations', () => {
  it('returns an active Automation whose time has arrived', async () => {
    const database = accountDatabase();
    seedAutomation(database);

    const due = await dueAutomations({ database: database.binding, at });

    expect(due.map((entry) => entry.name)).toEqual(['朝の確認']);
    expect(due[0]?.grant).toEqual(['channel.send', 'query_attendance']);
  });

  it('leaves an Automation that is not active alone', async () => {
    const database = accountDatabase();
    seedAutomation(database, { state: 'draft' });

    await expect(dueAutomations({ database: database.binding, at })).resolves.toEqual([]);
  });

  it('leaves an Automation whose time has not arrived', async () => {
    const database = accountDatabase();
    seedAutomation(database, { nextRunAt: '2026-08-19T09:00:00.000Z' });

    await expect(dueAutomations({ database: database.binding, at })).resolves.toEqual([]);
  });

  it('moves an Automation forward before it could be picked up twice', async () => {
    const database = accountDatabase();
    seedAutomation(database);

    const next = await advanceAutomation({
      database: database.binding, automationId: 'automation-1', schedule: 'daily 09:00', offsetMinutes: 0, at,
    });

    expect(next).toBe('2026-08-19T09:00:00.000Z');
    await expect(dueAutomations({ database: database.binding, at })).resolves.toEqual([]);
  });
});

describe('running an Automation', () => {
  it('records the run as a Rule Run carrying no Source Message', async () => {
    const database = accountDatabase();
    seedAutomation(database);

    const outcome = await runAutomation({
      database: database.binding,
      automation: automation(),
      ...noServers,
      model: model([{ content: '未回答はいませんでした。' }]),
      connection: { apiKey: 'k', baseUrl: 'https://ai.example.com', model: 'test-model' },
      readHandlers: {},
      ports: ports(),
      suppression: memorySuppression(),
      at,
    });

    expect(outcome.status).toBe('completed');
    expect(database.rows<{ intent: string; status: string; source_message_id: string | null }>(
      'SELECT intent, status, source_message_id FROM rule_runs',
    )).toEqual([{ intent: 'chat', status: 'completed', source_message_id: null }]);
    expect(database.rows<{ status: string; output: string }>('SELECT status, output FROM automation_runs'))
      .toEqual([{ status: 'completed', output: '未回答はいませんでした。' }]);
  });

  it('sends to a Contact inside its list', async () => {
    const database = accountDatabase();
    seedAutomation(database);
    const sending = ports();

    await runAutomation({
      database: database.binding,
      automation: automation(),
      ...noServers,
      model: model([
        { content: '', toolCalls: [{ name: 'channel.send', arguments: '{"contactId":"contact-1","channel":"line","text":"明日9時です"}' }] },
        { content: '送りました。' },
      ]),
      connection: { apiKey: 'k', baseUrl: 'https://ai.example.com', model: 'test-model' },
      readHandlers: {},
      ports: sending,
      suppression: memorySuppression(),
      at,
    });

    expect(sending.sendToContact).toHaveBeenCalledWith({ contactId: 'contact-1', channel: 'line', text: '明日9時です' });
  });

  it('records a failed run rather than leaving it running forever', async () => {
    const database = accountDatabase();
    seedAutomation(database);

    const outcome = await runAutomation({
      database: database.binding,
      automation: automation(),
      ...noServers,
      model: { complete: async () => { throw new Error('model unavailable'); } },
      connection: { apiKey: 'k', baseUrl: 'https://ai.example.com', model: 'test-model' },
      readHandlers: {},
      ports: ports(),
      suppression: memorySuppression(),
      at,
    });

    expect(outcome.status).toBe('failed');
    expect(database.rows<{ status: string; error: string }>('SELECT status, error FROM automation_runs'))
      .toEqual([{ status: 'failed', error: 'model unavailable' }]);
    expect(database.rows<{ status: string }>('SELECT status FROM rule_runs')).toEqual([{ status: 'failed' }]);
  });
});

describe('what an Automation may write', () => {
  const handlers = (overrides: { window?: 'none' | 'day' } = {}) => {
    const suppression = memorySuppression();
    const sending = ports();
    return {
      sending,
      suppression,
      handlers: automationWriteHandlers({
        ports: sending,
        contactIds: ['contact-1'],
        suppression,
        scope: 'automation-1',
        window: overrides.window ?? 'day',
        at,
      }),
    };
  };

  it('refuses a Contact outside its list without reaching the Channel', async () => {
    const { handlers: written, sending } = handlers();

    const result = await written['channel.send']?.({ contactId: 'contact-9', channel: 'line', text: 'hi' });

    expect(result).toMatchObject({ isError: true });
    expect(sending.sendToContact).not.toHaveBeenCalled();
  });

  it('holds the same message it already sent this window', async () => {
    const { handlers: written, sending } = handlers();
    const call = { contactId: 'contact-1', channel: 'line', text: '同じ内容' };

    await written['channel.send']?.(call);
    const second = await written['channel.send']?.(call);

    expect(sending.sendToContact).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ suppressed: true });
  });

  it('sends the repeat when the Account switched suppression off', async () => {
    const { handlers: written, sending } = handlers({ window: 'none' });
    const call = { contactId: 'contact-1', channel: 'line', text: '毎回送る' };

    await written['channel.send']?.(call);
    await written['channel.send']?.(call);

    expect(sending.sendToContact).toHaveBeenCalledTimes(2);
  });

  it('refuses a reminder in the past instead of sending it now', async () => {
    const { handlers: written, sending } = handlers();

    const result = await written['reminder.schedule']?.({ contactId: 'contact-1', channel: 'line', text: 'hi', at: '2026-08-17T00:00:00.000Z' });

    expect(result).toMatchObject({ isError: true });
    expect(sending.scheduleReminder).not.toHaveBeenCalled();
  });
});

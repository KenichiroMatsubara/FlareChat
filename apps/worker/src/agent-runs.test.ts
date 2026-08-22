import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENT_TOKEN_CEILING, AGENT_TOOL_WRITE_CAPS, runAgent, runReadOnlyAgent } from './agent-runs';
import { createMigratedTestD1, type TestD1Database } from '../test/d1';

let database: TestD1Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('read-only Agent Rule bounds', () => {
  it('aborts a run that exceeds the named token ceiling', async () => {
    database = createMigratedTestD1('organization');
    await expect(runReadOnlyAgent({
      database: database.binding,
      model: { complete: async () => ({
        model: 'test-model',
        content: 'Too large',
        toolCalls: [],
        totalTokens: AGENT_TOKEN_CEILING + 1,
      }) },
      connection: { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' },
      prompt: 'Read only.',
      source: { id: 'source-1', sender: 'sender@example.com', subject: 'Notice', body: 'Body', attachments: [] },
    })).rejects.toThrow(`Agent Rule token ceiling of ${AGENT_TOKEN_CEILING} was exceeded.`);
  });
});

describe('Agent Rule writes', () => {
  it('completes approval mode without an external effect and returns the exact planned arguments', async () => {
    database = createMigratedTestD1('organization');
    const sendLine = vi.fn();
    let turn = 0;

    const result = await runAgent({
      database: database.binding,
      runId: 'run-1',
      agentRuleId: 'agent-rule-1',
      executionMode: 'approval',
      permittedLineDestinations: ['line-user-1'],
      permittedRecipientDestinations: [],
      writes: { sendLine, createScheduledEvent: vi.fn(), sendEmailSummary: vi.fn() },
      model: { complete: async () => turn++ === 0 ? {
        model: 'test-model',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'send_line_message', arguments: '{"destination":"line-user-1","message":"Bring shoes."}' }],
        totalTokens: 10,
      } : { model: 'test-model', content: 'Done', toolCalls: [], totalTokens: 5 } },
      connection: { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' },
      prompt: 'Notify participants.',
      source: { id: 'source-1', sender: 'sender@example.com', subject: 'Practice', body: 'Body', attachments: [] },
    });

    expect(result.output).toBe('Done');
    expect(sendLine).not.toHaveBeenCalled();
    expect(result.plannedActions).toEqual([{
      tool: 'send_line_message',
      arguments: { destination: 'line-user-1', message: 'Bring shoes.' },
    }]);
  });

  it('refuses an out-of-set destination at the tool seam and records the refusal for the Run Transcript', async () => {
    database = createMigratedTestD1('organization');
    const run = runAgent({
      database: database.binding,
      runId: 'run-2',
      agentRuleId: 'agent-rule-1',
      executionMode: 'approval',
      permittedLineDestinations: ['line-user-1'],
      permittedRecipientDestinations: [],
      writes: { sendLine: vi.fn(), createScheduledEvent: vi.fn(), sendEmailSummary: vi.fn() },
      model: { complete: async () => ({
        model: 'test-model', content: '', totalTokens: 1,
        toolCalls: [{ id: 'call-outside', name: 'send_line_message', arguments: '{"destination":"line-user-outside","message":"No."}' }],
      }) },
      connection: { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' },
      prompt: 'Notify participants.',
      source: { id: 'source-2', sender: 'sender@example.com', subject: 'Practice', body: 'Body', attachments: [] },
    });

    await expect(run).rejects.toMatchObject({
      message: 'Destination line-user-outside is not permitted for send_line_message.',
      result: { messages: expect.arrayContaining([expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-outside',
        content: expect.stringContaining('not permitted'),
      })]) },
    });
  });

  it('aborts when send_line_message exceeds its own named per-run cap', async () => {
    database = createMigratedTestD1('organization');
    const toolCalls = Array.from({ length: AGENT_TOOL_WRITE_CAPS.send_line_message + 1 }, (_, index) => ({
      id: `line-${index}`,
      name: 'send_line_message' as const,
      arguments: `{"destination":"line-user-1","message":"Message ${index}"}`,
    }));

    await expect(runAgent({
      database: database.binding, runId: 'run-cap', agentRuleId: 'agent-rule-1', executionMode: 'approval',
      permittedLineDestinations: ['line-user-1'], permittedRecipientDestinations: [],
      writes: { sendLine: vi.fn(), createScheduledEvent: vi.fn(), sendEmailSummary: vi.fn() },
      model: { complete: async () => ({ model: 'test-model', content: '', toolCalls, totalTokens: 1 }) },
      connection: { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' },
      prompt: 'Notify participants.',
      source: { id: 'source-cap', sender: 'sender@example.com', subject: 'Practice', body: 'Body', attachments: [] },
    })).rejects.toThrow(`Agent Rule send_line_message call cap of ${AGENT_TOOL_WRITE_CAPS.send_line_message} was exceeded.`);
  });

  it('aborts when create_scheduled_event exceeds its distinct named per-run cap', async () => {
    database = createMigratedTestD1('organization');
    const toolCalls = Array.from({ length: AGENT_TOOL_WRITE_CAPS.create_scheduled_event + 1 }, (_, index) => ({
      id: `event-${index}`,
      name: 'create_scheduled_event' as const,
      arguments: `{"destination":"guest@example.com","title":"Event ${index}","startsAt":"2026-08-10T09:00:00+09:00","endsAt":"2026-08-10T10:00:00+09:00"}`,
    }));

    await expect(runAgent({
      database: database.binding, runId: 'run-event-cap', agentRuleId: 'agent-rule-1', executionMode: 'approval',
      permittedLineDestinations: [], permittedRecipientDestinations: ['guest@example.com'],
      writes: { sendLine: vi.fn(), createScheduledEvent: vi.fn(), sendEmailSummary: vi.fn() },
      model: { complete: async () => ({ model: 'test-model', content: '', toolCalls, totalTokens: 1 }) },
      connection: { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' },
      prompt: 'Schedule.', source: { id: 'source-event-cap', sender: 'sender@example.com', subject: 'Events', body: 'Body', attachments: [] },
    })).rejects.toThrow(`Agent Rule create_scheduled_event call cap of ${AGENT_TOOL_WRITE_CAPS.create_scheduled_event} was exceeded.`);
  });

  it('returns a complete unattended write plan without writing during the model loop', async () => {
    database = createMigratedTestD1('organization');
    const sendLine = vi.fn().mockResolvedValue({ outcome: 'succeeded' });
    const createScheduledEvent = vi.fn().mockResolvedValue({ outcome: 'succeeded', eventId: 'event-1' });
    let turn = 0;
    const result = await runAgent({
      database: database.binding, runId: 'run-unattended', agentRuleId: 'agent-rule-1', executionMode: 'unattended',
      permittedLineDestinations: ['line-user-1'], permittedRecipientDestinations: ['guest@example.com'],
      writes: { sendLine, createScheduledEvent, sendEmailSummary: vi.fn() },
      model: { complete: async () => turn++ === 0 ? {
        model: 'test-model', content: '', totalTokens: 1, toolCalls: [
          { id: 'call-line', name: 'send_line_message', arguments: '{"destination":"line-user-1","message":"Bring shoes."}' },
          { id: 'call-event', name: 'create_scheduled_event', arguments: '{"destination":"guest@example.com","title":"Practice","startsAt":"2026-08-10T09:00:00+09:00","endsAt":"2026-08-10T10:00:00+09:00"}' },
        ],
      } : { model: 'test-model', content: 'done', toolCalls: [], totalTokens: 1 } },
      connection: { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' }, prompt: 'Act.',
      source: { id: 'source-unattended', sender: 'sender@example.com', subject: 'Practice', body: 'Body', attachments: [] },
    });

    expect(sendLine).not.toHaveBeenCalled();
    expect(createScheduledEvent).not.toHaveBeenCalled();
    expect(result.plannedActions).toEqual([
      { tool: 'send_line_message', arguments: { destination: 'line-user-1', message: 'Bring shoes.' } },
      { tool: 'create_scheduled_event', arguments: expect.objectContaining({ destination: 'guest@example.com', title: 'Practice' }) },
    ]);
  });

  it('summarises to the chosen subset of permitted recipients rather than to every one of them', async () => {
    database = createMigratedTestD1('organization');
    const sendEmailSummary = vi.fn().mockResolvedValue({ outcome: 'succeeded' });
    let turn = 0;
    const result = await runAgent({
      database: database.binding, runId: 'run-email', agentRuleId: 'agent-rule-1', executionMode: 'unattended',
      permittedLineDestinations: [],
      permittedRecipientDestinations: ['coach@example.com', 'treasurer@example.com', 'parents@example.com'],
      writes: { sendLine: vi.fn(), createScheduledEvent: vi.fn(), sendEmailSummary },
      model: { complete: async () => turn++ === 0 ? {
        model: 'test-model', content: '', totalTokens: 1, toolCalls: [
          { id: 'call-email', name: 'send_email_summary', arguments: '{"destination":"treasurer@example.com","subject":"参加費の入金期限","body":"8月20日までに入金してください。"}' },
        ],
      } : { model: 'test-model', content: 'done', toolCalls: [], totalTokens: 1 } },
      connection: { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' }, prompt: 'Summarise for whoever it concerns.',
      source: { id: 'source-email', sender: 'sender@example.com', subject: 'Fees', body: 'Body', attachments: [] },
    });

    expect(sendEmailSummary).not.toHaveBeenCalled();
    expect(result.plannedActions).toEqual([
      { tool: 'send_email_summary', arguments: { destination: 'treasurer@example.com', subject: '参加費の入金期限', body: '8月20日までに入金してください。' } },
    ]);
  });

  it('refuses an email summary addressed outside the permitted recipient set', async () => {
    database = createMigratedTestD1('organization');
    const run = runAgent({
      database: database.binding, runId: 'run-email-outside', agentRuleId: 'agent-rule-1', executionMode: 'unattended',
      permittedLineDestinations: [], permittedRecipientDestinations: ['coach@example.com'],
      writes: { sendLine: vi.fn(), createScheduledEvent: vi.fn(), sendEmailSummary: vi.fn() },
      model: { complete: async () => ({
        model: 'test-model', content: '', totalTokens: 1,
        toolCalls: [{ id: 'call-outside', name: 'send_email_summary', arguments: '{"destination":"stranger@example.com","subject":"S","body":"B"}' }],
      }) },
      connection: { apiKey: 'test-key', baseUrl: 'https://ai.example.com/v1', model: 'test-model' }, prompt: 'Summarise.',
      source: { id: 'source-email-outside', sender: 'sender@example.com', subject: 'Fees', body: 'Body', attachments: [] },
    });

    await expect(run).rejects.toMatchObject({
      message: 'Destination stranger@example.com is not permitted for send_email_summary.',
    });
  });
});

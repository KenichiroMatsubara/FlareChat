import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuleEffect, RuleEffectRun } from './effects';
import { createRuleExecution, TransientRuleEffectError, TransientRulePlanningError, type PlannedRuleEffect } from './execution';
import { createTestApp, type TestApp } from '../test/app';

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const lineEffect = (key: string, dependsOn: string[] = []): PlannedRuleEffect => ({
  key, dependsOn, kind: 'agent.send_line_message', arguments: { destination: 'line-user-1', message: key },
});

const seedRule = (executionMode: string, id: string): void => {
  fixture!.account.execute(
    `INSERT INTO rules
      (id, organization_id, name, status, execution_mode, selection_policy, routing_policy, priority, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, '{}', '{}', 0, ?, ?)`,
    id, 'organization-1', id, executionMode, '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
  );
};

const seedSource = (id: string): void => {
  fixture!.account.execute(
    `INSERT INTO source_messages
      (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
     VALUES (?, ?, ?, ?, ?, ?, 'processing')`,
    id, `gmail-${id}`, 'history-1', 'sender@example.com', '例会', '2026-08-06T01:00:00.000Z',
  );
};

const ids = (...values: string[]) => () => values.shift() ?? 'unexpected-id';

describe('Rule Execution', () => {
  it('retries a transient planning failure before freezing any Rule Run', async () => {
    fixture = createTestApp();
    seedRule('unattended', 'rule-plan');
    seedSource('source-plan');
    let attempts = 0;
    const plan = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new TransientRulePlanningError('AI temporarily unavailable');
      return [{ rule: { type: 'schema' as const, id: 'rule-plan', revision: 1 }, executionMode: 'unattended' as const, effects: [] }];
    });
    const execution = createRuleExecution({ database: fixture.account.binding, effects: { apply: vi.fn() }, id: () => 'run-plan' });

    await expect(execution.start({ sourceMessageId: 'source-plan', intent: { kind: 'live' }, plan }))
      .resolves.toMatchObject([{ id: 'run-plan', status: 'completed' }]);
    expect(plan).toHaveBeenCalledTimes(3);
    expect(fixture.account.rows('SELECT id FROM rule_runs')).toHaveLength(1);
    expect(fixture.account.row<{ state: string }>("SELECT state FROM source_messages WHERE id = 'source-plan'")).toEqual({ state: 'processed' });
  });

  it('plans and applies an unattended Schema Rule Run from one live Source Message', async () => {
    fixture = createTestApp();
    seedRule('unattended', 'rule-1');
    seedSource('source-1');
    const apply = vi.fn().mockResolvedValue({ externalId: 'line-1' });
    const execution = createRuleExecution({
      database: fixture.account.binding,
      effects: { apply },
      now: () => new Date('2026-08-06T02:00:00.000Z'),
      id: ids('run-1', 'effect-1'),
    });

    const [run] = await execution.start({
      sourceMessageId: 'source-1',
      intent: { kind: 'live' },
      plan: async () => [{
        rule: { type: 'schema', id: 'rule-1', revision: 1 },
        executionMode: 'unattended',
        effects: [lineEffect('line:0')],
      }],
    });

    expect(run).toMatchObject({
      id: 'run-1',
      rule: { type: 'schema', id: 'rule-1', revision: 1 },
      sourceMessageId: 'source-1',
      sourceMessage: {
        subject: '例会',
        sender: 'sender@example.com',
        receivedAt: '2026-08-06T01:00:00.000Z',
      },
      executionMode: 'unattended',
      status: 'completed',
      effects: [{ id: 'effect-1', key: 'line:0', kind: 'agent.send_line_message', status: 'succeeded', result: { externalId: 'line-1' } }],
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0]).toMatchObject({ id: 'run-1', rule: { type: 'schema', id: 'rule-1' } });
    expect(apply.mock.calls[0]?.[1]).toEqual({ kind: 'agent.send_line_message', arguments: { destination: 'line-user-1', message: 'line:0' } });
  });

  it('retains a read-only plan without applying any Rule Effect', async () => {
    fixture = createTestApp();
    seedRule('read_only', 'rule-read');
    seedSource('source-read');
    const apply = vi.fn();
    const execution = createRuleExecution({ database: fixture.account.binding, effects: { apply }, id: ids('run-read', 'effect-read') });

    const [run] = await execution.start({
      sourceMessageId: 'source-read',
      intent: { kind: 'live' },
      plan: async () => [{ rule: { type: 'schema', id: 'rule-read', revision: 1 }, executionMode: 'read_only', effects: [lineEffect('line:0')] }],
    });

    expect(run).toMatchObject({ status: 'read_only', effects: [{ status: 'planned', attempts: 0 }] });
    expect(apply).not.toHaveBeenCalled();
    expect(fixture.account.row<{ state: string }>("SELECT state FROM source_messages WHERE id = 'source-read'")).toEqual({ state: 'processed' });
  });

  it('holds one approval batch for seven days and applies it without replanning', async () => {
    fixture = createTestApp();
    seedRule('approval', 'rule-approval');
    seedSource('source-approval');
    const plan = vi.fn().mockResolvedValue([{
      rule: { type: 'schema', id: 'rule-approval', revision: 1 },
      executionMode: 'approval',
      effects: [lineEffect('line:0'), lineEffect('line:1')],
    }]);
    const apply = vi.fn().mockResolvedValue({ ok: true });
    const execution = createRuleExecution({
      database: fixture.account.binding,
      effects: { apply },
      now: () => new Date('2026-08-06T02:00:00.000Z'),
      id: ids('run-approval', 'effect-0', 'effect-1'),
    });

    const [pending] = await execution.start({ sourceMessageId: 'source-approval', intent: { kind: 'live' }, plan });

    expect(pending).toMatchObject({
      status: 'pending_approval',
      expiresAt: '2026-08-13T02:00:00.000Z',
      effects: [{ status: 'pending' }, { status: 'pending' }],
    });
    expect(apply).not.toHaveBeenCalled();

    const approved = await execution.decide({ ruleRunId: 'run-approval', decision: 'approve', actorIdentityId: 'identity-1' });

    expect(approved).toMatchObject({ status: 'completed', effects: [{ status: 'succeeded' }, { status: 'succeeded' }] });
    expect(plan).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledTimes(2);
    await expect(execution.decide({ ruleRunId: 'run-approval', decision: 'reject', actorIdentityId: 'identity-2' }))
      .rejects.toThrow('Rule Run is already completed.');
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('resumes transient failures without resending successful independent effects', async () => {
    fixture = createTestApp();
    seedRule('unattended', 'rule-retry');
    seedSource('source-retry');
    let attempts = 0;
    const applied: string[] = [];
    const apply = vi.fn(async (_run: RuleEffectRun, effect: RuleEffect) => {
      const message = effect.kind === 'agent.send_line_message' ? effect.arguments.message : effect.kind;
      applied.push(message);
      if (message === 'first' && attempts++ === 0) {
        throw new TransientRuleEffectError('LINE unavailable', new Date('2026-08-06T02:00:00.000Z'));
      }
      return { ok: true };
    });
    const execution = createRuleExecution({
      database: fixture.account.binding,
      effects: { apply },
      now: () => new Date('2026-08-06T02:00:00.000Z'),
      id: ids('run-retry', 'effect-first', 'effect-second', 'effect-third'),
    });

    const [waiting] = await execution.start({
      sourceMessageId: 'source-retry',
      intent: { kind: 'live' },
      plan: async () => [{
        rule: { type: 'schema', id: 'rule-retry', revision: 1 },
        executionMode: 'unattended',
        effects: [lineEffect('first'), lineEffect('second', ['first']), lineEffect('third')],
      }],
    });

    expect(waiting).toMatchObject({
      status: 'applying',
      effects: [{ status: 'transient_failed' }, { status: 'blocked' }, { status: 'succeeded' }],
    });
    expect(applied).toEqual(['first', 'third']);
    expect(fixture.account.row<{ state: string }>("SELECT state FROM source_messages WHERE id = 'source-retry'")).toEqual({ state: 'processing' });

    const [completed] = await execution.resumeDue();

    expect(completed).toMatchObject({ status: 'completed', effects: [{ status: 'succeeded' }, { status: 'succeeded' }, { status: 'succeeded' }] });
    expect(applied).toEqual(['first', 'third', 'first', 'second']);
    expect(fixture.account.row<{ state: string }>("SELECT state FROM source_messages WHERE id = 'source-retry'")).toEqual({ state: 'processed' });
  });

  it('settles a Source Message as an exception when an effect fails for good', async () => {
    fixture = createTestApp();
    seedRule('unattended', 'rule-fail');
    seedSource('source-fail');
    const execution = createRuleExecution({
      database: fixture.account.binding,
      effects: { apply: vi.fn().mockRejectedValue(new Error('LINE refused the message.')) },
    });

    const [run] = await execution.start({
      sourceMessageId: 'source-fail',
      intent: { kind: 'live' },
      plan: async () => [{ rule: { type: 'schema', id: 'rule-fail', revision: 1 }, executionMode: 'unattended', effects: [lineEffect('line:0')] }],
    });

    expect(run).toMatchObject({ status: 'failed', effects: [{ status: 'permanent_failed', error: 'LINE refused the message.' }] });
    expect(fixture.account.row<{ state: string }>("SELECT state FROM source_messages WHERE id = 'source-fail'")).toEqual({ state: 'exception' });
  });

  it('records one Operator Chat exchange as one Rule Run that the exchange closes', async () => {
    fixture = createTestApp();
    const execution = createRuleExecution({ database: fixture.account.binding, effects: { apply: vi.fn() }, id: () => 'chat-run' });

    const opened = await execution.open({ intent: { kind: 'chat' } });
    expect(opened).toEqual({ id: 'chat-run' });
    expect(fixture.account.row<{ status: string; intent: string }>("SELECT status, intent FROM rule_runs WHERE id = 'chat-run'"))
      .toEqual({ status: 'planning', intent: 'chat' });

    await execution.close({ runId: 'chat-run', outcome: 'completed' });
    expect(fixture.account.row<{ status: string }>("SELECT status FROM rule_runs WHERE id = 'chat-run'")).toEqual({ status: 'completed' });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRuleExecution, TransientRuleEffectError, TransientRulePlanningError } from './execution';
import { createTestApp, type TestApp } from '../test/app';

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

describe('Rule Execution', () => {
  it('retries a transient planning failure before freezing any Rule Run', async () => {
    fixture = createTestApp();
    fixture.organization.execute(
      "INSERT INTO rules (id, organization_id, name, status, execution_mode, selection_policy, routing_policy, priority, created_at, updated_at) VALUES ('rule-plan', 'organization-1', 'Plan', 'active', 'unattended', '{}', '{}', 0, '2026-08-06', '2026-08-06')",
    );
    fixture.organization.execute(
      "INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state) VALUES ('source-plan', 'gmail-plan', 'history-1', 'sender@example.com', '例会', '2026-08-06', 'processing')",
    );
    let attempts = 0;
    const planner = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new TransientRulePlanningError('AI temporarily unavailable');
      return [{ rule: { type: 'schema' as const, id: 'rule-plan', revision: 1 }, executionMode: 'unattended' as const, effects: [] }];
    });
    const execution = createRuleExecution({ database: fixture.organization.binding, planner: { plan: planner }, effects: { apply: vi.fn() }, id: () => 'run-plan' });

    await expect(execution.start({ sourceMessageId: 'source-plan', intent: { kind: 'live' } }))
      .resolves.toMatchObject([{ id: 'run-plan', status: 'completed' }]);
    expect(planner).toHaveBeenCalledTimes(3);
    expect(fixture.organization.rows('SELECT id FROM rule_runs')).toHaveLength(1);
  });

  it('plans and applies an unattended Schema Rule Run from one live Source Message', async () => {
    fixture = createTestApp();
    fixture.organization.execute(
      `INSERT INTO rules
        (id, organization_id, name, status, execution_mode, selection_policy, routing_policy, priority, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'unattended', '{}', '{}', 0, ?, ?)`,
      'rule-1', 'organization-1', 'Meetings', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
    );
    fixture.organization.execute(
      `INSERT INTO source_messages
        (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 'processing')`,
      'source-1', 'gmail-1', 'history-1', 'sender@example.com', '例会', '2026-08-06T01:00:00.000Z',
    );
    const apply = vi.fn().mockResolvedValue({ externalId: 'calendar-1' });
    const execution = createRuleExecution({
      database: fixture.organization.binding,
      planner: {
        plan: vi.fn().mockResolvedValue([{
          rule: { type: 'schema', id: 'rule-1', revision: 1 },
          executionMode: 'unattended',
          effects: [{
            key: 'calendar:create:0',
            kind: 'calendar.create',
            arguments: { title: '例会' },
            dependsOn: [],
          }],
        }]),
      },
      effects: { apply },
      now: () => new Date('2026-08-06T02:00:00.000Z'),
      id: (() => {
        const ids = ['run-1', 'effect-1'];
        return () => ids.shift() ?? 'unexpected-id';
      })(),
    });

    const [run] = await execution.start({ sourceMessageId: 'source-1', intent: { kind: 'live' } });

    expect(run).toMatchObject({
      id: 'run-1',
      rule: { type: 'schema', id: 'rule-1', revision: 1 },
      sourceMessageId: 'source-1',
      executionMode: 'unattended',
      status: 'completed',
      effects: [{ id: 'effect-1', key: 'calendar:create:0', kind: 'calendar.create', status: 'succeeded', result: { externalId: 'calendar-1' } }],
    });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('retains a read-only plan without applying any Rule Effect', async () => {
    fixture = createTestApp();
    fixture.organization.execute(
      `INSERT INTO rules
        (id, organization_id, name, status, execution_mode, selection_policy, routing_policy, priority, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'read_only', '{}', '{}', 0, ?, ?)`,
      'rule-read', 'organization-1', 'Shadow', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
    );
    fixture.organization.execute(
      `INSERT INTO source_messages
        (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 'processing')`,
      'source-read', 'gmail-read', 'history-1', 'sender@example.com', '例会', '2026-08-06T01:00:00.000Z',
    );
    const apply = vi.fn();
    const execution = createRuleExecution({
      database: fixture.organization.binding,
      planner: { plan: vi.fn().mockResolvedValue([{
        rule: { type: 'schema', id: 'rule-read', revision: 1 },
        executionMode: 'read_only',
        effects: [{ key: 'task:create:0', kind: 'task.create', arguments: { title: '申込' }, dependsOn: [] }],
      }]) },
      effects: { apply },
      id: (() => {
        const ids = ['run-read', 'effect-read'];
        return () => ids.shift() ?? 'unexpected-id';
      })(),
    });

    const [run] = await execution.start({ sourceMessageId: 'source-read', intent: { kind: 'live' } });

    expect(run).toMatchObject({ status: 'read_only', effects: [{ status: 'planned', attempts: 0 }] });
    expect(apply).not.toHaveBeenCalled();
  });

  it('holds one approval batch for seven days and applies it without replanning', async () => {
    fixture = createTestApp();
    fixture.organization.execute(
      `INSERT INTO rules
        (id, organization_id, name, status, execution_mode, selection_policy, routing_policy, priority, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'approval', '{}', '{}', 0, ?, ?)`,
      'rule-approval', 'organization-1', 'Reviewed', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
    );
    fixture.organization.execute(
      `INSERT INTO source_messages
        (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 'processing')`,
      'source-approval', 'gmail-approval', 'history-1', 'sender@example.com', '例会', '2026-08-06T01:00:00.000Z',
    );
    const planner = vi.fn().mockResolvedValue([{
      rule: { type: 'schema', id: 'rule-approval', revision: 1 },
      executionMode: 'approval',
      effects: [
        { key: 'task:create:0', kind: 'task.create', arguments: { title: '申込' }, dependsOn: [] },
        { key: 'calendar:create:0', kind: 'calendar.create', arguments: { title: '例会' }, dependsOn: [] },
      ],
    }]);
    const apply = vi.fn().mockResolvedValue({ ok: true });
    const execution = createRuleExecution({
      database: fixture.organization.binding,
      planner: { plan: planner },
      effects: { apply },
      now: () => new Date('2026-08-06T02:00:00.000Z'),
      id: (() => {
        const ids = ['run-approval', 'effect-task', 'effect-calendar'];
        return () => ids.shift() ?? 'unexpected-id';
      })(),
    });

    const [pending] = await execution.start({ sourceMessageId: 'source-approval', intent: { kind: 'live' } });

    expect(pending).toMatchObject({
      status: 'pending_approval',
      expiresAt: '2026-08-13T02:00:00.000Z',
      effects: [{ status: 'pending' }, { status: 'pending' }],
    });
    expect(apply).not.toHaveBeenCalled();

    const approved = await execution.decide({ ruleRunId: 'run-approval', decision: 'approve', actorIdentityId: 'identity-1' });

    expect(approved).toMatchObject({ status: 'completed', effects: [{ status: 'succeeded' }, { status: 'succeeded' }] });
    expect(planner).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledTimes(2);
    await expect(execution.decide({ ruleRunId: 'run-approval', decision: 'reject', actorIdentityId: 'identity-2' }))
      .rejects.toThrow('Rule Run is already completed.');
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('resumes transient failures without resending successful independent effects', async () => {
    fixture = createTestApp();
    fixture.organization.execute(
      `INSERT INTO rules
        (id, organization_id, name, status, execution_mode, selection_policy, routing_policy, priority, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'unattended', '{}', '{}', 0, ?, ?)`,
      'rule-retry', 'organization-1', 'Retry', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
    );
    fixture.organization.execute(
      `INSERT INTO source_messages
        (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 'processing')`,
      'source-retry', 'gmail-retry', 'history-1', 'sender@example.com', '例会', '2026-08-06T01:00:00.000Z',
    );
    let driveAttempts = 0;
    const applied: string[] = [];
    const apply = vi.fn(async ({ effect }: { effect: { key: string } }) => {
      applied.push(effect.key);
      if (effect.key === 'drive:publish:0' && driveAttempts++ === 0) {
        throw new TransientRuleEffectError('Drive unavailable', new Date('2026-08-06T02:00:00.000Z'));
      }
      return { ok: true };
    });
    const execution = createRuleExecution({
      database: fixture.organization.binding,
      planner: { plan: vi.fn().mockResolvedValue([{
        rule: { type: 'schema', id: 'rule-retry', revision: 1 },
        executionMode: 'unattended',
        effects: [
          { key: 'drive:publish:0', kind: 'drive.publish', arguments: {}, dependsOn: [] },
          { key: 'calendar:create:0', kind: 'calendar.create', arguments: {}, dependsOn: ['drive:publish:0'] },
          { key: 'task:create:0', kind: 'task.create', arguments: {}, dependsOn: [] },
        ],
      }]) },
      effects: { apply },
      now: () => new Date('2026-08-06T02:00:00.000Z'),
      id: (() => {
        const ids = ['run-retry', 'effect-drive', 'effect-calendar', 'effect-task'];
        return () => ids.shift() ?? 'unexpected-id';
      })(),
    });

    const [waiting] = await execution.start({ sourceMessageId: 'source-retry', intent: { kind: 'live' } });

    expect(waiting).toMatchObject({
      status: 'applying',
      effects: [{ status: 'transient_failed' }, { status: 'blocked' }, { status: 'succeeded' }],
    });
    expect(applied).toEqual(['drive:publish:0', 'task:create:0']);

    const [completed] = await execution.resumeDue();

    expect(completed).toMatchObject({ status: 'completed', effects: [{ status: 'succeeded' }, { status: 'succeeded' }, { status: 'succeeded' }] });
    expect(applied).toEqual(['drive:publish:0', 'task:create:0', 'drive:publish:0', 'calendar:create:0']);
  });
});

import { and, asc, desc, eq } from 'drizzle-orm';

import { organizationDatabase as drizzleOrganizationDatabase } from './storage/database';
import { ruleEffects, ruleRuns, sourceMessages } from './storage/organization-schema';

export type ExecutionMode = 'read_only' | 'approval' | 'unattended';
export type RuleReference = { type: 'schema' | 'agent'; id: string; revision: number };
export type RuleExecutionIntent = { kind: 'live' } | { kind: 'draft_preview'; ruleRevisionId: string };

export interface PlannedRuleEffect {
  key: string;
  kind: string;
  arguments: Record<string, unknown>;
  dependsOn: string[];
}

export interface PlannedRuleRun {
  rule: RuleReference;
  executionMode: ExecutionMode;
  effects: PlannedRuleEffect[];
}

export interface RuleExecutionPlanner {
  plan(input: { sourceMessageId: string; intent: RuleExecutionIntent }): Promise<PlannedRuleRun[]>;
}

export interface RuleEffectApplication {
  run: { id: string; rule: RuleReference; sourceMessageId: string };
  effect: { id: string; key: string; kind: string; arguments: Record<string, unknown>; idempotencyKey: string };
}

export interface RuleEffectPort {
  apply(input: RuleEffectApplication): Promise<unknown>;
}

export class TransientRuleEffectError extends Error {
  constructor(message: string, readonly retryAt: Date) {
    super(message);
    this.name = 'TransientRuleEffectError';
  }
}

export class TransientRulePlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientRulePlanningError';
  }
}

export type RuleEffectStatus = 'planned' | 'pending' | 'applying' | 'succeeded' | 'transient_failed' | 'permanent_failed' | 'blocked' | 'rejected' | 'expired';

export interface RuleEffectView {
  id: string;
  key: string;
  kind: string;
  arguments: Record<string, unknown>;
  dependsOn: string[];
  status: RuleEffectStatus;
  attempts: number;
  result: unknown | null;
  error: string | null;
}

export interface RuleRunView {
  id: string;
  rule: RuleReference;
  sourceMessageId: string;
  sourceMessage: {
    subject: string;
    sender: string;
    receivedAt: string;
  };
  executionMode: ExecutionMode;
  intent: RuleExecutionIntent['kind'];
  status: 'planning' | 'read_only' | 'pending_approval' | 'applying' | 'completed' | 'rejected' | 'expired' | 'failed';
  expiresAt: string | null;
  effects: RuleEffectView[];
}

interface RuleExecutionDependencies {
  database: D1Database;
  planner: RuleExecutionPlanner;
  effects: RuleEffectPort;
  now?: () => Date;
  id?: () => string;
}

const parsed = (value: string | null): unknown | null => value === null ? null : JSON.parse(value) as unknown;

export const createRuleExecution = (dependencies: RuleExecutionDependencies) => {
  const database = drizzleOrganizationDatabase(dependencies.database);
  const currentTime = dependencies.now ?? (() => new Date());
  const nextId = dependencies.id ?? (() => crypto.randomUUID());
  const approvalExpiry = (date: Date): string => new Date(date.getTime() + 7 * 86_400_000).toISOString();
  const plan = async (input: { sourceMessageId: string; intent: RuleExecutionIntent }): Promise<PlannedRuleRun[]> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await dependencies.planner.plan(input);
      } catch (error) {
        if (!(error instanceof TransientRulePlanningError) || attempt === 3) throw error;
      }
    }
    return [];
  };

  const view = async (runId: string): Promise<RuleRunView> => {
    const run = await database.select().from(ruleRuns).where(eq(ruleRuns.id, runId)).get();
    if (!run) throw new Error('Rule Run was not found.');
    const sourceMessage = await database.select({
      subject: sourceMessages.subject,
      sender: sourceMessages.sender,
      receivedAt: sourceMessages.receivedAt,
    }).from(sourceMessages).where(eq(sourceMessages.id, run.sourceMessageId)).get();
    if (!sourceMessage) throw new Error('Rule Run Source Message was not found.');
    const effects = await database.select().from(ruleEffects).where(eq(ruleEffects.ruleRunId, runId)).orderBy(asc(ruleEffects.createdAt)).all();
    const rule: RuleReference = run.ruleId
      ? { type: 'schema', id: run.ruleId, revision: run.ruleRevision }
      : { type: 'agent', id: run.agentRuleId ?? '', revision: run.ruleRevision };
    return {
      id: run.id,
      rule,
      sourceMessageId: run.sourceMessageId,
      sourceMessage,
      executionMode: run.executionMode,
      intent: run.intent,
      status: run.status,
      expiresAt: run.expiresAt,
      effects: effects.map((effect) => ({
        id: effect.id,
        key: effect.effectKey,
        kind: effect.kind,
        arguments: JSON.parse(effect.arguments) as Record<string, unknown>,
        dependsOn: JSON.parse(effect.dependsOn) as string[],
        status: effect.status,
        attempts: effect.attempts,
        result: parsed(effect.result),
        error: effect.error,
      })),
    };
  };

  const applyRun = async (runId: string, rule: RuleReference, sourceMessageId: string): Promise<RuleRunView> => {
    const timestamp = currentTime().toISOString();
    await database.update(ruleRuns).set({ status: 'applying', updatedAt: timestamp }).where(eq(ruleRuns.id, runId)).run();
    const planned = await database.select().from(ruleEffects).where(eq(ruleEffects.ruleRunId, runId)).orderBy(asc(ruleEffects.createdAt)).all();
    const statuses = new Map(planned.map((effect) => [effect.effectKey, effect.status]));
    let permanentlyFailed = false;
    let waiting = false;
    for (const effect of planned) {
      if (effect.status === 'succeeded' || effect.status === 'permanent_failed' || effect.status === 'rejected' || effect.status === 'expired') {
        if (effect.status === 'permanent_failed') permanentlyFailed = true;
        continue;
      }
      if (effect.status === 'transient_failed' && effect.nextAttemptAt && Date.parse(effect.nextAttemptAt) > currentTime().getTime()) {
        waiting = true;
        continue;
      }
      const dependencies_ = JSON.parse(effect.dependsOn) as string[];
      if (dependencies_.some((key) => statuses.get(key) !== 'succeeded')) {
        if (dependencies_.some((key) => statuses.get(key) === 'permanent_failed')) permanentlyFailed = true;
        else waiting = true;
        statuses.set(effect.effectKey, 'blocked');
        await database.update(ruleEffects).set({ status: 'blocked', updatedAt: currentTime().toISOString() }).where(eq(ruleEffects.id, effect.id)).run();
        continue;
      }
      await database.update(ruleEffects).set({ status: 'applying', attempts: effect.attempts + 1, updatedAt: timestamp }).where(eq(ruleEffects.id, effect.id)).run();
      try {
        const result = await dependencies.effects.apply({
          run: { id: runId, rule, sourceMessageId },
          effect: {
            id: effect.id,
            key: effect.effectKey,
            kind: effect.kind,
            arguments: JSON.parse(effect.arguments) as Record<string, unknown>,
            idempotencyKey: effect.idempotencyKey,
          },
        });
        await database.update(ruleEffects).set({ status: 'succeeded', result: JSON.stringify(result ?? null), error: null, updatedAt: currentTime().toISOString() }).where(eq(ruleEffects.id, effect.id)).run();
        statuses.set(effect.effectKey, 'succeeded');
      } catch (error) {
        if (error instanceof TransientRuleEffectError) {
          waiting = true;
          statuses.set(effect.effectKey, 'transient_failed');
          await database.update(ruleEffects).set({
            status: 'transient_failed',
            error: error.message,
            nextAttemptAt: error.retryAt.toISOString(),
            updatedAt: currentTime().toISOString(),
          }).where(eq(ruleEffects.id, effect.id)).run();
        } else {
          permanentlyFailed = true;
          statuses.set(effect.effectKey, 'permanent_failed');
          await database.update(ruleEffects).set({ status: 'permanent_failed', error: error instanceof Error ? error.message : 'Rule Effect failed.', updatedAt: currentTime().toISOString() }).where(eq(ruleEffects.id, effect.id)).run();
        }
      }
    }
    await database.update(ruleRuns).set({
      status: waiting ? 'applying' : permanentlyFailed ? 'failed' : 'completed',
      updatedAt: currentTime().toISOString(),
    }).where(eq(ruleRuns.id, runId)).run();
    return view(runId);
  };

  return {
    read: view,
    list: async (limit = 100): Promise<RuleRunView[]> => {
      const rows = await database.select({ id: ruleRuns.id }).from(ruleRuns)
        .orderBy(desc(ruleRuns.createdAt)).limit(limit).all();
      return Promise.all(rows.map(({ id }) => view(id)));
    },
    expireApprovals: async (): Promise<number> => {
      const pending = await database.select().from(ruleRuns).where(eq(ruleRuns.status, 'pending_approval')).all();
      const expired = pending.filter((run) => Boolean(run.expiresAt) && Date.parse(run.expiresAt!) <= currentTime().getTime());
      let count = 0;
      for (const run of expired) {
        const timestamp = currentTime().toISOString();
        const claimed = await database.update(ruleRuns).set({ status: 'expired', decidedAt: timestamp, updatedAt: timestamp })
          .where(and(eq(ruleRuns.id, run.id), eq(ruleRuns.status, 'pending_approval'))).run();
        if (claimed.meta.changes === 0) continue;
        await database.update(ruleEffects).set({ status: 'expired', updatedAt: timestamp }).where(eq(ruleEffects.ruleRunId, run.id)).run();
        count += 1;
      }
      return count;
    },
    start: async (input: { sourceMessageId: string; intent: RuleExecutionIntent }): Promise<RuleRunView[]> => {
      const plans = await plan(input);
      const runs: RuleRunView[] = [];
      for (const plan of plans) {
        const runId = nextId();
        const timestamp = currentTime().toISOString();
        const expiresAt = plan.executionMode === 'approval' && plan.effects.length
          ? approvalExpiry(new Date(timestamp))
          : null;
        const initialRunStatus = !plan.effects.length
          ? 'completed' as const
          : plan.executionMode === 'read_only'
            ? 'read_only' as const
            : plan.executionMode === 'approval'
              ? 'pending_approval' as const
              : 'applying' as const;
        const initialEffectStatus = plan.executionMode === 'approval' ? 'pending' as const : 'planned' as const;
        const effectRows = plan.effects.map((effect) => ({
          id: nextId(),
          ruleRunId: runId,
          effectKey: effect.key,
          kind: effect.kind,
          arguments: JSON.stringify(effect.arguments),
          dependsOn: JSON.stringify(effect.dependsOn),
          idempotencyKey: `${runId}:${effect.key}`,
          status: initialEffectStatus,
          createdAt: timestamp,
          updatedAt: timestamp,
        }));
        await database.batch([
          database.insert(ruleRuns).values({
          id: runId,
          ...(plan.rule.type === 'schema' ? { ruleId: plan.rule.id, agentRuleId: null } : { ruleId: null, agentRuleId: plan.rule.id }),
          ruleRevision: plan.rule.revision,
          sourceMessageId: input.sourceMessageId,
          executionMode: plan.executionMode,
          intent: input.intent.kind,
          status: initialRunStatus,
          plannedAt: timestamp,
          expiresAt,
          createdAt: timestamp,
          updatedAt: timestamp,
          }),
          ...effectRows.map((effect) => database.insert(ruleEffects).values(effect)),
        ]);
        if (plan.effects.length && plan.executionMode === 'unattended') {
          runs.push(await applyRun(runId, plan.rule, input.sourceMessageId));
        } else {
          runs.push(await view(runId));
        }
      }
      return runs;
    },
    decide: async (input: { ruleRunId: string; decision: 'approve' | 'reject'; actorIdentityId: string }): Promise<RuleRunView> => {
      const run = await database.select().from(ruleRuns).where(eq(ruleRuns.id, input.ruleRunId)).get();
      if (!run) throw new Error('Rule Run was not found.');
      if (run.status !== 'pending_approval') throw new Error(`Rule Run is already ${run.status}.`);
      const decidedAt = currentTime();
      if (!run.expiresAt || Date.parse(run.expiresAt) <= decidedAt.getTime()) {
        const claimed = await database.update(ruleRuns).set({ status: 'expired', decidedAt: decidedAt.toISOString(), updatedAt: decidedAt.toISOString() })
          .where(and(eq(ruleRuns.id, run.id), eq(ruleRuns.status, 'pending_approval'))).run();
        if (claimed.meta.changes === 0) throw new Error('Rule Run was already decided.');
        await database.update(ruleEffects).set({ status: 'expired', updatedAt: decidedAt.toISOString() }).where(eq(ruleEffects.ruleRunId, run.id)).run();
        throw new Error('Rule Run approval has expired.');
      }
      if (input.decision === 'reject') {
        const claimed = await database.update(ruleRuns).set({ status: 'rejected', decidedAt: decidedAt.toISOString(), decidedBy: input.actorIdentityId, updatedAt: decidedAt.toISOString() })
          .where(and(eq(ruleRuns.id, run.id), eq(ruleRuns.status, 'pending_approval'))).run();
        if (claimed.meta.changes === 0) throw new Error('Rule Run was already decided.');
        await database.update(ruleEffects).set({ status: 'rejected', updatedAt: decidedAt.toISOString() }).where(eq(ruleEffects.ruleRunId, run.id)).run();
        return view(run.id);
      }
      const claimed = await database.update(ruleRuns).set({ status: 'applying', decidedAt: decidedAt.toISOString(), decidedBy: input.actorIdentityId, updatedAt: decidedAt.toISOString() })
        .where(and(eq(ruleRuns.id, run.id), eq(ruleRuns.status, 'pending_approval'))).run();
      if (claimed.meta.changes === 0) throw new Error('Rule Run was already decided.');
      const rule: RuleReference = run.ruleId
        ? { type: 'schema', id: run.ruleId, revision: run.ruleRevision }
        : { type: 'agent', id: run.agentRuleId ?? '', revision: run.ruleRevision };
      return applyRun(run.id, rule, run.sourceMessageId);
    },
    resumeDue: async (): Promise<RuleRunView[]> => {
      const due = await database.select().from(ruleRuns).where(eq(ruleRuns.status, 'applying')).orderBy(asc(ruleRuns.updatedAt)).all();
      const resumed: RuleRunView[] = [];
      for (const run of due) {
        const rule: RuleReference = run.ruleId
          ? { type: 'schema', id: run.ruleId, revision: run.ruleRevision }
          : { type: 'agent', id: run.agentRuleId ?? '', revision: run.ruleRevision };
        resumed.push(await applyRun(run.id, rule, run.sourceMessageId));
      }
      return resumed;
    },
  };
};

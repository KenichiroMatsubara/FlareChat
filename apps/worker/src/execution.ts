/**
 * Rule Execution (ADR 0134, ADR 0168): the one module that starts, decides,
 * resumes, expires, lists, and reads Rule Runs for an Account.
 *
 * A caller hands `start()` the plan for one run; how each Rule Effect is applied
 * once the Account is known is this module's own concern and appears on no
 * interface. Read-only retains the plan, approval holds it, and unattended
 * applies it at once; after apply begins only incomplete effects are resumed,
 * never replanned.
 */

import { and, asc, desc, eq } from 'drizzle-orm';

import { decodeRuleEffect, ruleEffectsFor, settleSourceMessage, type RuleEffect, type RuleEffectAdapter } from './effects';
import type { InboxSession } from './inbox';
import { conflict, notFound } from './refusal';
import type { Providers } from './providers';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import { ruleEffects, ruleRuns, sourceMessages } from './storage/account-schema';
import type { Bindings } from './types';

export type ExecutionMode = 'read_only' | 'approval' | 'unattended';
/** A Rule Run belongs to a Schema Rule, an Agent Rule, or to Operator Chat, which has neither (ADR 0146). */
export type RuleReference = { type: 'schema' | 'agent' | 'chat'; id: string; revision: number };
export type RuleExecutionIntent = { kind: 'live' } | { kind: 'draft_preview'; ruleRevisionId: string } | { kind: 'chat' };

export type PlannedRuleEffect = RuleEffect & {
  key: string;
  dependsOn: string[];
};

export interface PlannedRuleRun {
  rule: RuleReference;
  executionMode: ExecutionMode;
  effects: PlannedRuleEffect[];
}

/** The plan for one Source Message, retried while planning itself fails transiently. */
export type RuleRunPlanner = () => Promise<PlannedRuleRun[]>;

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
  sourceMessageId: string | null;
  sourceMessage: {
    subject: string;
    sender: string;
    receivedAt: string;
  } | null;
  executionMode: ExecutionMode;
  intent: RuleExecutionIntent['kind'];
  status: 'planning' | 'read_only' | 'pending_approval' | 'applying' | 'completed' | 'rejected' | 'expired' | 'failed';
  expiresAt: string | null;
  effects: RuleEffectView[];
}

export interface RuleExecution {
  read(runId: string): Promise<RuleRunView>;
  list(limit?: number): Promise<RuleRunView[]>;
  /** Plans and, in unattended mode, applies one Source Message's runs. */
  start(input: { sourceMessageId: string; intent: RuleExecutionIntent; plan: RuleRunPlanner }): Promise<RuleRunView[]>;
  decide(input: { ruleRunId: string; decision: 'approve' | 'reject'; actorIdentityId: string }): Promise<RuleRunView>;
  expireApprovals(): Promise<number>;
  resumeDue(): Promise<RuleRunView[]>;
  /** Opens the Rule Run one Operator Chat exchange is recorded as; the exchange closes it. */
  open(input: { intent: { kind: 'chat' } }): Promise<{ id: string }>;
  close(input: { runId: string; outcome: 'completed' | 'failed' }): Promise<void>;
}

interface RuleExecutionDependencies {
  database: D1Database;
  effects: RuleEffectAdapter;
  now?: () => Date;
  id?: () => string;
}

const parsed = (value: string | null): unknown | null => value === null ? null : JSON.parse(value) as unknown;

const ruleOf = (run: { id: string; ruleId: string | null; agentRuleId: string | null; ruleRevision: number }): RuleReference => run.ruleId
  ? { type: 'schema', id: run.ruleId, revision: run.ruleRevision }
  : run.agentRuleId
    ? { type: 'agent', id: run.agentRuleId, revision: run.ruleRevision }
    : { type: 'chat', id: run.id, revision: run.ruleRevision };

/**
 * The engine, built from an effect adapter. Production reaches it only through
 * `ruleExecutionFor`; a test that has to watch effects being applied substitutes
 * the adapter here, which is the module's one internal seam.
 */
export const createRuleExecution = (dependencies: RuleExecutionDependencies): RuleExecution => {
  const database = drizzleAccountDatabase(dependencies.database);
  const currentTime = dependencies.now ?? (() => new Date());
  const nextId = dependencies.id ?? (() => crypto.randomUUID());
  const approvalExpiry = (date: Date): string => new Date(date.getTime() + 7 * 86_400_000).toISOString();

  const plan = async (planner: RuleRunPlanner): Promise<PlannedRuleRun[]> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await planner();
      } catch (error) {
        if (!(error instanceof TransientRulePlanningError) || attempt === 3) throw error;
      }
    }
    return [];
  };

  const view = async (runId: string): Promise<RuleRunView> => {
    const run = await database.select().from(ruleRuns).where(eq(ruleRuns.id, runId)).get();
    if (!run) throw notFound('Rule Run was not found.');
    const sourceMessage = run.sourceMessageId
      ? await database.select({
        subject: sourceMessages.subject,
        sender: sourceMessages.sender,
        receivedAt: sourceMessages.receivedAt,
      }).from(sourceMessages).where(eq(sourceMessages.id, run.sourceMessageId)).get()
      : null;
    if (run.sourceMessageId && !sourceMessage) throw notFound('Rule Run Source Message was not found.');
    const effects = await database.select().from(ruleEffects).where(eq(ruleEffects.ruleRunId, runId)).orderBy(asc(ruleEffects.createdAt)).all();
    return {
      id: run.id,
      rule: ruleOf(run),
      sourceMessageId: run.sourceMessageId,
      sourceMessage: sourceMessage ?? null,
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

  const applyRun = async (runId: string, rule: RuleReference, sourceMessageId: string | null): Promise<RuleRunView> => {
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
        const result = await dependencies.effects.apply(
          { id: runId, rule, sourceMessageId },
          decodeRuleEffect(effect.kind, effect.arguments),
        );
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
    const status = waiting ? 'applying' : permanentlyFailed ? 'failed' : 'completed';
    await database.update(ruleRuns).set({ status, updatedAt: currentTime().toISOString() }).where(eq(ruleRuns.id, runId)).run();
    if (!waiting && sourceMessageId) await settleSourceMessage(dependencies.database, sourceMessageId, permanentlyFailed);
    return view(runId);
  };

  const claimDecision = async (runId: string, values: Partial<typeof ruleRuns.$inferInsert>): Promise<void> => {
    const claimed = await database.update(ruleRuns).set(values)
      .where(and(eq(ruleRuns.id, runId), eq(ruleRuns.status, 'pending_approval'))).run();
    if (claimed.meta.changes === 0) throw conflict('Rule Run was already decided.');
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
    start: async (input): Promise<RuleRunView[]> => {
      const plans = await plan(input.plan);
      const runs: RuleRunView[] = [];
      let failed = false;
      let waiting = false;
      for (const planned of plans) {
        const runId = nextId();
        const timestamp = currentTime().toISOString();
        const expiresAt = planned.executionMode === 'approval' && planned.effects.length
          ? approvalExpiry(new Date(timestamp))
          : null;
        const initialRunStatus = !planned.effects.length
          ? 'completed' as const
          : planned.executionMode === 'read_only'
            ? 'read_only' as const
            : planned.executionMode === 'approval'
              ? 'pending_approval' as const
              : 'applying' as const;
        const initialEffectStatus = planned.executionMode === 'approval' ? 'pending' as const : 'planned' as const;
        const effectRows = planned.effects.map((effect) => ({
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
            ...(planned.rule.type === 'schema' ? { ruleId: planned.rule.id, agentRuleId: null } : { ruleId: null, agentRuleId: planned.rule.id }),
            ruleRevision: planned.rule.revision,
            sourceMessageId: input.sourceMessageId,
            executionMode: planned.executionMode,
            intent: input.intent.kind,
            status: initialRunStatus,
            plannedAt: timestamp,
            expiresAt,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
          ...effectRows.map((effect) => database.insert(ruleEffects).values(effect)),
        ]);
        if (planned.effects.length && planned.executionMode === 'unattended') {
          const applied = await applyRun(runId, planned.rule, null);
          failed ||= applied.status === 'failed';
          waiting ||= applied.status === 'applying';
          runs.push(applied);
        } else {
          runs.push(await view(runId));
        }
      }
      // A live run settles its Source Message once: as an exception when a run
      // failed or raised one, otherwise as processed, whether the effects were
      // applied, held for approval, or only retained (ADR 0134).
      if (input.intent.kind === 'live' && !waiting) await settleSourceMessage(dependencies.database, input.sourceMessageId, failed);
      return runs;
    },
    decide: async (input): Promise<RuleRunView> => {
      const run = await database.select().from(ruleRuns).where(eq(ruleRuns.id, input.ruleRunId)).get();
      if (!run) throw notFound('Rule Run was not found.');
      if (run.status !== 'pending_approval') throw conflict(`Rule Run is already ${run.status}.`);
      const decidedAt = currentTime().toISOString();
      if (!run.expiresAt || Date.parse(run.expiresAt) <= Date.parse(decidedAt)) {
        await claimDecision(run.id, { status: 'expired', decidedAt, updatedAt: decidedAt });
        await database.update(ruleEffects).set({ status: 'expired', updatedAt: decidedAt }).where(eq(ruleEffects.ruleRunId, run.id)).run();
        throw conflict('Rule Run approval has expired.');
      }
      if (input.decision === 'reject') {
        await claimDecision(run.id, { status: 'rejected', decidedAt, decidedBy: input.actorIdentityId, updatedAt: decidedAt });
        await database.update(ruleEffects).set({ status: 'rejected', updatedAt: decidedAt }).where(eq(ruleEffects.ruleRunId, run.id)).run();
        return view(run.id);
      }
      await claimDecision(run.id, { status: 'applying', decidedAt, decidedBy: input.actorIdentityId, updatedAt: decidedAt });
      return applyRun(run.id, ruleOf(run), run.sourceMessageId);
    },
    resumeDue: async (): Promise<RuleRunView[]> => {
      const due = await database.select().from(ruleRuns).where(eq(ruleRuns.status, 'applying')).orderBy(asc(ruleRuns.updatedAt)).all();
      const resumed: RuleRunView[] = [];
      for (const run of due) resumed.push(await applyRun(run.id, ruleOf(run), run.sourceMessageId));
      return resumed;
    },
    open: async (input) => {
      const id = nextId();
      const timestamp = currentTime().toISOString();
      await database.insert(ruleRuns).values({
        id,
        ruleId: null,
        agentRuleId: null,
        ruleRevision: 1,
        sourceMessageId: null,
        executionMode: 'unattended',
        intent: input.intent.kind,
        status: 'planning',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      return { id };
    },
    close: async (input) => {
      await database.update(ruleRuns).set({ status: input.outcome, updatedAt: currentTime().toISOString() })
        .where(and(eq(ruleRuns.id, input.runId), eq(ruleRuns.intent, 'chat'))).run();
    },
  };
};

/**
 * Rule Execution for one Account: the interface every entrance uses. The
 * intake passes the Inbox session it already opened so attachments it read for
 * extraction are not read again for publication; every other caller lets the
 * module open the Inbox itself.
 */
export const ruleExecutionFor = (input: {
  env: Bindings;
  database: D1Database;
  accountId: string;
  providers: Providers;
  inbox?: InboxSession;
}): RuleExecution => createRuleExecution({
  database: input.database,
  effects: ruleEffectsFor(input),
});

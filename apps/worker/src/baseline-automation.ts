import { eq } from 'drizzle-orm';

import type { AccountDatabase } from './storage/database';
import { agentRules, ruleRevisions, rules, settings } from './storage/account-schema';

const BASELINE_RULE_SETTING = 'baseline-schema-rule:v1';

interface BaselineRuleState {
  ruleId: string | null;
  reason?: string;
  repairSkipped: boolean;
}

/**
 * Ensures a new or legacy Account has one active catch-all Schema Rule,
 * while preserving more selective higher-priority rules. The marker makes this
 * a one-time bootstrap: if an operator later suspends or archives every rule,
 * runtime processing will not recreate it.
 */
export const ensureBaselineSchemaRule = async (
  database: AccountDatabase,
  accountId: string,
): Promise<{ created: boolean; ruleId: string | null; repairSkipped: boolean }> => {
  const installed = await database.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, BASELINE_RULE_SETTING)).get();
  if (installed) {
    const parsed = JSON.parse(installed.value) as Partial<BaselineRuleState>;
    return {
      created: false,
      ruleId: typeof parsed.ruleId === 'string' ? parsed.ruleId : null,
      repairSkipped: parsed.repairSkipped === true,
    };
  }

  const [activeSchemaRules, activeAgentRules] = await Promise.all([
    database.select({ id: rules.id, selectionPolicy: rules.selectionPolicy }).from(rules)
      .where(eq(rules.status, 'active')).all(),
    database.select({ id: agentRules.id, selectionPolicy: agentRules.selectionPolicy }).from(agentRules)
      .where(eq(agentRules.status, 'active')).all(),
  ]);
  const isCatchAll = (selectionPolicy: string): boolean => {
    try { return Object.keys(JSON.parse(selectionPolicy) as Record<string, unknown>).length === 0; }
    catch { return false; }
  };
  const existingCatchAll = activeSchemaRules.find((rule) => isCatchAll(rule.selectionPolicy));
  const existingCatchAllAgent = activeAgentRules.some((rule) => isCatchAll(rule.selectionPolicy));
  const timestamp = new Date().toISOString();
  if (existingCatchAll || existingCatchAllAgent) {
    await database.insert(settings).values({
      key: BASELINE_RULE_SETTING,
      value: JSON.stringify({
        ruleId: existingCatchAll?.id ?? null,
        reason: 'existing-catch-all-rule',
        repairSkipped: true,
      } satisfies BaselineRuleState),
      updatedAt: timestamp,
    }).run();
    return { created: false, ruleId: existingCatchAll?.id ?? null, repairSkipped: true };
  }

  const ruleId = crypto.randomUUID();
  const selectionPolicy = '{}';
  const routingPolicy = '{}';
  const taskRoleIds = '[]';
  await database.batch([
    database.insert(rules).values({
      id: ruleId,
      accountId,
      name: 'All incoming mail',
      status: 'active',
      selectionPolicy,
      routingPolicy,
      taskRoleIds,
      priority: -1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    database.insert(ruleRevisions).values({
      id: crypto.randomUUID(),
      ruleId,
      revision: 1,
      selectionPolicy,
      routingPolicy,
      taskRoleIds,
      createdAt: timestamp,
    }),
    database.insert(settings).values({
      key: BASELINE_RULE_SETTING,
      value: JSON.stringify({ ruleId, repairSkipped: true } satisfies BaselineRuleState),
      updatedAt: timestamp,
    }),
  ]);
  return { created: true, ruleId, repairSkipped: true };
};

export const completeBaselineSkippedRepair = async (database: AccountDatabase): Promise<void> => {
  const installed = await database.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, BASELINE_RULE_SETTING)).get();
  if (!installed) return;
  const state = JSON.parse(installed.value) as Partial<BaselineRuleState>;
  if (state.repairSkipped !== true) return;
  await database.update(settings).set({
    value: JSON.stringify({ ...state, ruleId: typeof state.ruleId === 'string' ? state.ruleId : null, repairSkipped: false }),
    updatedAt: new Date().toISOString(),
  }).where(eq(settings.key, BASELINE_RULE_SETTING)).run();
};

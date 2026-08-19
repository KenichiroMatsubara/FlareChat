/**
 * Running a Trigger that carries no payload (ADR 0140).
 *
 * The Automation starts knowing nothing of its previous runs (ADR 0150) and
 * finds its own work through its Tool Grant. It runs on the same engine Operator
 * Chat runs on and is recorded as the same Rule Run (ADR 0146).
 */

import { and, asc, eq, isNotNull, lte, or } from 'drizzle-orm';

import { CHAT_INTERNAL_TOOLS, INTERNAL_WRITE_TOOLS, resolveChatTools, runChatTurn, type ChatInternalHandlers, type ChatModelPort, type ChatServer } from './chat';
import { nextScheduledRun } from './schedule';
import { suppressionKey, type SuppressionWindow } from './suppression';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import { automationRuns, automations, automationTools, contactListMembers, prompts, ruleRuns } from './storage/account-schema';
import type { McpFetch } from './mcp';
import type { McpServerPorts } from './mcp-server';

export interface DueAutomation {
  id: string;
  name: string;
  instructions: string;
  contactListId: string | null;
  schedule: string;
  offsetMinutes: number;
  executionMode: 'read_only' | 'approval' | 'unattended';
  suppressionWindow: SuppressionWindow;
  grant: string[];
}

/** Active Automations whose stated time has arrived, oldest first. */
export const dueAutomations = async (input: { database: D1Database; at: Date }): Promise<DueAutomation[]> => {
  const db = drizzleAccountDatabase(input.database);
  const rows = await db.select({
    id: automations.id,
    name: automations.name,
    instructions: prompts.instructions,
    contactListId: automations.contactListId,
    schedule: automations.schedule,
    offsetMinutes: automations.offsetMinutes,
    executionMode: automations.executionMode,
    suppressionWindow: automations.suppressionWindow,
  }).from(automations)
    .innerJoin(prompts, eq(prompts.id, automations.promptId))
    .where(and(eq(automations.state, 'active'), or(lte(automations.nextRunAt, input.at.toISOString()), eq(automations.nextRunAt, ''))))
    .orderBy(asc(automations.nextRunAt)).all();
  return Promise.all(rows.map(async (row) => ({
    ...row,
    grant: (await db.select({ tool: automationTools.tool }).from(automationTools)
      .where(eq(automationTools.automationId, row.id)).all()).map(({ tool }) => tool),
  })));
};

/** Moves an Automation to its next stated time, so a slow run cannot fire it twice. */
export const advanceAutomation = async (input: {
  database: D1Database;
  automationId: string;
  schedule: string;
  offsetMinutes: number;
  at: Date;
}): Promise<string | null> => {
  const next = nextScheduledRun({ schedule: input.schedule, offsetMinutes: input.offsetMinutes, after: input.at });
  await drizzleAccountDatabase(input.database).update(automations)
    .set({ nextRunAt: next, updatedAt: input.at.toISOString() })
    .where(eq(automations.id, input.automationId)).run();
  return next;
};

const contactIdsFor = async (database: D1Database, contactListId: string | null): Promise<string[]> => {
  if (!contactListId) return [];
  const rows = await drizzleAccountDatabase(database).select({ contactId: contactListMembers.contactId })
    .from(contactListMembers).where(eq(contactListMembers.listId, contactListId)).all();
  return rows.map(({ contactId }) => contactId);
};

/**
 * The write tools an Automation may call, bounded by its Contact List and by the
 * Suppression Window, so a run that reaches the same conclusion every morning
 * does not notify the same person every morning.
 */
export const automationWriteHandlers = (input: {
  ports: McpServerPorts;
  contactIds: readonly string[];
  suppression: { check(key: string): Promise<boolean>; record(key: string): Promise<void> };
  scope: string;
  window: SuppressionWindow;
  at: Date;
}): ChatInternalHandlers => ({
  'channel.send': async (arguments_) => {
    const contactId = String(arguments_.contactId ?? '');
    const channel = String(arguments_.channel ?? '');
    const text = String(arguments_.text ?? '');
    if (!input.contactIds.includes(contactId)) {
      return { isError: true, message: `Contact ${contactId} is outside this Automation's Contact List.` };
    }
    const key = suppressionKey({ scope: input.scope, tool: 'channel.send', arguments: { contactId, channel, text } });
    if (input.window !== 'none' && await input.suppression.check(key)) {
      return { suppressed: true, message: `Already sent to ${contactId}; the repeat is held for the ${input.window} window.` };
    }
    const sent = await input.ports.sendToContact({ contactId, channel, text });
    if (input.window !== 'none') await input.suppression.record(key);
    return sent;
  },
  'reminder.schedule': async (arguments_) => {
    const contactId = String(arguments_.contactId ?? '');
    if (!input.contactIds.includes(contactId)) {
      return { isError: true, message: `Contact ${contactId} is outside this Automation's Contact List.` };
    }
    const at = String(arguments_.at ?? '');
    const when = Date.parse(at);
    if (Number.isNaN(when)) return { isError: true, message: `${at} is not an instant this server can read.` };
    if (when <= input.at.getTime()) return { isError: true, message: `${at} has already passed.` };
    return input.ports.scheduleReminder({
      contactId,
      channel: String(arguments_.channel ?? ''),
      text: String(arguments_.text ?? ''),
      at: new Date(when).toISOString(),
    });
  },
});

export interface AutomationRunOutcome {
  automationId: string;
  runId: string;
  status: 'completed' | 'failed';
  output: string;
  toolCalls: number;
  unreachableServers: Array<{ server: string; error: string }>;
}

/** Runs one Automation and records it, whatever happens, as one Rule Run. */
export const runAutomation = async (input: {
  database: D1Database;
  automation: DueAutomation;
  servers: readonly ChatServer[];
  fetch: McpFetch;
  model: ChatModelPort;
  connection: { apiKey: string; baseUrl: string; model: string };
  readHandlers: ChatInternalHandlers;
  ports: McpServerPorts;
  suppression: { check(key: string): Promise<boolean>; record(key: string): Promise<void> };
  at: Date;
}): Promise<AutomationRunOutcome> => {
  const db = drizzleAccountDatabase(input.database);
  const timestamp = input.at.toISOString();
  const ruleRunId = crypto.randomUUID();
  const runId = crypto.randomUUID();

  await db.insert(ruleRuns).values({
    id: ruleRunId,
    ruleId: null,
    agentRuleId: null,
    ruleRevision: 1,
    sourceMessageId: null,
    executionMode: input.automation.executionMode,
    intent: 'chat',
    status: 'planning',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run();
  await db.insert(automationRuns).values({
    id: runId,
    automationId: input.automation.id,
    ruleRunId,
    startedAt: timestamp,
    status: 'running',
    toolCalls: 0,
  }).run();

  const contactIds = await contactIdsFor(input.database, input.automation.contactListId);
  const resolved = await resolveChatTools({
    servers: input.servers,
    fetch: input.fetch,
    executionMode: input.automation.executionMode,
    grant: input.automation.grant,
    internalTools: [...CHAT_INTERNAL_TOOLS, ...INTERNAL_WRITE_TOOLS],
  });

  const finish = async (status: 'completed' | 'failed', fields: { output?: string; error?: string; toolCalls?: number }): Promise<void> => {
    const finishedAt = new Date().toISOString();
    await db.update(automationRuns).set({
      status,
      finishedAt,
      output: fields.output ?? null,
      error: fields.error ?? null,
      toolCalls: fields.toolCalls ?? 0,
    }).where(eq(automationRuns.id, runId)).run();
    await db.update(ruleRuns).set({ status: status === 'completed' ? 'completed' : 'failed', updatedAt: finishedAt })
      .where(eq(ruleRuns.id, ruleRunId)).run();
    await db.update(automations).set({
      lastRunAt: timestamp,
      lastError: fields.error ?? null,
      updatedAt: finishedAt,
    }).where(eq(automations.id, input.automation.id)).run();
  };

  try {
    const result = await runChatTurn({
      model: input.model,
      connection: input.connection,
      instructions: input.automation.instructions,
      request: 'Run now. Use your tools to find whatever you need; you remember nothing from previous runs.',
      history: [],
      tools: resolved.tools,
      fetch: input.fetch,
      internal: {
        ...input.readHandlers,
        ...automationWriteHandlers({
          ports: input.ports,
          contactIds,
          suppression: input.suppression,
          scope: input.automation.id,
          window: input.automation.suppressionWindow,
          at: input.at,
        }),
      },
    });
    await finish('completed', { output: result.output, toolCalls: result.toolCallCount });
    return {
      automationId: input.automation.id,
      runId,
      status: 'completed',
      output: result.output,
      toolCalls: result.toolCallCount,
      unreachableServers: resolved.failures,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The Automation run failed.';
    await finish('failed', { error: message });
    return {
      automationId: input.automation.id,
      runId,
      status: 'failed',
      output: '',
      toolCalls: 0,
      unreachableServers: resolved.failures,
    };
  }
};

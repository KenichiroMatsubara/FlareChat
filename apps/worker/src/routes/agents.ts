import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { AgentRule, AgentRun, RunTranscript } from '@mail/domain';

import { readAgentRunTranscript } from '../agent-runs';
import { now } from '../clock';
import { conflict, invalid, notFound } from '../refusal';
import { resource } from '../response';
import {
  agentRulePermittedLineLists,
  agentRulePermittedRecipientLists,
  agentRuleRevisions,
  agentRules,
  agentRuns,
  lists,
  prompts,
} from '../storage/account-schema';
import type { AccountDatabase } from '../storage/database';
import { accountRoute, created, type Created } from './account';

export const agentRoutes = resource();

type RuleState = 'draft' | 'active' | 'suspended' | 'archived';
type ExecutionMode = 'read_only' | 'approval' | 'unattended';
const RULE_STATES: readonly RuleState[] = ['draft', 'active', 'suspended', 'archived'];
const EXECUTION_MODES: readonly ExecutionMode[] = ['read_only', 'approval', 'unattended'];

interface AgentRuleInput {
  name?: string;
  promptId?: string;
  state?: string;
  executionMode?: string;
  selectionPolicy?: Record<string, unknown>;
  permittedRecipientListIds?: unknown;
  permittedLineListIds?: unknown;
  priority?: number;
}

const agentRuleView = (row: typeof agentRules.$inferSelect, permittedRecipientListIds: string[] = [], permittedLineListIds: string[] = []) => ({
  id: row.id,
  accountId: row.accountId,
  name: row.name,
  state: row.status,
  executionMode: row.executionMode,
  permittedRecipientListIds,
  permittedLineListIds,
  promptId: row.promptId,
  selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
  priority: row.priority,
  revision: row.currentRevision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === 'string' && id.trim());

const idListOf = (value: unknown, subject: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!isIdList(value)) throw invalid(`Permitted ${subject} List IDs must be an array of stable identifiers.`);
  return [...new Set(value)];
};

/** Every permitted Typed List must belong to the Account and have the kind its role needs. */
export const assertPermittedLists = async (db: AccountDatabase, recipientListIds: string[] | undefined, lineListIds: string[] | undefined): Promise<void> => {
  const permittedListIds = [...(recipientListIds ?? []), ...(lineListIds ?? [])];
  if (!permittedListIds.length) return;
  const permittedLists = await db.select({ id: lists.id, kind: lists.kind }).from(lists).where(inArray(lists.id, permittedListIds)).all();
  const listKinds = new Map(permittedLists.map((list) => [list.id, list.kind]));
  if (recipientListIds?.some((listId) => listKinds.get(listId) !== 'recipient')) throw conflict('Every permitted Calendar Recipient List must belong to the Account and have recipient kind.');
  if (lineListIds?.some((listId) => listKinds.get(listId) !== 'line')) throw conflict('Every permitted LINE Destination List must belong to the Account and have line kind.');
};

const permittedListsOf = async (db: AccountDatabase, agentRuleId: string): Promise<[string[], string[]]> => {
  const [recipientReferences, lineReferences] = await Promise.all([
    db.select({ listId: agentRulePermittedRecipientLists.listId }).from(agentRulePermittedRecipientLists).where(eq(agentRulePermittedRecipientLists.agentRuleId, agentRuleId)).all(),
    db.select({ listId: agentRulePermittedLineLists.listId }).from(agentRulePermittedLineLists).where(eq(agentRulePermittedLineLists.agentRuleId, agentRuleId)).all(),
  ]);
  return [recipientReferences.map(({ listId }) => listId), lineReferences.map(({ listId }) => listId)];
};

const assertPromptExists = async (db: AccountDatabase, accountId: string, promptId: string): Promise<void> => {
  const prompt = await db.select({ id: prompts.id }).from(prompts).where(and(eq(prompts.id, promptId), eq(prompts.accountId, accountId))).get();
  if (!prompt) throw conflict('Agent Rule Prompt was not found.');
};

agentRoutes.get('/organizations/:accountId/agent-rules', accountRoute(async ({ db }): Promise<AgentRule[]> => {
  const rows = await db.select().from(agentRules).orderBy(desc(agentRules.priority), asc(agentRules.name)).all();
  const ids = rows.map(({ id }) => id);
  const [recipientReferences, lineReferences] = ids.length ? await Promise.all([
    db.select().from(agentRulePermittedRecipientLists).where(inArray(agentRulePermittedRecipientLists.agentRuleId, ids)).all(),
    db.select().from(agentRulePermittedLineLists).where(inArray(agentRulePermittedLineLists.agentRuleId, ids)).all(),
  ]) : [[], []];
  return rows.map((row) => agentRuleView(
    row,
    recipientReferences.flatMap((reference) => reference.agentRuleId === row.id ? [reference.listId] : []),
    lineReferences.flatMap((reference) => reference.agentRuleId === row.id ? [reference.listId] : []),
  ));
}));

agentRoutes.post('/organizations/:accountId/agent-rules', accountRoute<AgentRuleInput>(async ({ db, accountId, body }): Promise<Created<AgentRule>> => {
  const name = body.name?.trim() ?? '';
  const promptId = body.promptId?.trim() ?? '';
  const state = (body.state ?? 'draft') as RuleState;
  if (!name || name.length > 100) throw invalid('An Agent Rule name of at most 100 characters is required.');
  if (!promptId) throw invalid('An Agent Rule Prompt is required.');
  if (!RULE_STATES.includes(state)) throw invalid('Unsupported Agent Rule State.');
  const executionMode = (body.executionMode ?? 'unattended') as ExecutionMode;
  if (!EXECUTION_MODES.includes(executionMode)) throw invalid('Unsupported Agent Rule Execution Mode.');
  const permittedRecipientListIds = idListOf(body.permittedRecipientListIds, 'Calendar Recipient') ?? [];
  const permittedLineListIds = idListOf(body.permittedLineListIds, 'LINE Destination') ?? [];
  await assertPromptExists(db, accountId, promptId);
  await assertPermittedLists(db, permittedRecipientListIds, permittedLineListIds);
  const id = crypto.randomUUID();
  const timestamp = now();
  const selectionPolicy = JSON.stringify(body.selectionPolicy ?? {});
  const priority = Number.isInteger(body.priority) ? body.priority as number : 0;
  const row = { id, accountId, name, status: state, executionMode, promptId, selectionPolicy, priority, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp };
  await db.batch([
    db.insert(agentRules).values(row),
    db.insert(agentRuleRevisions).values({ id: crypto.randomUUID(), agentRuleId: id, revision: 1, promptId, selectionPolicy, executionMode, permittedRecipientListIds: JSON.stringify(permittedRecipientListIds), permittedLineListIds: JSON.stringify(permittedLineListIds), createdAt: timestamp }),
    ...permittedRecipientListIds.map((listId) => db.insert(agentRulePermittedRecipientLists).values({ agentRuleId: id, listId })),
    ...permittedLineListIds.map((listId) => db.insert(agentRulePermittedLineLists).values({ agentRuleId: id, listId })),
  ]);
  return created(agentRuleView(row, permittedRecipientListIds, permittedLineListIds));
}));

agentRoutes.patch('/organizations/:accountId/agent-rules/:agentRuleId', accountRoute<AgentRuleInput>(async ({ db, accountId, body, params }): Promise<AgentRule> => {
  if (body.state !== undefined && !RULE_STATES.includes(body.state as RuleState)) throw invalid('Unsupported Agent Rule State.');
  if (body.executionMode !== undefined && !EXECUTION_MODES.includes(body.executionMode as ExecutionMode)) throw invalid('Unsupported Agent Rule Execution Mode.');
  const permittedRecipientListIds = idListOf(body.permittedRecipientListIds, 'Calendar Recipient');
  const permittedLineListIds = idListOf(body.permittedLineListIds, 'LINE Destination');
  const name = body.name?.trim();
  const promptId = body.promptId?.trim();
  if (name !== undefined && (!name || name.length > 100)) throw invalid('An Agent Rule name of at most 100 characters is required.');
  if (body.promptId !== undefined && !promptId) throw invalid('An Agent Rule Prompt is required.');
  const id = params.agentRuleId ?? '';
  const existing = await db.select().from(agentRules).where(eq(agentRules.id, id)).get();
  if (!existing) throw notFound('Agent Rule was not found.');
  if (promptId) await assertPromptExists(db, accountId, promptId);
  await assertPermittedLists(db, permittedRecipientListIds, permittedLineListIds);
  const configurationChanged = promptId !== undefined || body.selectionPolicy !== undefined || body.executionMode !== undefined || permittedRecipientListIds !== undefined || permittedLineListIds !== undefined;
  const revision = configurationChanged ? existing.currentRevision + 1 : existing.currentRevision;
  const timestamp = now();
  const nextPromptId = promptId ?? existing.promptId;
  const nextSelectionPolicy = body.selectionPolicy === undefined ? existing.selectionPolicy : JSON.stringify(body.selectionPolicy);
  const [currentRecipientListIds, currentLineListIds] = await permittedListsOf(db, id);
  const nextRecipientListIds = permittedRecipientListIds ?? currentRecipientListIds;
  const nextLineListIds = permittedLineListIds ?? currentLineListIds;
  const nextExecutionMode = (body.executionMode ?? existing.executionMode) as ExecutionMode;
  await db.batch([
    db.update(agentRules).set({
      ...(name === undefined ? {} : { name }),
      ...(body.state === undefined ? {} : { status: body.state as RuleState }),
      ...(body.executionMode === undefined ? {} : { executionMode: nextExecutionMode }),
      ...(body.priority === undefined || !Number.isInteger(body.priority) ? {} : { priority: body.priority }),
      promptId: nextPromptId,
      selectionPolicy: nextSelectionPolicy,
      currentRevision: revision,
      updatedAt: timestamp,
    }).where(eq(agentRules.id, id)),
    ...(configurationChanged ? [db.insert(agentRuleRevisions).values({ id: crypto.randomUUID(), agentRuleId: id, revision, promptId: nextPromptId, selectionPolicy: nextSelectionPolicy, executionMode: nextExecutionMode, permittedRecipientListIds: JSON.stringify(nextRecipientListIds), permittedLineListIds: JSON.stringify(nextLineListIds), createdAt: timestamp })] : []),
  ]);
  if (permittedRecipientListIds !== undefined) await db.batch([
    db.delete(agentRulePermittedRecipientLists).where(eq(agentRulePermittedRecipientLists.agentRuleId, id)),
    ...permittedRecipientListIds.map((listId) => db.insert(agentRulePermittedRecipientLists).values({ agentRuleId: id, listId })),
  ]);
  if (permittedLineListIds !== undefined) await db.batch([
    db.delete(agentRulePermittedLineLists).where(eq(agentRulePermittedLineLists.agentRuleId, id)),
    ...permittedLineListIds.map((listId) => db.insert(agentRulePermittedLineLists).values({ agentRuleId: id, listId })),
  ]);
  const updated = await db.select().from(agentRules).where(eq(agentRules.id, id)).get();
  if (!updated) throw notFound('Agent Rule was not found.');
  return agentRuleView(updated, ...await permittedListsOf(db, id));
}));

agentRoutes.get('/organizations/:accountId/agent-runs', accountRoute(async ({ db }): Promise<AgentRun[]> =>
  db.select({
    id: agentRuns.id,
    agentRuleId: agentRuns.agentRuleId,
    agentRuleRevision: agentRuns.agentRuleRevision,
    promptId: agentRuns.promptId,
    promptRevision: agentRuns.promptRevision,
    sourceMessageId: agentRuns.sourceMessageId,
    model: agentRuns.model,
    startedAt: agentRuns.startedAt,
    completedAt: agentRuns.completedAt,
    outcome: agentRuns.outcome,
    toolCallCount: agentRuns.toolCallCount,
    tokens: agentRuns.tokens,
    expiresAt: agentRuns.expiresAt,
  }).from(agentRuns).orderBy(desc(agentRuns.startedAt)).limit(100).all()));

agentRoutes.get('/organizations/:accountId/agent-runs/:runId/transcript', accountRoute(async (request): Promise<RunTranscript> => {
  const runId = request.params.runId ?? '';
  const run = await request.db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, runId)).get();
  if (!run) throw notFound('Run Transcript was not found.');
  const transcript = await readAgentRunTranscript({
    bucket: request.env.RECOVERY_RECEIPTS,
    accountKey: await request.key(),
    accountId: request.accountId,
    runId,
  });
  if (!transcript) throw notFound('Run Transcript was not found.');
  return transcript;
}));

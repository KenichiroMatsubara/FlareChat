import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { RuleRun, SchemaRule } from '@mail/domain';

import { now } from '../clock';
import { ruleExecutionFor } from '../execution';
import type { Providers } from '../providers';
import { conflict, invalid, notFound } from '../refusal';
import { resource } from '../response';
import {
  contactLists,
  rulePermittedLineLists,
  rulePermittedRecipientLists,
  ruleRevisions,
  rules,
} from '../storage/account-schema';
import { assertPermittedLists } from './agents';
import { accountRoute, created, type AccountRequest, type Created } from './account';

type RuleState = 'draft' | 'active' | 'suspended' | 'archived';
type ExecutionMode = 'read_only' | 'approval' | 'unattended';
const RULE_STATES: readonly RuleState[] = ['draft', 'active', 'suspended', 'archived'];
const EXECUTION_MODES: readonly ExecutionMode[] = ['read_only', 'approval', 'unattended'];

const idListOf = (value: unknown, subject: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) throw invalid(`Permitted ${subject} List IDs must be an array of stable identifiers.`);
  return [...new Set(value as string[])];
};

interface RuleInput {
  name?: unknown;
  state?: string;
  executionMode?: string;
  selectionPolicy?: unknown;
  routingPolicy?: Record<string, unknown>;
  noticeContactListId?: unknown;
  permittedRecipientListIds?: unknown;
  permittedLineListIds?: unknown;
  priority?: unknown;
}

/** Schema Rules and the Rule Runs of the Account's one Rule Execution (ADR 0168). */
export const ruleRoutes = (providers: Providers) => {
  const routes = resource();
  const execution = (request: AccountRequest<unknown>) =>
    ruleExecutionFor({ env: request.env, database: request.database, accountId: request.accountId, providers });

  routes.get('/organizations/:accountId/rule-runs', accountRoute(async (request): Promise<RuleRun[]> => execution(request).list()));

  routes.get('/organizations/:accountId/rule-runs/:runId', accountRoute(async (request): Promise<RuleRun> => execution(request).read(request.params.runId ?? '')));

  routes.post('/organizations/:accountId/rule-runs/:runId/decision', accountRoute<{ decision?: string }>(async (request) => {
    if (request.body.decision !== 'approve' && request.body.decision !== 'reject') throw invalid('Decision must be approve or reject.');
    return execution(request).decide({
      ruleRunId: request.params.runId ?? '',
      decision: request.body.decision,
      actorIdentityId: request.session.identity_id,
    });
  }));

  routes.get('/organizations/:accountId/rules', accountRoute(async ({ db, accountId }): Promise<SchemaRule[]> => {
    const rows = await db.select().from(rules).orderBy(desc(rules.priority), asc(rules.name)).all();
    const ruleIds = rows.map(({ id }) => id);
    const [recipientLists, lineLists] = ruleIds.length ? await Promise.all([
      db.select().from(rulePermittedRecipientLists).where(inArray(rulePermittedRecipientLists.ruleId, ruleIds)).all(),
      db.select().from(rulePermittedLineLists).where(inArray(rulePermittedLineLists.ruleId, ruleIds)).all(),
    ]) : [[], []];
    return rows.map((row) => ({
      id: row.id,
      accountId,
      name: row.name,
      state: row.status,
      executionMode: row.executionMode,
      revision: row.currentRevision,
      selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
      routingPolicy: JSON.parse(row.routingPolicy) as Record<string, unknown>,
      noticeContactListId: row.noticeContactListId,
      permittedRecipientListIds: recipientLists.flatMap((reference) => reference.ruleId === row.id ? [reference.listId] : []),
      permittedLineListIds: lineLists.flatMap((reference) => reference.ruleId === row.id ? [reference.listId] : []),
      priority: row.priority,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }));

  routes.post('/organizations/:accountId/rules', accountRoute<RuleInput>(async ({ db, accountId, body }): Promise<Created<SchemaRule>> => {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const state = (body.state ?? 'draft') as RuleState;
    if (!name) throw invalid('Rule name is required.');
    if (!RULE_STATES.includes(state)) throw invalid('Unsupported Rule State.');
    const executionMode = (body.executionMode ?? 'unattended') as ExecutionMode;
    if (!EXECUTION_MODES.includes(executionMode)) throw invalid('Unsupported Rule Execution Mode.');
    const permittedRecipientListIds = idListOf(body.permittedRecipientListIds, 'Calendar Recipient') ?? [];
    const permittedLineListIds = idListOf(body.permittedLineListIds, 'LINE Destination') ?? [];
    await assertPermittedLists(db, permittedRecipientListIds, permittedLineListIds);
    const id = crypto.randomUUID();
    const timestamp = now();
    const selectionPolicy = JSON.stringify(body.selectionPolicy ?? {});
    const routingPolicy = JSON.stringify(body.routingPolicy ?? {});
    const priority = Number.isInteger(body.priority) ? body.priority as number : 0;
    const noticeContactListId = typeof body.noticeContactListId === 'string' && body.noticeContactListId.trim() ? body.noticeContactListId.trim() : null;
    await db.batch([
      db.insert(rules).values({
        id, accountId, name, status: state, executionMode, selectionPolicy, routingPolicy, noticeContactListId, priority,
        currentRevision: 1, createdAt: timestamp, updatedAt: timestamp,
      }),
      db.insert(ruleRevisions).values({ id: crypto.randomUUID(), ruleId: id, revision: 1, executionMode, selectionPolicy, routingPolicy, createdAt: timestamp }),
      ...permittedRecipientListIds.map((listId) => db.insert(rulePermittedRecipientLists).values({ ruleId: id, listId })),
      ...permittedLineListIds.map((listId) => db.insert(rulePermittedLineLists).values({ ruleId: id, listId })),
    ]);
    return created({
      id, accountId, name, state, executionMode, revision: 1,
      selectionPolicy: (body.selectionPolicy ?? {}) as Record<string, unknown>,
      routingPolicy: body.routingPolicy ?? {},
      noticeContactListId, permittedRecipientListIds, permittedLineListIds, priority, createdAt: timestamp, updatedAt: timestamp,
    });
  }));

  routes.patch('/organizations/:accountId/rules/:ruleId', accountRoute<RuleInput>(async ({ db, body, params }) => {
    if (body.state !== undefined && !RULE_STATES.includes(body.state as RuleState)) throw invalid('Unsupported Rule State.');
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) throw invalid('Rule name is required.');
    if (body.selectionPolicy !== undefined && (typeof body.selectionPolicy !== 'object' || body.selectionPolicy === null || Array.isArray(body.selectionPolicy))) throw invalid('The Selection Policy must be an object.');
    if (body.priority !== undefined && !Number.isInteger(body.priority)) throw invalid('The Rule priority must be a whole number.');
    if (body.executionMode !== undefined && !EXECUTION_MODES.includes(body.executionMode as ExecutionMode)) throw invalid('Unsupported Rule Execution Mode.');
    const permittedRecipientListIds = idListOf(body.permittedRecipientListIds, 'Calendar Recipient');
    const permittedLineListIds = idListOf(body.permittedLineListIds, 'LINE Destination');
    if (body.noticeContactListId !== undefined && body.noticeContactListId !== null && typeof body.noticeContactListId !== 'string') throw invalid('The notice Contact List must be a stable identifier or null.');
    if (body.name === undefined && body.state === undefined && body.executionMode === undefined && body.selectionPolicy === undefined && body.priority === undefined && body.noticeContactListId === undefined && permittedRecipientListIds === undefined && permittedLineListIds === undefined) {
      throw invalid('No supported Rule changes were provided.');
    }
    const ruleId = params.ruleId ?? '';
    const existing = await db.select().from(rules).where(eq(rules.id, ruleId)).get();
    if (!existing) throw notFound('Rule was not found.');
    await assertPermittedLists(db, permittedRecipientListIds, permittedLineListIds);
    // A Rule Revision records what a Rule does to a message it is given, which is
    // its Execution Mode and the policies (ADR 0134). A rename or a change of
    // priority is not that, and neither is a save that resubmits the same values:
    // a screen that posts its whole form would otherwise mint a Revision on every
    // click, and the Rule Runs would point at Revisions nothing distinguishes.
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    const executionMode = body.executionMode as ExecutionMode | undefined;
    const selectionPolicy = body.selectionPolicy === undefined ? undefined : JSON.stringify(body.selectionPolicy);
    const priority = body.priority === undefined ? undefined : body.priority as number;
    const revises = (executionMode !== undefined && executionMode !== existing.executionMode)
      || (selectionPolicy !== undefined && selectionPolicy !== existing.selectionPolicy);
    const revision = revises ? existing.currentRevision + 1 : existing.currentRevision;
    if (body.state !== undefined || executionMode !== undefined || selectionPolicy !== undefined || name !== undefined || priority !== undefined) {
      const timestamp = now();
      await db.batch([
        db.update(rules).set({
          ...(name === undefined ? {} : { name }),
          ...(body.state === undefined ? {} : { status: body.state as RuleState }),
          ...(executionMode === undefined ? {} : { executionMode }),
          ...(selectionPolicy === undefined ? {} : { selectionPolicy }),
          ...(priority === undefined ? {} : { priority }),
          ...(revises ? { currentRevision: revision } : {}),
          updatedAt: timestamp,
        }).where(eq(rules.id, ruleId)),
        ...(revises ? [db.insert(ruleRevisions).values({
          id: crypto.randomUUID(),
          ruleId,
          revision,
          executionMode: executionMode ?? existing.executionMode,
          selectionPolicy: selectionPolicy ?? existing.selectionPolicy,
          routingPolicy: existing.routingPolicy,
          createdAt: timestamp,
        })] : []),
      ]);
    }
    if (permittedRecipientListIds !== undefined) {
      await db.batch([
        db.delete(rulePermittedRecipientLists).where(eq(rulePermittedRecipientLists.ruleId, ruleId)),
        ...permittedRecipientListIds.map((listId) => db.insert(rulePermittedRecipientLists).values({ ruleId, listId })),
      ]);
    }
    if (permittedLineListIds !== undefined) {
      await db.batch([
        db.delete(rulePermittedLineLists).where(eq(rulePermittedLineLists.ruleId, ruleId)),
        ...permittedLineListIds.map((listId) => db.insert(rulePermittedLineLists).values({ ruleId, listId })),
      ]);
    }
    if (body.noticeContactListId !== undefined) {
      const noticeContactListId = (body.noticeContactListId as string | null) || null;
      if (noticeContactListId && !await db.select({ id: contactLists.id }).from(contactLists).where(eq(contactLists.id, noticeContactListId)).get()) {
        throw conflict('The notice Contact List must belong to this Account.');
      }
      await db.update(rules).set({ noticeContactListId, updatedAt: now() }).where(eq(rules.id, ruleId)).run();
    }
    return {
      id: ruleId,
      ...(body.noticeContactListId === undefined ? {} : { noticeContactListId: (body.noticeContactListId as string | null) || null }),
      ...(name === undefined ? {} : { name }),
      ...(body.state === undefined ? {} : { state: body.state }),
      ...(executionMode === undefined ? {} : { executionMode }),
      ...(selectionPolicy === undefined ? {} : { selectionPolicy: JSON.parse(selectionPolicy) as Record<string, unknown> }),
      ...(priority === undefined ? {} : { priority }),
      ...(revises ? { revision } : {}),
      ...(permittedRecipientListIds === undefined ? {} : { permittedRecipientListIds }),
      ...(permittedLineListIds === undefined ? {} : { permittedLineListIds }),
    };
  }));

  return routes;
};

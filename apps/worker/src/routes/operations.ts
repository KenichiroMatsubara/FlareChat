import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { AutomationException, AutomationWarning, DeliveryRecord, StuckJob } from '@mail/domain';
import { displayLineDestinationId } from '@mail/domain';

import { now } from '../clock';
import { conflict, invalid, noAccess, notFound } from '../refusal';
import { resource } from '../response';
import { automationWarnings, deliveries, exceptions, jobs } from '../storage/account-schema';
import { accountIdentities, accounts, recoveryRequests } from '../storage/control-schema';
import { controlDatabase } from '../storage/database';
import { accountRoute, created, sessionRoute } from './account';

export const operationRoutes = resource();

operationRoutes.get('/organizations/:accountId/automation-warnings', accountRoute(async ({ db }): Promise<AutomationWarning[]> =>
  db.select().from(automationWarnings).orderBy(desc(automationWarnings.createdAt)).limit(100).all()));

/**
 * The Jobs that are not going to run themselves (ADR 0167).
 *
 * A Job left `running` was claimed by a pass that never finished it, and nothing
 * reclaims it: the sweep only takes `pending` rows. A `failed` one has spent its
 * retries. Both are invisible until somebody notices a reminder that never
 * arrived, so the operations screen states them.
 */
operationRoutes.get('/organizations/:accountId/operations/jobs', accountRoute(async ({ db }): Promise<StuckJob[]> =>
  db.select({
    id: jobs.id,
    kind: jobs.kind,
    state: jobs.state,
    attempts: jobs.attempts,
    availableAt: jobs.availableAt,
    lastError: jobs.lastError,
    updatedAt: jobs.updatedAt,
  }).from(jobs).where(inArray(jobs.state, ['running', 'failed'])).orderBy(desc(jobs.updatedAt)).limit(100).all()));

operationRoutes.get('/organizations/:accountId/audit/deliveries', accountRoute(async ({ db }): Promise<DeliveryRecord[]> => {
  const rows = await db.select().from(deliveries).orderBy(desc(deliveries.createdAt)).limit(100).all();
  return rows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    sourceMessageId: row.sourceMessageId,
    channel: row.channel,
    destination: row.channel === 'line' ? displayLineDestinationId(row.destination) : row.destination,
    outcome: row.outcome,
    externalId: row.externalId,
    createdAt: row.createdAt,
  }));
}));

operationRoutes.get('/organizations/:accountId/operations/exceptions', accountRoute(async ({ db }): Promise<AutomationException[]> => {
  const rows = await db.select().from(exceptions).orderBy(desc(exceptions.createdAt)).limit(100).all();
  return rows.map((row) => ({
    id: row.id, sourceMessageId: row.sourceMessageId, code: row.code, message: row.message, state: row.state, createdAt: row.createdAt, resolvedAt: row.resolvedAt,
  }));
}));

operationRoutes.patch('/organizations/:accountId/operations/exceptions/:exceptionId', accountRoute<{ action?: string }>(async ({ db, body, params }) => {
  const exceptionId = params.exceptionId ?? '';
  if (body.action === 'resolve') {
    const updated = await db.update(exceptions).set({ state: 'resolved', resolvedAt: now() })
      .where(and(eq(exceptions.id, exceptionId), ne(exceptions.state, 'resolved'))).returning({ id: exceptions.id }).get();
    if (!updated) throw notFound('Exception was not found or already resolved.');
    return { id: exceptionId, state: 'resolved' };
  }
  if (body.action === 'retry') {
    const updated = await db.update(exceptions).set({ state: 'retry_requested', resolvedAt: null })
      .where(eq(exceptions.id, exceptionId)).returning({ id: exceptions.id }).get();
    if (!updated) throw notFound('Exception was not found.');
    return { id: exceptionId, state: 'retry_requested' };
  }
  throw invalid('Unsupported Exception action.');
}));

operationRoutes.post('/organizations/:accountId/recovery-requests', accountRoute<{ idempotencyKey?: string }>(async ({ env, session, accountId, body }) => {
  const idempotencyKey = body.idempotencyKey?.trim();
  if (!idempotencyKey) throw invalid('A recovery receipt idempotency key is required.');
  const control = controlDatabase(env.CONTROL_DB);
  const existing = await control.select({ id: recoveryRequests.id }).from(recoveryRequests)
    .where(and(eq(recoveryRequests.accountId, accountId), eq(recoveryRequests.idempotencyKey, idempotencyKey))).get();
  if (existing) throw conflict('A recovery request with this idempotency key was already recorded.');
  const id = crypto.randomUUID();
  const timestamp = now();
  await control.insert(recoveryRequests).values({
    id,
    accountId,
    idempotencyKey,
    state: 'requested',
    requestedByIdentityId: session.identity_id,
    createdAt: timestamp,
  }).run();
  return created({ id, accountId, idempotencyKey, state: 'requested', createdAt: timestamp });
}));

/** Suspension is decided in Control D1 alone, so it is reachable while the Account is suspended. */
operationRoutes.patch('/organizations/:accountId/suspension', sessionRoute(async ({ env, session, context }) => {
  const accountId = context.req.param('accountId') ?? '';
  const control = controlDatabase(env.CONTROL_DB);
  const membership = await control.select({ id: accounts.id, status: accounts.status })
    .from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId)).where(and(
      eq(accountIdentities.identityId, session.identity_id),
      eq(accountIdentities.accountId, accountId),
      eq(accountIdentities.state, 'active'),
    )).get();
  if (!membership) throw noAccess('この組織へのアクセス権がありません。');
  const input = await context.req.json<{ suspended?: boolean }>();
  if (typeof input.suspended !== 'boolean') throw invalid('A suspension state is required.');
  const status = input.suspended ? 'suspended' : 'active';
  await control.update(accounts).set({ status, updatedAt: now() }).where(eq(accounts.id, accountId)).run();
  return { accountId, status };
}));

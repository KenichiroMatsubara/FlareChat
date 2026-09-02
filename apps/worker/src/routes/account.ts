import type { Context } from 'hono';

import { databaseUnavailable, invalid, notFound } from '../refusal';
import { accountKeyFor } from '../keys';
import { activeAccountDatabase, createRequestContext } from './request-context';
import { accountDatabase, type AccountDatabase } from '../storage/database';
import type { AccountRow, Bindings, SessionRow } from '../types';

export type RouteContext = Context<{ Bindings: Bindings }>;

/**
 * What a handler declared against an Account receives (ADR 0169): the resolved
 * access, the parsed parameters, the body, and the environment. Resolving the
 * session, refusing a suspended Account, and refusing a missing database have
 * already happened, once, before the handler runs.
 */
export interface AccountRequest<Body> {
  env: Bindings;
  session: SessionRow;
  account: AccountRow;
  accountId: string;
  /** The raw Account D1, for modules that open their own Drizzle handle. */
  database: D1Database;
  /** The Account D1 through Drizzle. */
  db: AccountDatabase;
  /** The Account encryption key, unwrapped on first use. */
  key: () => Promise<CryptoKey>;
  params: Record<string, string>;
  query: (name: string) => string | undefined;
  body: Body;
  header: (name: string) => string | undefined;
  /** The request as received, for the few seams that read its origin or headers themselves. */
  raw: Request;
  waitUntil: (task: Promise<unknown>) => void;
}

/** A handler answering with a 201 wraps its data in this. */
export class Created<T> {
  constructor(readonly data: T) {}
}

export const created = <T>(data: T): Created<T> => new Created(data);

export type RouteResult<T> = T | Created<T> | Response;

const respond = <T>(context: RouteContext, result: RouteResult<T>): Response => {
  if (result instanceof Response) return result;
  if (result instanceof Created) return context.json({ data: result.data }, 201);
  return context.json({ data: result }, 200);
};

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const parsedBody = async <Body>(context: RouteContext): Promise<Body> => {
  if (!BODY_METHODS.has(context.req.method)) return {} as Body;
  const text = await context.req.text();
  if (!text.trim()) return {} as Body;
  try {
    return JSON.parse(text) as Body;
  } catch {
    throw invalid('The request body must be JSON.');
  }
};

const memoised = <T>(compute: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= compute();
    return pending;
  };
};

/**
 * Declares a route handler against an Account. The session is resolved, the
 * membership and the Account's state are checked, and the Account database
 * must be reachable, all before the handler sees the request.
 */
export const accountRoute = <Body = Record<string, never>, T = unknown>(
  handler: (request: AccountRequest<Body>) => Promise<RouteResult<T>>,
) => async (context: RouteContext): Promise<Response> => {
  const accountId = context.req.param('accountId') ?? '';
  const access = await createRequestContext(context.req.raw, context.env).account(accountId);
  if (!access.database) throw databaseUnavailable();
  const request: AccountRequest<Body> = {
    env: context.env,
    session: access.session,
    account: access.account,
    accountId: access.account.id,
    database: access.database,
    db: accountDatabase(access.database),
    key: memoised(() => accountKeyFor(context.env, access.account.id)),
    params: context.req.param(),
    query: (name) => context.req.query(name),
    body: await parsedBody<Body>(context),
    header: (name) => context.req.header(name),
    raw: context.req.raw,
    waitUntil: (task) => context.executionCtx.waitUntil(task),
  };
  return respond(context, await handler(request));
};

/** Declares a route handler that needs a signed-in session but no Account. */
export const sessionRoute = <T = unknown>(
  handler: (request: { env: Bindings; session: SessionRow; context: RouteContext }) => Promise<RouteResult<T>>,
) => async (context: RouteContext): Promise<Response> => {
  const session = await createRequestContext(context.req.raw, context.env).requiredSession();
  return respond(context, await handler({ env: context.env, session, context }));
};

/** What a public route (a webhook, a link, an outside agent) reaches of an Account, or a refusal naming what was asked for. */
export const publicAccount = async (env: Bindings, accountId: string, subject: string): Promise<{
  accountId: string;
  database: D1Database;
  db: AccountDatabase;
  key: () => Promise<CryptoKey>;
}> => {
  const database = await activeAccountDatabase(env, accountId);
  if (!database) throw notFound(`${subject} was not found.`);
  return {
    accountId,
    database,
    db: accountDatabase(database),
    key: memoised(() => accountKeyFor(env, accountId)),
  };
};

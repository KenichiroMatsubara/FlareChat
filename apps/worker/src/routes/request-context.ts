import { and, eq, gt, isNull } from 'drizzle-orm';

import { now } from '../clock';
import { createDatabaseAccess, DatabaseBindingUnavailableError } from '../database-access';
import { accountKeyFor } from '../keys';
import { accountUnavailable, noAccess, unauthenticated } from '../refusal';
import type { Bindings, AccountRow, SessionRow } from '../types';
import { controlDatabase } from '../storage/database';
import { accountIdentities, identities, accounts, sessions } from '../storage/control-schema';

export interface AccountAccess {
  session: SessionRow;
  account: AccountRow;
  database: D1Database | null;
}

export interface RequestContext {
  session(): Promise<SessionRow | null>;
  /** The signed-in session, or a refusal when there is none. */
  requiredSession(): Promise<SessionRow>;
  account(accountId: string): Promise<AccountAccess>;
  accountKey(accountId: string): Promise<CryptoKey>;
  activeAccountDatabase(accountId: string): Promise<D1Database | null>;
}

export const SESSION_COOKIE = 'mail_session';

export const requestCookie = (header: string | undefined | null, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === name && value) return decodeURIComponent(value);
  }
  return null;
};

/** The Account D1 of an active Account, reached without a session, or null when the Account cannot be served. */
export const activeAccountDatabase = async (env: Bindings, accountId: string): Promise<D1Database | null> => {
  const account = await controlDatabase(env.CONTROL_DB).select({
    databaseId: accounts.databaseId,
    bindingName: accounts.bindingName,
  }).from(accounts).where(and(
    eq(accounts.id, accountId),
    eq(accounts.status, 'active'),
  )).get();
  if (!account) return null;
  try {
    return (await createDatabaseAccess(env).open({
      kind: 'organization',
      bindingName: account.bindingName,
      databaseId: account.databaseId,
    })).raw;
  } catch (error) {
    if (error instanceof DatabaseBindingUnavailableError) return null;
    throw error;
  }
};

export const createRequestContext = (request: Request, env: Bindings): RequestContext => {
  const databases = createDatabaseAccess(env);
  const session = async (): Promise<SessionRow | null> => {
    const id = requestCookie(request.headers.get('Cookie'), SESSION_COOKIE);
    if (!id) return null;
    return await controlDatabase(env.CONTROL_DB).select({
      id: sessions.id,
      identity_id: sessions.identityId,
      email: identities.email,
      display_name: identities.displayName,
    }).from(sessions).innerJoin(identities, eq(identities.id, sessions.identityId)).where(and(
      eq(sessions.id, id),
      gt(sessions.expiresAt, now()),
      isNull(sessions.revokedAt),
    )).get() ?? null;
  };
  const requiredSession = async (): Promise<SessionRow> => {
    const current = await session();
    if (!current) throw unauthenticated();
    return current;
  };

  return {
    session,
    requiredSession,
    async account(accountId) {
      const currentSession = await requiredSession();
      const membership = await controlDatabase(env.CONTROL_DB).select({
        id: accounts.id,
        name: accounts.name,
        status: accounts.status,
        database_id: accounts.databaseId,
        binding_name: accounts.bindingName,
      }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
        .where(and(eq(accountIdentities.identityId, currentSession.identity_id), eq(accountIdentities.accountId, accountId), eq(accountIdentities.state, 'active')))
        .get();
      if (!membership) throw noAccess('この組織へのアクセス権がありません。');
      if (membership.status !== 'active') throw accountUnavailable('この組織は現在利用できません。');
      let database: D1Database | null = null;
      try {
        database = (await databases.open({
          kind: 'organization',
          bindingName: membership.binding_name,
          databaseId: membership.database_id,
        })).raw;
      } catch (error) {
        if (!(error instanceof DatabaseBindingUnavailableError)) throw error;
      }
      return {
        session: currentSession,
        account: membership,
        database,
      };
    },
    accountKey: (accountId) => accountKeyFor(env, accountId),
    activeAccountDatabase: (accountId) => activeAccountDatabase(env, accountId),
  };
};

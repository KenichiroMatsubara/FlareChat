import { and, eq, gt, isNull } from 'drizzle-orm';

import { masterKey, unwrapAccountKey } from '../cryptography';
import {
  createDatabaseAccess,
  DatabaseBindingUnavailableError,
} from '../database-access';
import type { Bindings, AccountRow, SessionRow } from '../types';
import { controlDatabase } from '../storage/database';
import { accountIdentities, identities, accountKeys, accounts, sessions } from '../storage/control-schema';

export interface AccountAccess {
  session: SessionRow;
  account: AccountRow;
  database: D1Database | null;
}

export interface RequestContext {
  session(): Promise<SessionRow | null>;
  account(accountId: string): Promise<AccountAccess>;
  accountKey(accountId: string): Promise<CryptoKey>;
  activeAccountDatabase(accountId: string): Promise<D1Database | null>;
}

const now = (): string => new Date().toISOString();

const requestCookie = (header: string | undefined, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === name && value) return decodeURIComponent(value);
  }
  return null;
};

export const createRequestContext = (request: Request, env: Bindings): RequestContext => {
  const databases = createDatabaseAccess(env);
  const session = async (): Promise<SessionRow | null> => {
    const id = requestCookie(request.headers.get('Cookie') ?? undefined, 'mail_session');
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

  return {
    session,
    async account(accountId) {
      const currentSession = await session();
      if (!currentSession) throw new Error('Authentication is required.');
      const membership = await controlDatabase(env.CONTROL_DB).select({
        id: accounts.id,
        name: accounts.name,
        status: accounts.status,
        database_id: accounts.databaseId,
        binding_name: accounts.bindingName,
      }).from(accountIdentities).innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
        .where(and(eq(accountIdentities.identityId, currentSession.identity_id), eq(accountIdentities.accountId, accountId), eq(accountIdentities.state, 'active')))
        .get();
      if (!membership) throw new Error('この組織へのアクセス権がありません。');
      if (membership.status !== 'active') throw new Error('この組織は現在利用できません。');
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
    async accountKey(accountId) {
      const keyRecord = await controlDatabase(env.CONTROL_DB).select({
        masterKeyVersion: accountKeys.masterKeyVersion,
        wrappedKeyEnvelope: accountKeys.wrappedKeyEnvelope,
      }).from(accountKeys).where(eq(accountKeys.accountId, accountId)).get();
      if (!keyRecord) throw new Error('組織暗号鍵が見つかりません。');
      return unwrapAccountKey(
        { masterKeyVersion: keyRecord.masterKeyVersion, envelope: JSON.parse(keyRecord.wrappedKeyEnvelope) },
        await masterKey(env.CREDENTIAL_MASTER_KEY),
        accountId,
      );
    },
    async activeAccountDatabase(accountId) {
      const account = await controlDatabase(env.CONTROL_DB).select({
        databaseId: accounts.databaseId,
        bindingName: accounts.bindingName,
      }).from(accounts).where(and(
        eq(accounts.id, accountId),
        eq(accounts.status, 'active'),
      )).get();
      if (!account) return null;
      try {
        return (await databases.open({
          kind: 'organization',
          bindingName: account.bindingName,
          databaseId: account.databaseId,
        })).raw;
      } catch (error) {
        if (error instanceof DatabaseBindingUnavailableError) return null;
        throw error;
      }
    },
  };
};

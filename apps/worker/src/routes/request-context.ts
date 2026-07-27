import { and, eq, gt, isNull } from 'drizzle-orm';

import { masterKey, unwrapOrganizationKey } from '../cryptography';
import { organizationDatabase } from '../organization-db';
import type { Bindings, OrganizationRow, SessionRow } from '../types';
import { controlDatabase } from '../storage/database';
import { identities, members, organizationKeys, organizations, sessions } from '../storage/control-schema';

export interface OrganizationAccess {
  session: SessionRow;
  organization: OrganizationRow;
  role: string;
  database: D1Database | null;
}

export interface RequestContext {
  session(): Promise<SessionRow | null>;
  organization(organizationId: string): Promise<OrganizationAccess>;
  organizationKey(organizationId: string): Promise<CryptoKey>;
  activeOrganizationDatabase(organizationId: string): Promise<D1Database | null>;
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
    async organization(organizationId) {
      const currentSession = await session();
      if (!currentSession) throw new Error('Authentication is required.');
      const membership = await controlDatabase(env.CONTROL_DB).select({
        role: members.role,
        id: organizations.id,
        name: organizations.name,
        status: organizations.status,
        database_id: organizations.databaseId,
        binding_name: organizations.bindingName,
      }).from(members).innerJoin(organizations, eq(organizations.id, members.organizationId))
        .where(and(eq(members.identityId, currentSession.identity_id), eq(members.organizationId, organizationId), eq(members.state, 'active')))
        .get();
      if (!membership) throw new Error('この組織へのアクセス権がありません。');
      if (membership.status !== 'active') throw new Error('この組織は現在利用できません。');
      return {
        session: currentSession,
        organization: membership,
        role: membership.role,
        database: organizationDatabase(env, membership.binding_name, membership.database_id),
      };
    },
    async organizationKey(organizationId) {
      const keyRecord = await controlDatabase(env.CONTROL_DB).select({
        masterKeyVersion: organizationKeys.masterKeyVersion,
        wrappedKeyEnvelope: organizationKeys.wrappedKeyEnvelope,
      }).from(organizationKeys).where(eq(organizationKeys.organizationId, organizationId)).get();
      if (!keyRecord) throw new Error('組織暗号鍵が見つかりません。');
      return unwrapOrganizationKey(
        { masterKeyVersion: keyRecord.masterKeyVersion, envelope: JSON.parse(keyRecord.wrappedKeyEnvelope) },
        await masterKey(env.CREDENTIAL_MASTER_KEY),
        organizationId,
      );
    },
    async activeOrganizationDatabase(organizationId) {
      const organization = await controlDatabase(env.CONTROL_DB).select({
        databaseId: organizations.databaseId,
        bindingName: organizations.bindingName,
      }).from(organizations).where(and(
        eq(organizations.id, organizationId),
        eq(organizations.status, 'active'),
      )).get();
      return organization ? organizationDatabase(env, organization.bindingName, organization.databaseId) : null;
    },
  };
};

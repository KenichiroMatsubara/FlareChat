import { and, eq } from 'drizzle-orm';

import { now } from './clock';
import { decrypt, encrypt } from './cryptography';
import { connections } from './storage/account-schema';
import type { AccountDatabase } from './storage/database';

/** The kinds of Connection an Account saves credentials for. */
export type ConnectionKind = 'line' | 'ai' | 'discord';

/** A Connection credential as stored: a flat record of secrets and settings. */
export type ConnectionCredential = Record<string, string>;

export const connectionContext = (accountId: string, kind: ConnectionKind): string =>
  `organization-connection:${accountId}:${kind}`;

export const activeConnection = (db: AccountDatabase, kind: ConnectionKind) =>
  db.select().from(connections).where(and(eq(connections.kind, kind), eq(connections.status, 'active'))).limit(1).get();

/** The decrypted credential of the Account's active Connection of a kind, or an empty record when there is none. */
export const readConnection = async (input: {
  db: AccountDatabase;
  key: CryptoKey;
  accountId: string;
  kind: ConnectionKind;
}): Promise<ConnectionCredential> => {
  const row = await activeConnection(input.db, input.kind);
  if (!row) return {};
  return JSON.parse(await decrypt(JSON.parse(row.credential), input.key, connectionContext(input.accountId, input.kind))) as ConnectionCredential;
};

/** Saves the credential of a Connection, replacing the active one of its kind or creating it. */
export const saveConnection = async (input: {
  db: AccountDatabase;
  key: CryptoKey;
  accountId: string;
  kind: ConnectionKind;
  label: string;
  credential: ConnectionCredential;
}): Promise<void> => {
  const existing = await activeConnection(input.db, input.kind);
  const timestamp = now();
  const stored = JSON.stringify(await encrypt(JSON.stringify(input.credential), input.key, connectionContext(input.accountId, input.kind)));
  if (existing) {
    await input.db.update(connections).set({ label: input.label, credential: stored, status: 'active', updatedAt: timestamp })
      .where(eq(connections.id, existing.id)).run();
    return;
  }
  await input.db.insert(connections).values({
    id: crypto.randomUUID(),
    kind: input.kind,
    label: input.label,
    credential: stored,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run();
};

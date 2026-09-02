import { eq } from 'drizzle-orm';

import { masterKey, unwrapAccountKey } from './cryptography';
import { controlDatabase } from './storage/database';
import { accountKeys } from './storage/control-schema';
import type { Bindings } from './types';

/** The Account's data-encryption key, unwrapped from the versioned deployment master key (ADR 0078). */
export const accountKeyFor = async (env: Bindings, accountId: string): Promise<CryptoKey> => {
  const record = await controlDatabase(env.CONTROL_DB).select({
    masterKeyVersion: accountKeys.masterKeyVersion,
    wrappedKeyEnvelope: accountKeys.wrappedKeyEnvelope,
  }).from(accountKeys).where(eq(accountKeys.accountId, accountId)).get();
  if (!record) throw new Error('Account encryption key is missing.');
  return unwrapAccountKey(
    { masterKeyVersion: record.masterKeyVersion, envelope: JSON.parse(record.wrappedKeyEnvelope) },
    await masterKey(env.CREDENTIAL_MASTER_KEY),
    accountId,
  );
};

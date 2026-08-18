import { decrypt, encrypt } from './cryptography';
import { recordDeliveryAttempt } from './delivery';

export interface RecoveryReceipt {
  accountId: string;
  idempotencyKey: string;
  effectType: 'calendar' | 'line' | 'email' | 'drive';
  externalId: string;
  destinationFingerprint: string;
  succeededAt: string;
}

const receiptKey = (receipt: Pick<RecoveryReceipt, 'accountId' | 'idempotencyKey'>): string =>
  `recovery-receipts/${receipt.accountId}/${encodeURIComponent(receipt.idempotencyKey)}.json`;

const receiptContext = (receipt: Pick<RecoveryReceipt, 'accountId' | 'idempotencyKey'>): string =>
  `recovery-receipt:${receipt.accountId}:${receipt.idempotencyKey}`;

/** Persists an encrypted, immutable success receipt outside Account D1. */
export const writeRecoveryReceipt = async (input: { bucket: R2Bucket; accountKey: CryptoKey; receipt: RecoveryReceipt }): Promise<string> => {
  const key = receiptKey(input.receipt);
  const encrypted = await encrypt(JSON.stringify(input.receipt), input.accountKey, receiptContext(input.receipt));
  await input.bucket.put(key, JSON.stringify(encrypted), { httpMetadata: { contentType: 'application/json' } });
  return key;
};

export const readRecoveryReceipt = async (input: { bucket: R2Bucket; accountKey: CryptoKey; accountId: string; idempotencyKey: string }): Promise<RecoveryReceipt | null> => {
  const receipt = { accountId: input.accountId, idempotencyKey: input.idempotencyKey };
  const object = await input.bucket.get(receiptKey(receipt));
  if (!object) return null;
  return JSON.parse(await decrypt(JSON.parse(await object.text()), input.accountKey, receiptContext(receipt))) as RecoveryReceipt;
};

/** Rebuilds the minimal succeeded Delivery Record after D1 recovery without retaining the original payload. */
export const restoreDeliveryRecordFromReceipt = async (database: D1Database, receipt: RecoveryReceipt): Promise<void> => {
  await recordDeliveryAttempt(database, {
    eventId: receipt.idempotencyKey.split(':')[1] ?? receipt.idempotencyKey,
    destination: receipt.destinationFingerprint,
    channel: receipt.effectType,
    outcome: 'succeeded',
    externalId: receipt.externalId,
  });
};

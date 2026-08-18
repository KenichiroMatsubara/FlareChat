import { asc, eq, lt } from 'drizzle-orm';

import { encrypt } from './cryptography';
import { accountDatabase } from './storage/database';
import { deliveries, deliveryArchives } from './storage/account-schema';

interface ArchivedDelivery {
  id: string;
  eventId: string | null;
  sourceMessageId: string | null;
  channel: string;
  destination: string;
  outcome: string;
  externalId: string | null;
  createdAt: string;
}

/** Archives old Delivery Records as one encrypted R2 object before removing their hot D1 copies. */
export const archiveExpiredDeliveryRecords = async (input: {
  database: D1Database;
  bucket: R2Bucket;
  accountKey: CryptoKey;
  accountId: string;
  before: string;
}): Promise<number> => {
  const db = accountDatabase(input.database);
  const rows: ArchivedDelivery[] = await db.select().from(deliveries)
    .where(lt(deliveries.createdAt, input.before))
    .orderBy(asc(deliveries.createdAt))
    .limit(1_000)
    .all();
  if (!rows.length) return 0;
  const archiveId = crypto.randomUUID();
  const encrypted = await encrypt(JSON.stringify(rows), input.accountKey, `delivery-archive:${input.accountId}:${archiveId}`);
  const objectKey = `delivery-archives/${input.accountId}/${archiveId}.json`;
  await input.bucket.put(objectKey, JSON.stringify(encrypted), { httpMetadata: { contentType: 'application/json' } });
  await db.batch([
    db.insert(deliveryArchives).values({
      id: archiveId,
      objectKey,
      recordCount: rows.length,
      archivedBefore: input.before,
      createdAt: new Date().toISOString(),
    }),
    ...rows.map((record) => db.delete(deliveries).where(eq(deliveries.id, record.id))),
  ]);
  return rows.length;
};

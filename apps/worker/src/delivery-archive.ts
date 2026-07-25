import { encrypt } from './cryptography';

interface ArchivedDelivery {
  id: string;
  event_id: string | null;
  channel: string;
  destination: string;
  outcome: string;
  external_id: string | null;
  created_at: string;
}

/** Archives old Delivery Records as one encrypted R2 object before removing their hot D1 copies. */
export const archiveExpiredDeliveryRecords = async (input: {
  database: D1Database;
  bucket: R2Bucket;
  organizationKey: CryptoKey;
  organizationId: string;
  before: string;
}): Promise<number> => {
  const rows = await input.database.prepare(
    'SELECT id, event_id, channel, destination, outcome, external_id, created_at FROM deliveries WHERE created_at < ? ORDER BY created_at LIMIT 1_000',
  ).bind(input.before).all<ArchivedDelivery>();
  if (!rows.results.length) return 0;
  const archiveId = crypto.randomUUID();
  const encrypted = await encrypt(JSON.stringify(rows.results), input.organizationKey, `delivery-archive:${input.organizationId}:${archiveId}`);
  const objectKey = `delivery-archives/${input.organizationId}/${archiveId}.json`;
  await input.bucket.put(objectKey, JSON.stringify(encrypted), { httpMetadata: { contentType: 'application/json' } });
  await input.database.batch([
    input.database.prepare('INSERT INTO delivery_archives (id, object_key, record_count, archived_before, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(archiveId, objectKey, rows.results.length, input.before, new Date().toISOString()),
    ...rows.results.map((record) => input.database.prepare('DELETE FROM deliveries WHERE id = ?').bind(record.id)),
  ]);
  return rows.results.length;
};

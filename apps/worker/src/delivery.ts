export interface DeliveryAttempt {
  id: string;
  eventId: string;
  destination: string;
  channel: 'calendar' | 'line' | 'email';
  outcome: 'succeeded' | 'failed' | 'pending';
  externalId: string | null;
  createdAt: string;
}

/** Preserves one external effect outcome per destination instead of collapsing a partial batch. */
export const recordDeliveryAttempt = async (
  database: D1Database,
  input: Omit<DeliveryAttempt, 'id' | 'createdAt'>,
): Promise<DeliveryAttempt> => {
  const record: DeliveryAttempt = { id: crypto.randomUUID(), ...input, createdAt: new Date().toISOString() };
  await database.prepare('INSERT INTO deliveries (id, event_id, channel, destination, outcome, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(record.id, record.eventId, record.channel, record.destination, record.outcome, record.externalId, record.createdAt).run();
  return record;
};

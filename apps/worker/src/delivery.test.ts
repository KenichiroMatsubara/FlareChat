import { describe, expect, it } from 'vitest';

import { recordDeliveryAttempt } from './delivery';

describe('Delivery Records', () => {
  it('records each recipient delivery outcome independently so partial success is preserved', async () => {
    const writes: unknown[][] = [];
    const database = { prepare: (_sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;

    const record = await recordDeliveryAttempt(database, { eventId: 'event-1', destination: 'recipient@example.com', channel: 'calendar', outcome: 'succeeded', externalId: 'google-event-1' });

    expect(record).toMatchObject({ eventId: 'event-1', destination: 'recipient@example.com', outcome: 'succeeded' });
    expect(writes[0]).toContain('recipient@example.com');
  });
});

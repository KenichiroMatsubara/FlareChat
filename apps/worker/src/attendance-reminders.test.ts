import { describe, expect, it } from 'vitest';

import { enqueueDueAttendanceReminders } from './attendance-reminders';

describe('Attendance reminder scheduling', () => {
  it('queues only unanswered 7, 3, and 1-day reminders with an idempotency key per recipient', async () => {
    const writes: unknown[][] = [];
    const database = {
      prepare: (_sql: string) => ({
        bind: (...values: unknown[]) => ({
          all: async () => ({ results: [
            { event_id: 'event-1', recipient_item_id: 'recipient-1', destination: 'guest@example.com', status: 'unanswered', attendance_deadline: '2026-08-03T00:00:00.000Z', milestone: 3 },
            { event_id: 'event-1', recipient_item_id: 'recipient-2', destination: 'declined@example.com', status: 'not_attending', attendance_deadline: '2026-08-03T00:00:00.000Z', milestone: 3 },
          ] }),
          run: async () => { writes.push(values); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;

    await expect(enqueueDueAttendanceReminders(database, '2026-07-31T00:00:00.000Z')).resolves.toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('attendance-reminder:event-1:recipient-1:3');
  });
});

import { shouldSendAttendanceReminder } from '@mail/domain';
import type { Bindings } from './types';

interface ReminderCandidate {
  event_id: string;
  recipient_item_id: string;
  destination: string;
  status: 'unanswered' | 'attending' | 'not_attending';
  attendance_deadline: string;
  milestone: number | null;
}

/** Queues one durable reminder per unanswered recipient and milestone. */
export const enqueueDueAttendanceReminders = async (database: D1Database, now: string): Promise<number> => {
  const rows = await database.prepare(
    `SELECT a.event_id, a.recipient_item_id, li.value AS destination, a.status, e.attendance_deadline,
       CAST((julianday(e.attendance_deadline) - julianday(?)) AS INTEGER) AS milestone
     FROM attendance a
     JOIN events e ON e.id = a.event_id
     JOIN list_items li ON li.id = a.recipient_item_id
     WHERE e.attendance_deadline IS NOT NULL`,
  ).bind(now).all<ReminderCandidate>();
  let queued = 0;
  for (const row of rows.results) {
    const milestone = row.milestone ?? -1;
    const idempotencyKey = `attendance-reminder:${row.event_id}:${row.recipient_item_id}:${milestone}`;
    if (!shouldSendAttendanceReminder({ status: row.status, daysUntilDeadline: milestone, alreadySent: false })) continue;
    const timestamp = now;
    const result = await database.prepare(
      "INSERT OR IGNORE INTO jobs (id, kind, payload, state, attempts, available_at, idempotency_key, created_at, updated_at) VALUES (?, 'attendance_reminder', ?, 'pending', 0, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), JSON.stringify({ eventId: row.event_id, recipientItemId: row.recipient_item_id, destination: row.destination, milestone }), timestamp, idempotencyKey, timestamp, timestamp).run();
    queued += result.meta.changes;
  }
  return queued;
};

/** Scans all active Organization databases; suspended Organizations deliberately receive no new reminder work. */
export const enqueueDueOrganizationAttendanceReminders = async (env: Bindings, now: string): Promise<number> => {
  const organizations = await env.CONTROL_DB.prepare("SELECT binding_name FROM organizations WHERE status = 'active' AND database_id IS NOT NULL")
    .all<{ binding_name: string }>();
  let queued = 0;
  for (const organization of organizations.results) {
    const database = (env as unknown as Record<string, unknown>)[organization.binding_name];
    if (!database || typeof database !== 'object') continue;
    queued += await enqueueDueAttendanceReminders(database as D1Database, now);
  }
  return queued;
};

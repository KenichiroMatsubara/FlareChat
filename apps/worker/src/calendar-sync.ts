export const recordCalendarDeletion = async (database: D1Database, input: { eventId: string; sourceMessageId: string | null; now: string }): Promise<void> => {
  await database.batch([
    database.prepare("UPDATE events SET status = 'exception', updated_at = ? WHERE id = ?").bind(input.now, input.eventId),
    database.prepare("INSERT INTO exceptions (id, source_message_id, code, message, state, created_at) VALUES (?, ?, 'calendar_event_deleted', ?, 'open', ?)")
      .bind(crypto.randomUUID(), input.sourceMessageId, 'The organizer deleted this Calendar event; it was not recreated.', input.now),
  ]);
};

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

/** Invites one snapshotted recipient and always leaves an independent Delivery Record. */
export const deliverCalendarInvitation = async (input: {
  database: D1Database;
  accessToken: string;
  eventId: string;
  calendarEventId: string;
  recipientEmail: string;
}): Promise<DeliveryAttempt> => {
  try {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.calendarEventId)}?sendUpdates=all`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendees: [{ email: input.recipientEmail }] }),
      },
    );
    const body = await response.json() as { id?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? 'Google Calendar invitation failed.');
    return recordDeliveryAttempt(input.database, {
      eventId: input.eventId,
      destination: input.recipientEmail,
      channel: 'calendar',
      outcome: 'succeeded',
      externalId: body.id ?? input.calendarEventId,
    });
  } catch {
    return recordDeliveryAttempt(input.database, {
      eventId: input.eventId,
      destination: input.recipientEmail,
      channel: 'calendar',
      outcome: 'failed',
      externalId: null,
    });
  }
};

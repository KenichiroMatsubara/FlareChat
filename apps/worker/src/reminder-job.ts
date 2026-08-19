/**
 * Delivers a reminder an outside agent scheduled (ADR 0156).
 *
 * The Job row is the truth for the work, and this is what performs it; accepting
 * a reminder and never sending it would be the failure this design refuses.
 */

import { and, eq } from 'drizzle-orm';

import { deliverLineBatch } from './delivery';
import { createRequestContext } from './routes/request-context';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import { connections, contactLineDestinations, lineDestinations } from './storage/account-schema';
import { decrypt } from './cryptography';
import type { JobHandler } from './job-dispatch';
import type { Bindings } from './types';

export const MCP_REMINDER_JOB_KIND = 'mcp.reminder';

interface ReminderPayload {
  contactId?: unknown;
  channel?: unknown;
  text?: unknown;
}

const lineAccessToken = async (input: { env: Bindings; database: D1Database; accountId: string }): Promise<string> => {
  const row = await drizzleAccountDatabase(input.database).select().from(connections)
    .where(and(eq(connections.kind, 'line'), eq(connections.status, 'active'))).limit(1).get();
  if (!row) throw new Error('This Account has no LINE Connection to send a reminder through.');
  const accountKey = await createRequestContext(new Request('https://request-context.invalid'), input.env).accountKey(input.accountId);
  const credential = JSON.parse(
    await decrypt(JSON.parse(row.credential), accountKey, `organization-connection:${input.accountId}:line`),
  ) as { channelAccessToken?: string };
  if (!credential.channelAccessToken) throw new Error('This Account has no LINE channel access token.');
  return credential.channelAccessToken;
};

export const reminderJobHandler = (env: Bindings): JobHandler => async ({ database, accountId, payload }) => {
  const reminder = payload as ReminderPayload;
  if (typeof reminder.contactId !== 'string' || typeof reminder.text !== 'string') {
    throw new Error('A scheduled reminder needs a Contact and something to say.');
  }
  if (reminder.channel !== 'line') throw new Error(`A reminder cannot be delivered on ${String(reminder.channel)} yet.`);

  const destination = await drizzleAccountDatabase(database).select({ destinationId: lineDestinations.destinationId })
    .from(contactLineDestinations)
    .innerJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
    .where(eq(contactLineDestinations.contactId, reminder.contactId))
    .get();
  if (!destination) throw new Error(`Contact ${reminder.contactId} has no LINE handle to reach.`);

  const [attempt] = await deliverLineBatch({
    database,
    accessToken: await lineAccessToken({ env, database, accountId }),
    destinationId: destination.destinationId,
    messages: [reminder.text],
  });
  if (attempt?.outcome !== 'succeeded') throw new Error('LINE refused the scheduled reminder.');
};

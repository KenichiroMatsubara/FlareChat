/**
 * Delivers a reminder an outside agent scheduled (ADR 0156).
 *
 * The Job row is the truth for the work, and this is what performs it; accepting
 * a reminder and never sending it would be the failure this design refuses. The
 * send itself goes through the one Channel seam (ADR 0158), so a reminder reaches
 * a Contact exactly as an immediate message does.
 */

import { channelCredentials, sendOnChannel } from './channel';
import { createRequestContext } from './routes/request-context';
import type { JobHandler } from './job-dispatch';
import type { Bindings } from './types';

export const MCP_REMINDER_JOB_KIND = 'mcp.reminder';

interface ReminderPayload {
  contactId?: unknown;
  channel?: unknown;
  text?: unknown;
}

export const reminderJobHandler = (env: Bindings): JobHandler => async ({ database, accountId, payload }) => {
  const reminder = payload as ReminderPayload;
  if (typeof reminder.contactId !== 'string' || typeof reminder.text !== 'string') {
    throw new Error('A scheduled reminder needs a Contact and something to say.');
  }
  const accountKey = await createRequestContext(new Request('https://request-context.invalid'), env).accountKey(accountId);
  await sendOnChannel({
    database,
    credentials: await channelCredentials({ database, accountKey, accountId }),
    contactId: reminder.contactId,
    channel: typeof reminder.channel === 'string' ? reminder.channel : '',
    text: reminder.text,
  });
};

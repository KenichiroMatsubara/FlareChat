/**
 * The Automation Inbox: the one Google Connection an Account reads Source
 * Messages from and sends through. Its access token is refreshed here and only
 * here, and the way a failed run is recorded and reported (ADR 0124) is one
 * decision rather than one per caller.
 */
import { now } from './clock';

import { and, eq } from 'drizzle-orm';

import { decrypt, encrypt } from './cryptography';
import { GoogleGrantRejectedError, type GoogleTokenSet } from './google';
import {
  administratorEmails,
  alertAdministrators,
  automationAlertMessage,
  classifyAutomationFailure,
  shouldAlertAdministrators,
} from './health';
import { accountKeyFor } from './keys';
import type { GoogleProvider, SourceAttachment, SourceAttachmentContent } from './providers';
import { accountDatabase } from './storage/database';
import { googleConnections, type GoogleConnectionRecord } from './storage/account-schema';
import type { Bindings } from './types';

export type AutomationInbox = GoogleConnectionRecord;

/**
 * Refreshing well ahead of expiry buys two things unattended operation needs: a
 * transient token-endpoint outage can be ridden out on the token already in
 * hand, and a rejected grant still leaves a live token for the Administrator
 * notice that reports it.
 */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 15 * 60 * 1_000;

/** Below this the stored token can no longer be trusted to carry one request. */
const ACCESS_TOKEN_USABLE_MARGIN_MS = 60_000;


const tokenContext = (accountId: string): string => `google-connection:${accountId}:automation-inbox`;

export const activeAutomationInbox = async (database: D1Database): Promise<AutomationInbox> => {
  const inbox = await accountDatabase(database).select().from(googleConnections).where(and(
    eq(googleConnections.kind, 'automation_inbox'),
    eq(googleConnections.status, 'active'),
  )).limit(1).get();
  if (!inbox) throw new Error('Automation Inbox が見つかりません。');
  return inbox;
};

/** The enabled Automation Inboxes a scheduled run reads, in the order they were connected. */
export const enabledAutomationInboxes = async (database: D1Database): Promise<AutomationInbox[]> =>
  accountDatabase(database).select().from(googleConnections).where(and(
    eq(googleConnections.kind, 'automation_inbox'),
    eq(googleConnections.status, 'active'),
    eq(googleConnections.enabled, true),
  )).all();

const storedInboxToken = async (
  env: Bindings,
  accountId: string,
  inbox: AutomationInbox,
): Promise<{ key: CryptoKey; token: GoogleTokenSet }> => {
  const key = await accountKeyFor(env, accountId);
  const token = JSON.parse(await decrypt(JSON.parse(inbox.tokenEnvelope), key, tokenContext(accountId))) as GoogleTokenSet;
  return { key, token };
};

/** A usable access token for the Inbox, refreshed and re-encrypted when it is near expiry. */
export const inboxAccessToken = async (input: {
  env: Bindings;
  accountId: string;
  database: D1Database;
  inbox: AutomationInbox;
  google: GoogleProvider;
}): Promise<string> => {
  const { key, token } = await storedInboxToken(input.env, input.accountId, input.inbox);
  const remaining = Date.parse(token.expiresAt) - Date.now();
  if (remaining > ACCESS_TOKEN_REFRESH_MARGIN_MS) return token.accessToken;
  let refreshed: GoogleTokenSet;
  try {
    refreshed = await input.google.refreshToken({
      refreshToken: token.refreshToken,
      clientId: input.env.GOOGLE_CLIENT_ID,
      clientSecret: input.env.GOOGLE_CLIENT_SECRET,
    });
  } catch (error) {
    if (error instanceof GoogleGrantRejectedError || remaining <= ACCESS_TOKEN_USABLE_MARGIN_MS) throw error;
    return token.accessToken;
  }
  const envelope = await encrypt(JSON.stringify(refreshed), key, tokenContext(input.accountId));
  await accountDatabase(input.database).update(googleConnections)
    .set({ tokenEnvelope: JSON.stringify(envelope), updatedAt: now() })
    .where(eq(googleConnections.id, input.inbox.id))
    .run();
  return refreshed.accessToken;
};

/**
 * One run's hold on the Automation Inbox: the Connection, a usable token, and a
 * reader that fetches a Source Message's attachments from Gmail once. The intake
 * reads them to extract, the apply side reads them again to publish, and the
 * memo means Gmail is asked once for both.
 */
export interface InboxSession {
  inbox: AutomationInbox;
  accessToken: string;
  readAttachments(gmailMessageId: string, attachments: SourceAttachment[]): Promise<SourceAttachmentContent[]>;
}

export const openInbox = async (input: {
  env: Bindings;
  accountId: string;
  database: D1Database;
  google: GoogleProvider;
  inbox?: AutomationInbox;
}): Promise<InboxSession> => {
  const inbox = input.inbox ?? await activeAutomationInbox(input.database);
  const accessToken = await inboxAccessToken({ ...input, inbox });
  const contents = new Map<string, Promise<SourceAttachmentContent[]>>();
  return {
    inbox,
    accessToken,
    readAttachments: (gmailMessageId, attachments) => {
      if (!attachments.length) return Promise.resolve([]);
      const key = `${gmailMessageId}:${attachments.map((attachment) => attachment.attachmentId).join(',')}`;
      const cached = contents.get(key);
      if (cached) return cached;
      const reading = input.google.gmail.readAttachments(accessToken, gmailMessageId, attachments);
      contents.set(key, reading);
      reading.catch(() => contents.delete(key));
      return reading;
    },
  };
};

/** The stored access token when it can still carry the Administrator notice, otherwise nothing. */
const notifiableAccessToken = async (env: Bindings, accountId: string, inbox: AutomationInbox): Promise<string | null> => {
  try {
    const { token } = await storedInboxToken(env, accountId, inbox);
    return Date.parse(token.expiresAt) - Date.now() > ACCESS_TOKEN_USABLE_MARGIN_MS ? token.accessToken : null;
  } catch {
    return null;
  }
};

/**
 * Records one failed Automation run and, once the failure has outlived its
 * retry budget, mails every Administrator through the Automation Inbox. Only a
 * grant Google rejected suspends the Inbox; every other failure leaves it
 * active so the next scheduled run retries without anyone signing in.
 */
export const recordInboxFailure = async (input: {
  env: Bindings;
  accountId: string;
  database: D1Database;
  inbox: AutomationInbox;
  error: unknown;
  google: GoogleProvider;
}): Promise<void> => {
  const db = accountDatabase(input.database);
  const kind = classifyAutomationFailure(input.error);
  const lastError = input.error instanceof Error ? input.error.message : 'Automation Inbox failed.';
  const at = now();
  const failingSince = input.inbox.failingSince ?? at;
  await db.update(googleConnections).set({
    ...(kind === 'credential' ? { status: 'reauthentication_required' as const } : {}),
    lastError,
    failingSince,
    updatedAt: at,
  }).where(eq(googleConnections.id, input.inbox.id)).run();
  if (!shouldAlertAdministrators({ kind, failingSince, alertedAt: input.inbox.alertedAt, at })) return;
  try {
    const [destinations, accessToken] = await Promise.all([
      administratorEmails(input.env, input.accountId),
      notifiableAccessToken(input.env, input.accountId, input.inbox),
    ]);
    if (!destinations.length || !accessToken) return;
    const message = automationAlertMessage({
      kind,
      inboxAddress: input.inbox.inboxAddress,
      failingSince,
      lastError,
      appUrl: input.env.APP_URL,
    });
    const delivered = await alertAdministrators({
      google: input.google,
      accessToken,
      destinations,
      subject: message.subject,
      body: message.body,
    });
    if (!delivered) return;
    await db.update(googleConnections).set({ alertedAt: at, updatedAt: at })
      .where(eq(googleConnections.id, input.inbox.id)).run();
  } catch {
    // An undelivered notice stays unrecorded, so the next scheduled run retries it.
  }
};

/** Proves the stored grant still refreshes, recording the failure the way a run would. */
export const verifyInboxCredential = async (input: {
  env: Bindings;
  accountId: string;
  database: D1Database;
  google: GoogleProvider;
}): Promise<void> => {
  const inbox = await accountDatabase(input.database).select().from(googleConnections).where(and(
    eq(googleConnections.kind, 'automation_inbox'),
    eq(googleConnections.status, 'active'),
  )).limit(1).get();
  if (!inbox) return;
  try {
    await inboxAccessToken({ ...input, inbox });
  } catch (error) {
    await recordInboxFailure({ ...input, inbox, error });
  }
};

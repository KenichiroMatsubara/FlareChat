/**
 * Reaching a Contact, or an address, on a Channel (ADR 0143, ADR 0158).
 *
 * Every surface that speaks to a Contact — the MCP Server an outside agent
 * calls, a scheduled reminder, an Automation run, and the Channel Test an
 * operator runs by hand — passes through here, so none of them can reach LINE by
 * a path the others do not. What a caller states is who, on which Channel, and
 * what to say; resolving the Connection, the handle, how many provider requests
 * that takes, and the Delivery Records is this module's work, and a refusal is
 * reported as the failure it was rather than a synthesised success (ADR 0142).
 *
 * Authorization stays outside. Who may be reached is decided by the Access
 * Token's Contact List, an Automation's Contact List, a Rule's Channel Handle
 * List, or an authenticated operator's session before anything here is called;
 * this module refuses only what the Channel itself refuses.
 */

import { and, asc, eq, inArray, like, or } from 'drizzle-orm';

import { decrypt } from './cryptography';
import { conflict, invalid } from './refusal';
import { recordDeliveryAttempt, type DeliveryAttempt } from './delivery';
import { sendDiscordMessage } from './discord';
import { accountDatabase } from './storage/database';
import {
  channelHandles,
  connections,
  contactLineDestinations,
  contacts,
  lineDestinations,
} from './storage/account-schema';

/** The Channels the product itself carries. A Contact is reachable on those it holds a handle for. */
export const CHANNELS = ['line', 'discord'] as const;
export type ChannelName = (typeof CHANNELS)[number];

export const isChannelName = (value: string): value is ChannelName =>
  (CHANNELS as readonly string[]).includes(value);

/** The Account's Channel credentials, absent where the Account has no Connection. */
export interface ChannelCredentials {
  line: string | null;
  discord: string | null;
}

/** One Contact and the Channels it can actually be reached on. */
export interface ContactReach {
  id: string;
  name: string;
  email: string;
  state: string;
  channels: ChannelName[];
}

/** How many messages one provider request may carry to one LINE destination. */
export const LINE_BATCH_LIMIT = 5;

/**
 * What one address received, or did not.
 *
 * `messages` is what was meant to arrive and `requests` is how many provider
 * calls carried them, so a caller can see the batching happen rather than
 * trust that it did.
 */
export interface ChannelOutcome {
  channel: ChannelName;
  destination: string;
  delivered: boolean;
  messages: number;
  requests: number;
  externalId: string | null;
  error: string | null;
}

/** What one Contact received. A refusal throws rather than returning this. */
export interface ChannelDelivery {
  delivered: true;
  channel: ChannelName;
  contactId: string;
  destination: string;
  messages: number;
  requests: number;
  externalId: string | null;
}

export type ChannelFetch = (url: string, init: RequestInit) => Promise<Response>;

interface StoredCredential {
  channelAccessToken?: string;
  botToken?: string;
}

const connectionContext = (accountId: string, kind: 'line' | 'discord'): string =>
  `organization-connection:${accountId}:${kind}`;

const storedCredential = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
  kind: 'line' | 'discord';
}): Promise<StoredCredential | null> => {
  const row = await accountDatabase(input.database).select().from(connections)
    .where(and(eq(connections.kind, input.kind), eq(connections.status, 'active'))).limit(1).get();
  if (!row) return null;
  return JSON.parse(
    await decrypt(JSON.parse(row.credential), input.accountKey, connectionContext(input.accountId, input.kind)),
  ) as StoredCredential;
};

/**
 * The credentials this Account can reach its Channels with.
 *
 * Read once per run rather than per message, because a caller that resolves them
 * itself is a caller that can resolve them differently.
 */
export const channelCredentials = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
}): Promise<ChannelCredentials> => {
  const [line, discord] = await Promise.all([
    storedCredential({ ...input, kind: 'line' }),
    storedCredential({ ...input, kind: 'discord' }),
  ]);
  return {
    line: line?.channelAccessToken ?? null,
    discord: discord?.botToken ?? null,
  };
};

/** The LINE destination a Contact is reachable at, or null when it holds none. */
const lineDestinationFor = async (database: D1Database, contactId: string): Promise<string | null> => {
  const row = await accountDatabase(database).select({ destinationId: lineDestinations.destinationId })
    .from(contactLineDestinations)
    .innerJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
    .where(eq(contactLineDestinations.contactId, contactId))
    .get();
  return row?.destinationId ?? null;
};

/** The Discord channel a Contact is reachable in, or null when it holds no handle. */
const discordTargetFor = async (database: D1Database, contactId: string): Promise<string | null> => {
  const row = await accountDatabase(database).select({ replyTarget: channelHandles.replyTarget })
    .from(channelHandles)
    .where(and(
      eq(channelHandles.contactId, contactId),
      eq(channelHandles.channel, 'discord'),
      eq(channelHandles.isPrimary, true),
    ))
    .get();
  return row?.replyTarget ?? null;
};

const destinationFor = async (input: {
  database: D1Database;
  contactId: string;
  channel: ChannelName;
}): Promise<string | null> => input.channel === 'line'
  ? lineDestinationFor(input.database, input.contactId)
  : discordTargetFor(input.database, input.contactId);

/** Where one Contact can be reached, so a caller never has to guess a Channel. */
export const contactChannels = async (input: {
  database: D1Database;
  contactId: string;
}): Promise<ChannelName[]> => {
  const reachable = await Promise.all(CHANNELS.map(async (channel) =>
    await destinationFor({ ...input, channel }) ? channel : null));
  return reachable.filter((channel): channel is ChannelName => channel !== null);
};

/**
 * The Contacts a caller may reach and the Channels each is reachable on.
 *
 * `contactIds` bounds the answer to a Contact List; an explicit empty list
 * reaches nobody, and omitting it means the whole Account, which only a surface
 * an operator authenticated on may ask for.
 */
export const reachableContacts = async (input: {
  database: D1Database;
  query?: string;
  contactIds?: readonly string[];
}): Promise<ContactReach[]> => {
  if (input.contactIds && !input.contactIds.length) return [];
  const term = `%${input.query ?? ''}%`;
  const rows = await accountDatabase(input.database).select({
    id: contacts.id,
    name: contacts.name,
    email: contacts.email,
    state: contacts.state,
  }).from(contacts)
    .where(and(
      input.contactIds ? inArray(contacts.id, [...input.contactIds]) : undefined,
      input.query ? or(like(contacts.name, term), like(contacts.email, term)) : undefined,
    ))
    .orderBy(asc(contacts.name)).limit(200).all();
  return Promise.all(rows.map(async (row) => ({
    ...row,
    channels: await contactChannels({ database: input.database, contactId: row.id }),
  })));
};

const batched = <T>(values: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
};

const stated = (texts: readonly string[]): string[] => {
  const said = texts.map((text) => text.trim()).filter((text) => text.length > 0);
  if (!said.length) throw new Error('A message needs something to say.');
  return said;
};

const failedAt = async (input: {
  database: D1Database;
  channel: ChannelName;
  destination: string;
  messages: number;
  requests: number;
  error: string;
  eventId?: string | null;
  sourceMessageId?: string | null;
}): Promise<ChannelOutcome> => {
  for (let index = 0; index < input.messages; index += 1) {
    await recordDeliveryAttempt(input.database, {
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      destination: input.destination,
      channel: input.channel,
      outcome: 'failed',
      externalId: null,
    });
  }
  return {
    channel: input.channel,
    destination: input.destination,
    delivered: false,
    messages: input.messages,
    requests: input.requests,
    externalId: null,
    error: input.error,
  };
};

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

/** Speaks the LINE Messaging API once: one push of at most five message objects, one Delivery Record per intended message. */
const deliverLineBatch = async (input: {
  database: D1Database;
  request: ChannelFetch;
  accessToken: string;
  eventId?: string | null;
  sourceMessageId?: string | null;
  destinationId: string;
  messages: string[];
}): Promise<DeliveryAttempt[]> => {
  if (!input.messages.length || input.messages.length > LINE_BATCH_LIMIT) throw new Error('A LINE batch must contain between one and five messages.');
  let outcome: DeliveryAttempt['outcome'] = 'failed';
  let externalId: string | null = null;
  try {
    const response = await input.request(LINE_PUSH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: input.destinationId, messages: input.messages.map((text) => ({ type: 'text', text })) }),
    });
    if (!response.ok) throw new Error('LINE push failed.');
    outcome = 'succeeded';
    externalId = response.headers.get('x-line-request-id');
  } catch {
    // Every failed intended message still receives its own retryable record below.
  }
  return Promise.all(input.messages.map(() => recordDeliveryAttempt(input.database, {
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
    destination: input.destinationId,
    channel: 'line',
    outcome,
    externalId,
  })));
};

/**
 * Sends to one address on one Channel, batching what the provider lets us batch.
 *
 * LINE carries up to five message objects in one push, so five messages for one
 * destination cost one request rather than five, and a longer run is split into
 * as few requests as the limit allows. Discord has no such call, so it is one
 * request per message and the difference stays here rather than in every caller.
 *
 * A provider refusal is returned as `delivered: false` with its reason and
 * leaves a failed Delivery Record per intended message, because a broadcast must
 * not lose the rest of its addresses to one refusal. Only a caller error — an
 * unknown Channel, nothing to say — throws.
 */
export const sendOnDestination = async (input: {
  database: D1Database;
  credentials: ChannelCredentials;
  channel: string;
  destination: string;
  texts: readonly string[];
  eventId?: string | null;
  sourceMessageId?: string | null;
  fetch?: ChannelFetch;
}): Promise<ChannelOutcome> => {
  if (!isChannelName(input.channel)) throw new Error(`This product does not reach an address on ${input.channel} yet.`);
  const channel = input.channel;
  const texts = stated(input.texts);
  const records = {
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
  };
  const credential = input.credentials[channel];
  if (!credential) {
    return failedAt({
      database: input.database,
      channel,
      destination: input.destination,
      messages: texts.length,
      requests: 0,
      error: `This Account has no ${channel === 'line' ? 'LINE' : 'Discord'} Connection to send through.`,
      ...records,
    });
  }
  const request = input.fetch ?? ((url, init) => fetch(url, init));

  if (channel === 'line') {
    const batches = batched(texts, LINE_BATCH_LIMIT);
    const attempts = await Promise.all(batches.map((messages) => deliverLineBatch({
      database: input.database,
      request,
      accessToken: credential,
      destinationId: input.destination,
      messages,
      ...records,
    })));
    const flattened = attempts.flat();
    const delivered = flattened.every((attempt) => attempt.outcome === 'succeeded');
    return {
      channel,
      destination: input.destination,
      delivered,
      messages: texts.length,
      requests: batches.length,
      externalId: flattened.find((attempt) => attempt.externalId)?.externalId ?? null,
      error: delivered ? null : 'LINE refused the message.',
    };
  }

  let externalId: string | null = null;
  for (const [index, text] of texts.entries()) {
    try {
      const sent = await sendDiscordMessage({ fetch: request, botToken: credential, channelId: input.destination, text });
      externalId = externalId ?? sent.externalId;
      await recordDeliveryAttempt(input.database, {
        ...records,
        destination: input.destination,
        channel,
        outcome: 'succeeded',
        externalId: sent.externalId,
      });
    } catch (error) {
      const failure = await failedAt({
        database: input.database,
        channel,
        destination: input.destination,
        messages: texts.length - index,
        requests: index,
        error: error instanceof Error ? error.message : 'Discord refused the message.',
        ...records,
      });
      return { ...failure, messages: texts.length, externalId };
    }
  }
  return {
    channel,
    destination: input.destination,
    delivered: true,
    messages: texts.length,
    requests: texts.length,
    externalId,
    error: null,
  };
};

/**
 * Sends the same messages to several addresses, each address once.
 *
 * Two Contacts sharing one group destination, or a Channel Handle List naming
 * the same room twice, must not make the same message arrive twice; deduplicating
 * here means no caller has to remember to.
 */
export const sendToDestinations = async (input: {
  database: D1Database;
  credentials: ChannelCredentials;
  channel: string;
  destinations: readonly string[];
  texts: readonly string[];
  eventId?: string | null;
  sourceMessageId?: string | null;
  fetch?: ChannelFetch;
}): Promise<ChannelOutcome[]> => Promise.all(
  [...new Set(input.destinations)].map((destination) => sendOnDestination({ ...input, destination })),
);

/**
 * Sends to one Contact on one Channel, and leaves a Delivery Record either way.
 *
 * A refusal throws, because the surfaces that reach a single Contact — the MCP
 * Server, a scheduled reminder, a Channel Test — each have to report the failure
 * to whoever asked rather than absorb it.
 *
 * Suppression is not consulted here: what a repeat means differs between an
 * Access Token, an Automation and a Channel Test, so the caller that knows the
 * scope decides, and this seam only ever performs the send it was given.
 */
export const sendOnChannel = async (input: {
  database: D1Database;
  credentials: ChannelCredentials;
  contactId: string;
  channel: string;
  texts: readonly string[];
  /** The Source Message this send answers, so its Delivery Record names it. */
  sourceMessageId?: string | null;
  fetch?: ChannelFetch;
}): Promise<ChannelDelivery> => {
  if (!isChannelName(input.channel)) throw invalid(`This product does not reach a Contact on ${input.channel} yet.`);
  const channel = input.channel;
  const texts = stated(input.texts);
  const destination = await destinationFor({ database: input.database, contactId: input.contactId, channel });
  if (!destination) throw conflict(`Contact ${input.contactId} has no ${channel === 'line' ? 'LINE' : 'Discord'} handle to reach.`);
  const outcome = await sendOnDestination({ ...input, channel, destination, texts });
  if (!outcome.delivered) throw conflict(outcome.error ?? `${channel} refused the message.`);
  return {
    delivered: true,
    channel,
    contactId: input.contactId,
    destination,
    messages: outcome.messages,
    requests: outcome.requests,
    externalId: outcome.externalId,
  };
};

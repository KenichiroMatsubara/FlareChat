/**
 * Reaching one Contact on one Channel (ADR 0143, ADR 0158).
 *
 * Every surface that speaks to a Contact — the MCP Server an outside agent
 * calls, a scheduled reminder, an Automation run, and the Channel Test an
 * operator runs by hand — passes through here, so none of them can reach LINE by
 * a path the others do not. What a caller states is a Contact, a Channel and a
 * text; resolving the Connection, the handle, the provider request and the
 * Delivery Record is this module's work, and a refusal is reported as the
 * failure it was rather than a synthesised success (ADR 0142).
 */

import { and, asc, eq, inArray, like, or } from 'drizzle-orm';

import { decrypt } from './cryptography';
import { deliverLineBatch, recordDeliveryAttempt } from './delivery';
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

/** What one attempt to reach a Contact did. A failure throws rather than returning this. */
export interface ChannelDelivery {
  delivered: true;
  channel: ChannelName;
  contactId: string;
  destination: string;
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

/**
 * Sends one message to one Contact now, and leaves a Delivery Record either way.
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
  text: string;
  fetch?: ChannelFetch;
}): Promise<ChannelDelivery> => {
  if (!isChannelName(input.channel)) throw new Error(`This product does not reach a Contact on ${input.channel} yet.`);
  const channel = input.channel;
  const text = input.text.trim();
  if (!text) throw new Error('A message needs something to say.');
  const credential = input.credentials[channel];
  if (!credential) throw new Error(`This Account has no ${channel === 'line' ? 'LINE' : 'Discord'} Connection to send through.`);
  const destination = await destinationFor({ database: input.database, contactId: input.contactId, channel });
  if (!destination) throw new Error(`Contact ${input.contactId} has no ${channel === 'line' ? 'LINE' : 'Discord'} handle to reach.`);
  const request = input.fetch ?? ((url, init) => fetch(url, init));

  if (channel === 'line') {
    const [attempt] = await deliverLineBatch({
      database: input.database,
      accessToken: credential,
      destinationId: destination,
      messages: [text],
    });
    if (attempt?.outcome !== 'succeeded') throw new Error('LINE refused the message.');
    return { delivered: true, channel, contactId: input.contactId, destination, externalId: attempt.externalId };
  }

  try {
    const sent = await sendDiscordMessage({ fetch: request, botToken: credential, channelId: destination, text });
    await recordDeliveryAttempt(input.database, {
      destination,
      channel,
      outcome: 'succeeded',
      externalId: sent.externalId,
    });
    return { delivered: true, channel, contactId: input.contactId, destination, externalId: sent.externalId };
  } catch (error) {
    await recordDeliveryAttempt(input.database, { destination, channel, outcome: 'failed', externalId: null });
    throw error;
  }
};

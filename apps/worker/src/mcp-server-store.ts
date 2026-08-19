/**
 * Binds the MCP Server of ADR 0152 to one Account's database: which Token called,
 * what it was granted, whom it may reach, and how its writes actually happen.
 */

import { and, asc, eq, inArray, like, or } from 'drizzle-orm';

import { accessTokenHash, withinCallLimits } from './access-token';
import { deliverLineBatch } from './delivery';
import { sendDiscordMessage } from './discord';
import { recordDeliveryAttempt } from './delivery';
import { enqueueJob } from './jobs';
import { suppressionExpiry, suppressionHolds, type SuppressionWindow } from './suppression';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import {
  accessTokenCalls,
  accessTokens,
  accessTokenTools,
  contactListMembers,
  channelHandles,
  contactLineDestinations,
  contacts,
  jobs as jobsTable,
  lineDestinations,
  prompts,
  suppressions,
} from './storage/account-schema';
import type { McpServerPorts, McpServerPrompt } from './mcp-server';

export interface AuthenticatedAccessToken {
  id: string;
  name: string;
  grant: string[];
  contactIds: string[];
  suppressionWindow: SuppressionWindow;
  callsPerHour: number;
  writesPerDay: number;
}

/** Resolves the presented credential, or null when it is not this Account's. */
export const authenticateAccessToken = async (input: {
  database: D1Database;
  presented: string;
}): Promise<AuthenticatedAccessToken | null> => {
  const db = drizzleAccountDatabase(input.database);
  const hash = await accessTokenHash(input.presented);
  const row = await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, hash)).get();
  if (!row) return null;
  const [grantRows, listRows] = await Promise.all([
    db.select({ tool: accessTokenTools.tool }).from(accessTokenTools).where(eq(accessTokenTools.tokenId, row.id)).all(),
    db.select({ contactId: contactListMembers.contactId }).from(contactListMembers)
      .where(eq(contactListMembers.listId, row.contactListId)).all(),
  ]);
  return {
    id: row.id,
    name: row.name,
    grant: grantRows.map(({ tool }) => tool),
    contactIds: listRows.map(({ contactId }) => contactId),
    suppressionWindow: row.suppressionWindow,
    callsPerHour: row.callsPerHour,
    writesPerDay: row.writesPerDay,
  };
};

export const admitAccessTokenCall = async (input: {
  database: D1Database;
  token: AuthenticatedAccessToken;
  tool: string;
  isWrite: boolean;
  at: Date;
}): Promise<{ admitted: boolean; reason?: string }> => {
  const db = drizzleAccountDatabase(input.database);
  const recent = await db.select({ createdAt: accessTokenCalls.createdAt, isWrite: accessTokenCalls.isWrite })
    .from(accessTokenCalls).where(eq(accessTokenCalls.tokenId, input.token.id)).all();
  const outcome = withinCallLimits({
    limits: { callsPerHour: input.token.callsPerHour, writesPerDay: input.token.writesPerDay },
    recent,
    isWrite: input.isWrite,
    at: input.at,
  });
  if (!outcome.admitted) return outcome;
  const timestamp = input.at.toISOString();
  await db.insert(accessTokenCalls).values({
    id: crypto.randomUUID(),
    tokenId: input.token.id,
    tool: input.tool,
    isWrite: input.isWrite,
    createdAt: timestamp,
  }).run();
  await db.update(accessTokens).set({ lastUsedAt: timestamp, updatedAt: timestamp })
    .where(eq(accessTokens.id, input.token.id)).run();
  return { admitted: true };
};

export const suppressionPort = (input: { database: D1Database; scope: string; window: SuppressionWindow; at: Date }) => {
  const db = drizzleAccountDatabase(input.database);
  return {
    check: async (key: string): Promise<boolean> => {
      const row = await db.select({ expiresAt: suppressions.expiresAt }).from(suppressions).where(eq(suppressions.key, key)).get();
      if (!row) return false;
      if (suppressionHolds({ expiresAt: row.expiresAt, at: input.at })) return true;
      await db.delete(suppressions).where(eq(suppressions.key, key)).run();
      return false;
    },
    record: async (key: string): Promise<void> => {
      const timestamp = input.at.toISOString();
      await db.insert(suppressions).values({
        key,
        scope: input.scope,
        tool: key.split(' ')[1] ?? '',
        recordedAt: timestamp,
        expiresAt: suppressionExpiry({ window: input.window, at: input.at }),
      }).onConflictDoUpdate({
        target: suppressions.key,
        set: { recordedAt: timestamp, expiresAt: suppressionExpiry({ window: input.window, at: input.at }) },
      }).run();
    },
  };
};

export const publishedPrompts = async (database: D1Database): Promise<McpServerPrompt[]> => {
  const rows = await drizzleAccountDatabase(database).select({
    name: prompts.name,
    instructions: prompts.instructions,
  }).from(prompts).where(eq(prompts.published, true)).orderBy(asc(prompts.name)).all();
  return rows.map((row) => ({
    name: row.name,
    description: row.instructions.split('\n')[0]?.slice(0, 120) ?? row.name,
    instructions: row.instructions,
  }));
};

/** Where a Contact is reachable on Discord: the channel to post in, or null when it has no handle. */
const discordTargetFor = async (database: D1Database, contactId: string): Promise<string | null> => {
  const row = await drizzleAccountDatabase(database).select({
    replyTarget: channelHandles.replyTarget,
    externalId: channelHandles.externalId,
  }).from(channelHandles)
    .where(and(eq(channelHandles.contactId, contactId), eq(channelHandles.channel, 'discord'), eq(channelHandles.isPrimary, true)))
    .get();
  return row?.replyTarget ?? null;
};

/** The LINE destination a Contact is reachable at, or null when it has none. */
const lineDestinationFor = async (database: D1Database, contactId: string): Promise<string | null> => {
  const row = await drizzleAccountDatabase(database).select({ destinationId: lineDestinations.destinationId })
    .from(contactLineDestinations)
    .innerJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
    .where(eq(contactLineDestinations.contactId, contactId))
    .get();
  return row?.destinationId ?? null;
};

export const mcpServerPorts = (input: {
  database: D1Database;
  lineAccessToken: string | null;
  discordBotToken?: string | null;
}): McpServerPorts => {
  const db = drizzleAccountDatabase(input.database);
  return {
    searchContacts: async ({ query, contactIds }) => {
      if (!contactIds.length) return [];
      const term = `%${query}%`;
      const rows = await db.select({ id: contacts.id, name: contacts.name, email: contacts.email, state: contacts.state })
        .from(contacts)
        .where(and(
          inArray(contacts.id, [...contactIds]),
          query ? or(like(contacts.name, term), like(contacts.email, term)) : undefined,
        ))
        .orderBy(asc(contacts.name)).limit(200).all();
      return Promise.all(rows.map(async (row) => ({
        ...row,
        channels: [
          ...(await lineDestinationFor(input.database, row.id) ? ['line'] : []),
          ...(await discordTargetFor(input.database, row.id) ? ['discord'] : []),
        ],
      })));
    },
    sendToContact: async ({ contactId, channel, text }) => {
      if (channel === 'discord') {
        if (!input.discordBotToken) throw new Error('This Account has no Discord Connection to send through.');
        const target = await discordTargetFor(input.database, contactId);
        if (!target) throw new Error(`Contact ${contactId} has no Discord handle to reach.`);
        const sent = await sendDiscordMessage({
          fetch: (url, init) => fetch(url, init),
          botToken: input.discordBotToken,
          channelId: target,
          text,
        });
        await recordDeliveryAttempt(input.database, {
          destination: target,
          channel: 'discord',
          outcome: 'succeeded',
          externalId: sent.externalId,
        });
        return { delivered: true, channel: 'discord', contactId };
      }
      if (channel !== 'line') throw new Error(`This server does not reach a Contact on ${channel} yet.`);
      if (!input.lineAccessToken) throw new Error('This Account has no LINE Connection to send through.');
      const destination = await lineDestinationFor(input.database, contactId);
      if (!destination) throw new Error(`Contact ${contactId} has no LINE handle to reach.`);
      const [attempt] = await deliverLineBatch({
        database: input.database,
        accessToken: input.lineAccessToken,
        destinationId: destination,
        messages: [text],
      });
      if (attempt?.outcome !== 'succeeded') throw new Error('LINE refused the message.');
      return { delivered: true, channel: 'line', contactId };
    },
    scheduleReminder: async ({ contactId, channel, text, at }) => {
      if (channel !== 'line' && channel !== 'discord') throw new Error(`This server does not reach a Contact on ${channel} yet.`);
      const job = await enqueueJob(input.database, {
        kind: 'mcp.reminder',
        payload: { contactId, channel, text },
        idempotencyKey: `mcp-reminder:${contactId}:${at}:${text}`,
      });
      await drizzleAccountDatabase(input.database).update(jobsTable).set({ availableAt: at, updatedAt: at })
        .where(eq(jobsTable.id, job.id)).run();
      return { scheduled: true, at, contactId };
    },
  };
};

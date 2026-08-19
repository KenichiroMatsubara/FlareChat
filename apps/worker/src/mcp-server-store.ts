/**
 * Binds the MCP Server of ADR 0152 to one Account's database: which Token called,
 * what it was granted, whom it may reach, and how its writes actually happen.
 */

import { asc, eq } from 'drizzle-orm';

import { accessTokenHash, withinCallLimits } from './access-token';
import { isChannelName, reachableContacts, sendOnChannel, type ChannelCredentials } from './channel';
import { enqueueJob } from './jobs';
import { suppressionExpiry, suppressionHolds, type SuppressionWindow } from './suppression';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import {
  accessTokenCalls,
  accessTokens,
  accessTokenTools,
  contactListMembers,
  jobs as jobsTable,
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

export const mcpServerPorts = (input: {
  database: D1Database;
  credentials: ChannelCredentials;
}): McpServerPorts => ({
  searchContacts: ({ query, contactIds }) => reachableContacts({ database: input.database, query, contactIds }),
  sendToContact: async ({ contactId, channel, text }) => {
    const delivery = await sendOnChannel({
      database: input.database,
      credentials: input.credentials,
      contactId,
      channel,
      texts: [text],
    });
    return { delivered: delivery.delivered, channel: delivery.channel, contactId: delivery.contactId };
  },
  scheduleReminder: async ({ contactId, channel, text, at }) => {
    if (!isChannelName(channel)) throw new Error(`This server does not reach a Contact on ${channel} yet.`);
    const job = await enqueueJob(input.database, {
      kind: 'mcp.reminder',
      payload: { contactId, channel, text },
      idempotencyKey: `mcp-reminder:${contactId}:${at}:${text}`,
    });
    await drizzleAccountDatabase(input.database).update(jobsTable).set({ availableAt: at, updatedAt: at })
      .where(eq(jobsTable.id, job.id)).run();
    return { scheduled: true, at, contactId };
  },
});

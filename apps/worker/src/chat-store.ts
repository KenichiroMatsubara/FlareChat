/**
 * Persistence for Operator Chat.
 *
 * Every exchange is recorded as a Rule Run (ADR 0146), so suppression, effect
 * accounting and history are the ones the unattended surface already uses rather
 * than a second set written for chat.
 */

import { and, asc, desc, eq } from 'drizzle-orm';

import { decrypt, encrypt } from './cryptography';
import { accountDatabase as drizzleAccountDatabase } from './storage/database';
import {
  attendance,
  chatConversations,
  chatTurns,
  contacts,
  events,
  mcpServers,
  ruleRuns,
  tasks,
} from './storage/account-schema';
import type { ChatInternalHandlers, ChatMessage, ChatServer } from './chat';

const mcpTokenContext = (accountId: string, serverId: string): string => `mcp-server-token:${accountId}:${serverId}`;

export interface ChatConversationView {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatTurnView {
  id: string;
  position: number;
  request: string;
  response: string | null;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
  ruleRunId: string;
}

/** Read tools backed by this Account's own database. */
export const chatInternalHandlers = (database: D1Database): ChatInternalHandlers => {
  const db = drizzleAccountDatabase(database);
  return {
    query_scheduled_events: async () => db.select({
      id: events.id, title: events.title, startsAt: events.startsAt, endsAt: events.endsAt,
      location: events.location, status: events.status,
    }).from(events).orderBy(asc(events.startsAt)).limit(100).all(),
    query_contacts: async () => db.select({
      id: contacts.id, name: contacts.name, email: contacts.email, state: contacts.state, tags: contacts.tags,
    }).from(contacts).orderBy(asc(contacts.name)).limit(500).all(),
    query_tasks: async () => db.select({
      id: tasks.id, title: tasks.title, deadline: tasks.deadline, completed: tasks.completed,
      assigneeRoleName: tasks.assigneeRoleName, description: tasks.description,
    }).from(tasks).orderBy(asc(tasks.deadline)).limit(100).all(),
    query_attendance: async () => db.select({
      eventId: attendance.eventId, contact: contacts.name, status: attendance.status, comment: attendance.comment,
    }).from(attendance).innerJoin(contacts, eq(contacts.id, attendance.contactId)).limit(500).all(),
  };
};

export const listChatServers = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
}): Promise<ChatServer[]> => {
  const rows = await drizzleAccountDatabase(input.database).select().from(mcpServers).orderBy(asc(mcpServers.name)).all();
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    name: row.name,
    connection: {
      url: row.url,
      ...(row.tokenEnvelope
        ? { token: await decrypt(JSON.parse(row.tokenEnvelope), input.accountKey, mcpTokenContext(input.accountId, row.id)) }
        : {}),
      ...(row.revision ? { revision: row.revision } : {}),
    },
  })));
};

export const saveChatServer = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
  id: string;
  name: string;
  url: string;
  token: string | null;
  revision: '2026-07-28' | '2025-06-18' | null;
  timestamp: string;
}): Promise<void> => {
  const envelope = input.token
    ? JSON.stringify(await encrypt(input.token, input.accountKey, mcpTokenContext(input.accountId, input.id)))
    : null;
  await drizzleAccountDatabase(input.database).insert(mcpServers).values({
    id: input.id,
    accountId: input.accountId,
    name: input.name,
    url: input.url,
    tokenEnvelope: envelope,
    revision: input.revision,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  }).onConflictDoUpdate({
    target: mcpServers.id,
    set: { name: input.name, url: input.url, tokenEnvelope: envelope, revision: input.revision, updatedAt: input.timestamp },
  }).run();
};

export const deleteChatServer = async (input: { database: D1Database; id: string }): Promise<void> => {
  await drizzleAccountDatabase(input.database).delete(mcpServers).where(eq(mcpServers.id, input.id)).run();
};

export const listChatConversations = async (database: D1Database): Promise<ChatConversationView[]> =>
  drizzleAccountDatabase(database).select({ id: chatConversations.id, title: chatConversations.title, updatedAt: chatConversations.updatedAt })
    .from(chatConversations).orderBy(desc(chatConversations.updatedAt)).limit(50).all();

export const readChatTurns = async (input: { database: D1Database; conversationId: string }): Promise<ChatTurnView[]> =>
  drizzleAccountDatabase(input.database).select({
    id: chatTurns.id, position: chatTurns.position, request: chatTurns.request,
    response: chatTurns.response, status: chatTurns.status, error: chatTurns.error, ruleRunId: chatTurns.ruleRunId,
  }).from(chatTurns).where(eq(chatTurns.conversationId, input.conversationId)).orderBy(asc(chatTurns.position)).all();

/** Replays completed exchanges as the model messages a new turn continues from. */
export const chatHistory = async (input: { database: D1Database; conversationId: string }): Promise<ChatMessage[]> => {
  const turns = await readChatTurns(input);
  return turns.flatMap((turn) => turn.status === 'completed' && turn.response !== null
    ? [{ role: 'user' as const, content: turn.request }, { role: 'assistant' as const, content: turn.response }]
    : []);
};

export const ensureChatConversation = async (input: {
  database: D1Database;
  accountId: string;
  conversationId: string | null;
  title: string;
  timestamp: string;
}): Promise<string> => {
  const db = drizzleAccountDatabase(input.database);
  if (input.conversationId) {
    const existing = await db.select({ id: chatConversations.id }).from(chatConversations)
      .where(eq(chatConversations.id, input.conversationId)).get();
    if (!existing) throw new Error('Operator Chat conversation was not found.');
    await db.update(chatConversations).set({ updatedAt: input.timestamp }).where(eq(chatConversations.id, input.conversationId)).run();
    return input.conversationId;
  }
  const id = crypto.randomUUID();
  await db.insert(chatConversations).values({
    id,
    accountId: input.accountId,
    title: input.title.slice(0, 80) || 'Operator Chat',
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  }).run();
  return id;
};

/** Opens the Rule Run and the turn that records one exchange, before the model is asked anything. */
export const openChatTurn = async (input: {
  database: D1Database;
  conversationId: string;
  request: string;
  timestamp: string;
}): Promise<{ turnId: string; ruleRunId: string; position: number }> => {
  const db = drizzleAccountDatabase(input.database);
  const last = await db.select({ position: chatTurns.position }).from(chatTurns)
    .where(eq(chatTurns.conversationId, input.conversationId)).orderBy(desc(chatTurns.position)).limit(1).get();
  const position = (last?.position ?? 0) + 1;
  const ruleRunId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  await db.insert(ruleRuns).values({
    id: ruleRunId,
    ruleId: null,
    agentRuleId: null,
    ruleRevision: 1,
    sourceMessageId: null,
    executionMode: 'unattended',
    intent: 'chat',
    status: 'planning',
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  }).run();
  await db.insert(chatTurns).values({
    id: turnId,
    conversationId: input.conversationId,
    ruleRunId,
    position,
    request: input.request,
    response: null,
    status: 'running',
    error: null,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  }).run();
  return { turnId, ruleRunId, position };
};

export const closeChatTurn = async (input: {
  database: D1Database;
  turnId: string;
  ruleRunId: string;
  outcome: { status: 'completed'; response: string } | { status: 'failed'; error: string };
  timestamp: string;
}): Promise<void> => {
  const db = drizzleAccountDatabase(input.database);
  await db.update(chatTurns).set({
    status: input.outcome.status,
    response: input.outcome.status === 'completed' ? input.outcome.response : null,
    error: input.outcome.status === 'failed' ? input.outcome.error : null,
    updatedAt: input.timestamp,
  }).where(eq(chatTurns.id, input.turnId)).run();
  await db.update(ruleRuns).set({
    status: input.outcome.status === 'completed' ? 'completed' : 'failed',
    updatedAt: input.timestamp,
  }).where(and(eq(ruleRuns.id, input.ruleRunId), eq(ruleRuns.intent, 'chat'))).run();
};

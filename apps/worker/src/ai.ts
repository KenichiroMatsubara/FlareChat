import { and, eq } from 'drizzle-orm';

import { decrypt } from './cryptography';
import { accountKeyFor } from './keys';
import { accountDatabase } from './storage/database';
import { connections } from './storage/account-schema';
import type { Bindings } from './types';

/** The OpenAI-compatible endpoint the product used before an Account could choose its own. */
export const LEGACY_AI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export interface AiConnection {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface AiCredential {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/**
 * The Account's AI Connection as the model provider needs it, or null when none
 * is configured. Reading it is the one place the credential is decrypted, so
 * every caller that thinks with a model agrees on what "configured" means.
 */
export const aiConnection = async (env: Bindings, accountId: string, database: D1Database): Promise<AiConnection | null> => {
  const connection = await accountDatabase(database).select().from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) return null;
  const key = await accountKeyFor(env, accountId);
  const credential = JSON.parse(await decrypt(JSON.parse(connection.credential), key, `organization-connection:${accountId}:ai`)) as AiCredential;
  if (!credential.apiKey || !credential.model) return null;
  return { apiKey: credential.apiKey, baseUrl: credential.baseUrl || LEGACY_AI_BASE_URL, model: credential.model };
};

/** The AI Connection, or the refusal an operator reads when there is none. */
export const requiredAiConnection = async (env: Bindings, accountId: string, database: D1Database): Promise<AiConnection> => {
  const connection = await aiConnection(env, accountId, database);
  if (!connection) throw new Error('先に OpenAI 互換 API を設定してください。');
  return connection;
};

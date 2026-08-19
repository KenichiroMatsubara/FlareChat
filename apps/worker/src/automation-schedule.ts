/**
 * Deployment-facing scheduling of Automations: finds each Account's due Triggers
 * and runs them. An Automation is moved to its next stated time before it runs,
 * so a slow run cannot be picked up a second time while it is still going.
 */

import { and, eq, isNotNull } from 'drizzle-orm';

import { advanceAutomation, dueAutomations, runAutomation, type AutomationRunOutcome } from './automation-run';
import { chatInternalHandlers, listChatServers } from './chat-store';
import { completeChatTurn } from './chat-model';
import { createDatabaseAccess } from './database-access';
import { createRequestContext } from './routes/request-context';
import { decrypt } from './cryptography';
import { mcpServerPorts, suppressionPort } from './mcp-server-store';
import { controlDatabase, accountDatabase as drizzleAccountDatabase } from './storage/database';
import { accounts } from './storage/control-schema';
import { connections } from './storage/account-schema';
import { normalizedAiBaseUrl } from './event-details';
import type { Bindings } from './types';

interface AccountCredential {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  channelAccessToken?: string;
  botToken?: string;
}

const credentialFor = async (input: {
  database: D1Database;
  accountKey: CryptoKey;
  accountId: string;
  kind: 'ai' | 'line' | 'discord';
}): Promise<AccountCredential | null> => {
  const row = await drizzleAccountDatabase(input.database).select().from(connections)
    .where(and(eq(connections.kind, input.kind), eq(connections.status, 'active'))).limit(1).get();
  if (!row) return null;
  return JSON.parse(
    await decrypt(JSON.parse(row.credential), input.accountKey, `organization-connection:${input.accountId}:${input.kind}`),
  ) as AccountCredential;
};

export const runDueAccountAutomations = async (env: Bindings, at: Date): Promise<AutomationRunOutcome[]> => {
  const activeAccounts = await controlDatabase(env.CONTROL_DB).select({
    id: accounts.id,
    bindingName: accounts.bindingName,
    databaseId: accounts.databaseId,
  }).from(accounts).where(and(eq(accounts.status, 'active'), isNotNull(accounts.databaseId))).all();

  const outcomes: AutomationRunOutcome[] = [];
  const databases = createDatabaseAccess(env);
  for (const account of activeAccounts) {
    const opened = await databases.open({
      kind: 'organization',
      bindingName: account.bindingName,
      databaseId: account.databaseId,
    });
    const due = await dueAutomations({ database: opened.raw, at });
    if (!due.length) continue;

    const accountKey = await createRequestContext(new Request('https://request-context.invalid'), env).accountKey(account.id);
    const ai = await credentialFor({ database: opened.raw, accountKey, accountId: account.id, kind: 'ai' });
    const model = ai?.model?.trim();
    const baseUrl = normalizedAiBaseUrl(ai?.baseUrl) ?? '';
    const line = await credentialFor({ database: opened.raw, accountKey, accountId: account.id, kind: 'line' });
    const discord = await credentialFor({ database: opened.raw, accountKey, accountId: account.id, kind: 'discord' });
    const servers = await listChatServers({ database: opened.raw, accountKey, accountId: account.id });

    for (const automation of due) {
      await advanceAutomation({
        database: opened.raw,
        automationId: automation.id,
        schedule: automation.schedule,
        offsetMinutes: automation.offsetMinutes,
        at,
      });
      if (!ai?.apiKey || !model || !baseUrl) {
        outcomes.push({
          automationId: automation.id,
          runId: '',
          status: 'failed',
          output: '',
          toolCalls: 0,
          unreachableServers: [],
        });
        continue;
      }
      outcomes.push(await runAutomation({
        database: opened.raw,
        automation,
        servers,
        fetch: (url, init) => fetch(url, init),
        model: { complete: completeChatTurn },
        connection: { apiKey: ai.apiKey, baseUrl, model },
        readHandlers: chatInternalHandlers(opened.raw),
        ports: mcpServerPorts({
          database: opened.raw,
          lineAccessToken: line?.channelAccessToken ?? null,
          discordBotToken: discord?.botToken ?? null,
        }),
        suppression: suppressionPort({ database: opened.raw, scope: automation.id, window: automation.suppressionWindow, at }),
        at,
      }));
    }
  }
  return outcomes;
};

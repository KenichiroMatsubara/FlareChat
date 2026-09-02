import { asc } from 'drizzle-orm';

import { deleteChatServer, listChatServers, saveChatServer } from '../chat-store';
import { now } from '../clock';
import { callMcpTool, listMcpTools } from '../mcp';
import type { Providers } from '../providers';
import { invalid, notFound } from '../refusal';
import { resource } from '../response';
import { mcpServers } from '../storage/account-schema';
import { accountRoute } from './account';

const MCP_REVISIONS = ['2026-07-28', '2025-06-18'] as const;
type McpRevision = (typeof MCP_REVISIONS)[number];

/** The remote MCP Servers an Account registered, and calling one for real (ADR 0142, ADR 0158). */
export const serverRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/mcp-servers', accountRoute(async ({ db }) => {
    const rows = await db.select().from(mcpServers).orderBy(asc(mcpServers.name)).all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      revision: row.revision,
      authenticated: Boolean(row.tokenEnvelope),
      updatedAt: row.updatedAt,
    }));
  }));

  routes.put('/organizations/:accountId/mcp-servers/:serverId', accountRoute<{ name?: string; url?: string; token?: string | null; revision?: string | null }>(async (request) => {
    const name = request.body.name?.trim() ?? '';
    const url = request.body.url?.trim() ?? '';
    if (!name || name.length > 40 || !/^[a-z0-9_-]+$/u.test(name)) {
      throw invalid('MCP Server 名は英小文字・数字・ハイフン・アンダースコアで 1〜40 文字にしてください。');
    }
    if (!/^https:\/\//u.test(url)) throw invalid('MCP Server の URL は https で始まる必要があります。');
    const revision = request.body.revision ?? null;
    if (revision !== null && !MCP_REVISIONS.includes(revision as McpRevision)) throw invalid('MCP のリビジョン指定が不正です。');
    const id = request.params.serverId ?? '';
    await saveChatServer({
      database: request.database,
      accountKey: await request.key(),
      accountId: request.accountId,
      id,
      name,
      url,
      token: request.body.token?.trim() || null,
      revision: revision as McpRevision | null,
      timestamp: now(),
    });
    return { id, name, url };
  }));

  routes.delete('/organizations/:accountId/mcp-servers/:serverId', accountRoute(async (request) => {
    const id = request.params.serverId ?? '';
    await deleteChatServer({ database: request.database, id });
    return { id, deleted: true };
  }));

  /**
   * Without a tool name this lists what the server offers, which is the cheapest
   * proof that the URL, the token and the revision are right. With one it calls
   * that tool with the arguments given and returns the server's own answer,
   * failures included, so a LINE MCP Server can be made to send a real message.
   */
  routes.post('/organizations/:accountId/mcp-servers/:serverId/tests', accountRoute<{ tool?: string; arguments?: unknown }>(async (request) => {
    const serverId = request.params.serverId ?? '';
    const servers = await listChatServers({ database: request.database, accountKey: await request.key(), accountId: request.accountId });
    const server = servers.find(({ id }) => id === serverId);
    if (!server) throw notFound('その MCP Server は登録されていません。');
    const tool = request.body.tool?.trim() ?? '';
    if (!tool) return { server: server.name, tools: await listMcpTools({ connection: server.connection, fetch: providers.fetch }) };
    const argument = request.body.arguments;
    if (argument !== undefined && (typeof argument !== 'object' || argument === null || Array.isArray(argument))) {
      throw invalid('ツールの引数は JSON オブジェクトで指定してください。');
    }
    const result = await callMcpTool({
      connection: server.connection,
      fetch: providers.fetch,
      name: tool,
      arguments: (argument ?? {}) as Record<string, unknown>,
    });
    return { server: server.name, tool, isError: result.isError, text: result.text };
  }));

  return routes;
};

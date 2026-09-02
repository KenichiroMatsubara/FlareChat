import { asc, eq, inArray } from 'drizzle-orm';
import type { AccessToken, IssuedAccessToken } from '@mail/domain';

import { accessTokenHash, generateAccessToken, presentedToken } from '../access-token';
import { channelCredentials } from '../channel';
import { now } from '../clock';
import { grantedServerTools, handleMcpServerRequest, MCP_SERVER_TOOLS, type JsonRpcRequest } from '../mcp-server';
import {
  admitAccessTokenCall,
  authenticateAccessToken,
  mcpServerPorts,
  publishedPrompts,
  suppressionPort,
} from '../mcp-server-store';
import { invalid, notFound } from '../refusal';
import { resource } from '../response';
import { accessTokens, accessTokenTools, contactLists } from '../storage/account-schema';
import { SUPPRESSION_WINDOWS, type SuppressionWindow } from '../suppression';
import { activeAccountDatabase } from './request-context';
import { accountKeyFor } from '../keys';
import { accountRoute } from './account';

export const tokenRoutes = resource();

tokenRoutes.get('/organizations/:accountId/access-tokens', accountRoute(async ({ db }): Promise<AccessToken[]> => {
  const rows = await db.select().from(accessTokens).orderBy(asc(accessTokens.name)).all();
  const grants = rows.length
    ? await db.select().from(accessTokenTools).where(inArray(accessTokenTools.tokenId, rows.map(({ id }) => id))).all()
    : [];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    contactListId: row.contactListId,
    suppressionWindow: row.suppressionWindow,
    callsPerHour: row.callsPerHour,
    writesPerDay: row.writesPerDay,
    lastUsedAt: row.lastUsedAt,
    tools: grants.flatMap((grant) => grant.tokenId === row.id ? [grant.tool] : []),
  }));
}));

/** Issues a Token once; the credential is shown here and never again, because only its hash is stored. */
tokenRoutes.post('/organizations/:accountId/access-tokens', accountRoute<{ name?: string; contactListId?: string; tools?: unknown; suppressionWindow?: string; callsPerHour?: number; writesPerDay?: number }>(async ({ db, env, accountId, body }): Promise<IssuedAccessToken> => {
  const name = body.name?.trim() ?? '';
  const contactListId = body.contactListId?.trim() ?? '';
  if (!name || name.length > 60) throw invalid('Access Token 名は 1〜60 文字で入力してください。');
  if (!contactListId) throw invalid('到達できる Contact List を選んでください。');
  const requested = Array.isArray(body.tools) ? body.tools.filter((tool): tool is string => typeof tool === 'string') : [];
  const tools = grantedServerTools(requested).map((tool) => tool.name);
  if (!tools.length) throw invalid('許可するツールを1つ以上選んでください。');
  const window = body.suppressionWindow ?? 'day';
  if (!SUPPRESSION_WINDOWS.includes(window as SuppressionWindow)) throw invalid('重複抑止の窓の指定が不正です。');
  const list = await db.select({ id: contactLists.id }).from(contactLists).where(eq(contactLists.id, contactListId)).get();
  if (!list) throw notFound('指定された Contact List が見つかりません。');
  const token = generateAccessToken();
  const id = crypto.randomUUID();
  const timestamp = now();
  await db.insert(accessTokens).values({
    id,
    accountId,
    name,
    tokenHash: await accessTokenHash(token),
    contactListId,
    suppressionWindow: window as SuppressionWindow,
    callsPerHour: Math.max(1, Math.min(body.callsPerHour ?? 60, 1_000)),
    writesPerDay: Math.max(1, Math.min(body.writesPerDay ?? 100, 10_000)),
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run();
  for (const tool of tools) await db.insert(accessTokenTools).values({ tokenId: id, tool }).run();
  return {
    id,
    name,
    tools,
    token,
    url: `${env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(accountId)}/mcp`,
  };
}));

tokenRoutes.delete('/organizations/:accountId/access-tokens/:tokenId', accountRoute(async ({ db, params }) => {
  const tokenId = params.tokenId ?? '';
  await db.delete(accessTokens).where(eq(accessTokens.id, tokenId)).run();
  return { id: tokenId, revoked: true };
}));

/** The MCP Server an outside agent reaches (ADR 0152). Authenticated by Access Token alone, and answering in JSON-RPC even when it refuses. */
tokenRoutes.post('/public/organizations/:accountId/mcp', async (context) => {
  const rpcError = (code: number, message: string, status: 200 | 401 | 429 | 503) =>
    context.json({ jsonrpc: '2.0', id: null, error: { code, message } }, status);
  try {
    const accountId = context.req.param('accountId');
    const presented = presentedToken(context.req.raw);
    if (!presented) return rpcError(-32001, 'An Access Token must be presented in the Authorization header.', 401);
    const database = await activeAccountDatabase(context.env, accountId);
    if (!database) return rpcError(-32003, 'This Account is not available.', 503);
    const token = await authenticateAccessToken({ database, presented });
    if (!token) return rpcError(-32001, 'This Access Token is not recognised.', 401);

    const request = await context.req.json<JsonRpcRequest>();
    const at = new Date();
    const calledTool = request.method === 'tools/call' && typeof request.params?.name === 'string' ? request.params.name : null;
    const isWrite = MCP_SERVER_TOOLS.some((tool) => tool.name === calledTool && tool.isWrite);
    const admitted = await admitAccessTokenCall({ database, token, tool: calledTool ?? request.method, isWrite, at });
    if (!admitted.admitted) return rpcError(-32002, admitted.reason ?? 'This Access Token has spent its limit.', 429);

    const accountKey = await accountKeyFor(context.env, accountId);
    const response = await handleMcpServerRequest({
      request,
      grant: token.grant,
      contactIds: token.contactIds,
      prompts: await publishedPrompts(database),
      ports: mcpServerPorts({ database, credentials: await channelCredentials({ database, accountKey, accountId }) }),
      suppression: suppressionPort({ database, scope: token.id, window: token.suppressionWindow, at }),
      scope: token.id,
      window: token.suppressionWindow,
      at,
    });
    return context.json(response);
  } catch (error) {
    return rpcError(-32603, error instanceof Error ? error.message : 'The MCP Server failed.', 503);
  }
});

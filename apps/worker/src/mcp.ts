/**
 * Client for remote MCP Servers.
 *
 * Workers have no child processes, so only HTTP or SSE servers are reachable
 * (ADR 0143). Authentication is a static bearer token (ADR 0151). A tool's real
 * result is returned, failures included, because a synthesised success is not a
 * safer answer than a true one (ADR 0142).
 */

export type McpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Revisions this client speaks, newest first. The newest is stateless; the older one needs a handshake. */
export const MCP_REVISIONS = ['2026-07-28', '2025-06-18'] as const;
export type McpRevision = (typeof MCP_REVISIONS)[number];

const CLIENT_INFO = { name: 'flarechat', version: '1' } as const;

export interface McpConnection {
  url: string;
  token?: string;
  revision?: McpRevision;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  isError: boolean;
  text: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface ToolListResult {
  tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

const headersFor = (input: {
  connection: McpConnection;
  revision: McpRevision;
  method: string;
  name?: string;
  session?: string;
}): Record<string, string> => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': input.revision,
  ...(input.revision === '2026-07-28' ? { 'Mcp-Method': input.method } : {}),
  ...(input.revision === '2026-07-28' && input.name ? { 'Mcp-Name': input.name } : {}),
  ...(input.connection.token ? { Authorization: `Bearer ${input.connection.token}` } : {}),
  ...(input.session ? { 'Mcp-Session-Id': input.session } : {}),
});

/** Reads one JSON-RPC response whether the server answered with JSON or an event stream. */
const readEnvelope = async (response: Response): Promise<JsonRpcResponse> => {
  const body = await response.text();
  if (!response.headers.get('Content-Type')?.includes('text/event-stream')) {
    return JSON.parse(body || '{}') as JsonRpcResponse;
  }
  const payloads = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((line) => line && line !== '[DONE]');
  const last = payloads[payloads.length - 1];
  if (!last) throw new Error('MCP server sent an event stream carrying no message.');
  return JSON.parse(last) as JsonRpcResponse;
};

class McpProtocolRejection extends Error {}

const send = async (input: {
  connection: McpConnection;
  fetch: McpFetch;
  revision: McpRevision;
  method: string;
  name?: string;
  params?: Record<string, unknown>;
  session?: string;
  notification?: boolean;
}): Promise<{ result: unknown; session: string | null }> => {
  const id = crypto.randomUUID();
  const response = await input.fetch(input.connection.url, {
    method: 'POST',
    headers: headersFor(input),
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(input.notification ? {} : { id }),
      method: input.method,
      params: {
        ...(input.params ?? {}),
        _meta: { 'io.modelcontextprotocol/clientInfo': CLIENT_INFO },
      },
    }),
  });
  const session = response.headers.get('Mcp-Session-Id');
  if (input.notification) return { result: null, session };
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    const error = new Error(`MCP server ${input.connection.url} answered HTTP ${response.status}: ${detail}`);
    throw response.status >= 400 && response.status < 500 ? new McpProtocolRejection(error.message) : error;
  }
  const envelope = await readEnvelope(response);
  if (envelope.error) throw new Error(`MCP ${input.method} failed: ${envelope.error.message ?? `code ${envelope.error.code ?? 0}`}`);
  return { result: envelope.result, session };
};

/** Performs the handshake the older revision requires and returns its session, if the server issued one. */
const handshake = async (input: { connection: McpConnection; fetch: McpFetch }): Promise<string | null> => {
  const initialized = await send({
    ...input,
    revision: '2025-06-18',
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: CLIENT_INFO },
  });
  const session = initialized.session;
  await send({
    ...input,
    revision: '2025-06-18',
    method: 'notifications/initialized',
    notification: true,
    ...(session ? { session } : {}),
  });
  return session;
};

/**
 * Sends one request, trying the stateless revision first and falling back to the
 * handshake revision when the server rejects it. Most deployed servers still
 * speak the older one, so the fallback is the ordinary path rather than an edge.
 */
const request = async (input: {
  connection: McpConnection;
  fetch: McpFetch;
  method: string;
  name?: string;
  params?: Record<string, unknown>;
}): Promise<unknown> => {
  const preferred = input.connection.revision ?? MCP_REVISIONS[0];
  try {
    return (await send({ ...input, revision: preferred })).result;
  } catch (error) {
    if (!(error instanceof McpProtocolRejection) || preferred !== '2026-07-28') throw error;
  }
  const session = await handshake(input);
  return (await send({ ...input, revision: '2025-06-18', ...(session ? { session } : {}) })).result;
};

export const listMcpTools = async (input: { connection: McpConnection; fetch: McpFetch }): Promise<McpToolDefinition[]> => {
  const result = await request({ ...input, method: 'tools/list' }) as ToolListResult;
  return (result.tools ?? [])
    .filter((tool): tool is { name: string; description?: string; inputSchema?: Record<string, unknown> } => Boolean(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    }));
};

export const callMcpTool = async (input: {
  connection: McpConnection;
  fetch: McpFetch;
  name: string;
  arguments: Record<string, unknown>;
}): Promise<McpToolResult> => {
  const result = await request({
    connection: input.connection,
    fetch: input.fetch,
    method: 'tools/call',
    name: input.name,
    params: { name: input.name, arguments: input.arguments },
  }) as ToolCallResult;
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  return { isError: result.isError === true, text };
};

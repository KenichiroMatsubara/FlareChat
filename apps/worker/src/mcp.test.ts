import { describe, expect, it } from 'vitest';

import { callMcpTool, listMcpTools, type McpFetch } from './mcp';

const connection = { url: 'https://tools.example.com/mcp', token: 'secret-token' };

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });

const eventStreamResponse = (body: unknown): Response =>
  new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });

const rpcResult = (id: number | string, result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const recorder = (responses: Array<(request: RecordedRequest) => Response>): { fetch: McpFetch; requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetch: McpFetch = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const request = { url, headers, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> };
    requests.push(request);
    const responder = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (!responder) throw new Error('No stubbed MCP response.');
    return responder(request);
  };
  return { fetch, requests };
};

const TOOLS = [{ name: 'send_notice', description: 'Send a notice.', inputSchema: { type: 'object', properties: {} } }];

describe('MCP client', () => {
  it('lists tools from a stateless server without an initialize handshake', async () => {
    const { fetch, requests } = recorder([(request) => jsonResponse(rpcResult(request.body.id as number, { tools: TOOLS }))]);

    const tools = await listMcpTools({ connection, fetch });

    expect(tools).toEqual([{ name: 'send_notice', description: 'Send a notice.', inputSchema: { type: 'object', properties: {} } }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers['mcp-protocol-version']).toBe('2026-07-28');
    expect(requests[0]?.headers['mcp-method']).toBe('tools/list');
    expect(requests[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(requests[0]?.body.method).toBe('tools/list');
  });

  it('falls back to the handshake revision when a server rejects the stateless request', async () => {
    const { fetch, requests } = recorder([
      () => jsonResponse({ error: 'unsupported protocol version' }, { status: 400 }),
      (request) => jsonResponse(rpcResult(request.body.id as number, { protocolVersion: '2025-06-18', capabilities: {} }), {
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' },
      }),
      () => new Response(null, { status: 202 }),
      (request) => jsonResponse(rpcResult(request.body.id as number, { tools: TOOLS })),
    ]);

    const tools = await listMcpTools({ connection, fetch });

    expect(tools.map((tool) => tool.name)).toEqual(['send_notice']);
    expect(requests.map((request) => request.body.method)).toEqual([
      'tools/list',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(requests[3]?.headers['mcp-session-id']).toBe('session-1');
    expect(requests[3]?.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('reads a result delivered as an event stream', async () => {
    const { fetch } = recorder([(request) => eventStreamResponse(rpcResult(request.body.id as number, { tools: TOOLS }))]);

    await expect(listMcpTools({ connection, fetch })).resolves.toHaveLength(1);
  });

  it('returns a tool failure rather than a synthesised success', async () => {
    const { fetch, requests } = recorder([(request) => jsonResponse(rpcResult(request.body.id as number, {
      isError: true,
      content: [{ type: 'text', text: 'destination unreachable' }],
    }))]);

    const result = await callMcpTool({ connection, fetch, name: 'send_notice', arguments: { destination: 'room-1' } });

    expect(result).toEqual({ isError: true, text: 'destination unreachable' });
    expect(requests[0]?.headers['mcp-name']).toBe('send_notice');
    expect(requests[0]?.body.params).toMatchObject({ name: 'send_notice', arguments: { destination: 'room-1' } });
  });

  it('reports a transport failure instead of reporting the call as done', async () => {
    const { fetch } = recorder([() => jsonResponse({ error: 'gateway down' }, { status: 502 })]);

    await expect(callMcpTool({ connection, fetch, name: 'send_notice', arguments: {} }))
      .rejects.toThrow(/502/u);
  });

  it('surfaces a protocol-level error as a failure', async () => {
    const { fetch } = recorder([(request) => jsonResponse({
      jsonrpc: '2.0',
      id: request.body.id,
      error: { code: -32602, message: 'unknown tool' },
    })]);

    await expect(callMcpTool({ connection, fetch, name: 'missing', arguments: {} }))
      .rejects.toThrow(/unknown tool/u);
  });

  it('omits authorization when a server needs none', async () => {
    const { fetch, requests } = recorder([(request) => jsonResponse(rpcResult(request.body.id as number, { tools: [] }))]);

    await listMcpTools({ connection: { url: connection.url }, fetch });

    expect(requests[0]?.headers.authorization).toBeUndefined();
  });
});

/**
 * FlareChat as an MCP Server (ADR 0152).
 *
 * The third entrance to the engine, beside Operator Chat and the Trigger. An
 * outside agent presents an Access Token carrying one Tool Grant and one bound
 * Contact List, so no authorization concept is invented for it. Resolving a
 * Contact and reaching one are offered together because neither is usable alone.
 */

import { suppressionKey, type SuppressionWindow } from './suppression';

export interface McpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isWrite: boolean;
}

const contactArgument = {
  contactId: { type: 'string', description: 'A Contact id from contacts.search.' },
  channel: { type: 'string', enum: ['line', 'email'], description: 'Which Channel to reach the Contact on.' },
  text: { type: 'string', description: 'What to say.' },
};

export const MCP_SERVER_TOOLS: readonly McpServerTool[] = [
  {
    name: 'contacts.search',
    description: 'Find Contacts this Access Token may reach, with the Channels each is reachable on.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    isWrite: false,
  },
  {
    name: 'channel.send',
    description: 'Send one message to one Contact now. A repeat of the same message is suppressed.',
    inputSchema: { type: 'object', properties: contactArgument, required: ['contactId', 'channel', 'text'], additionalProperties: false },
    isWrite: true,
  },
  {
    name: 'reminder.schedule',
    description: 'Deliver one message to one Contact at a stated time. Use this rather than waiting.',
    inputSchema: {
      type: 'object',
      properties: { ...contactArgument, at: { type: 'string', description: 'RFC3339 instant to deliver at.' } },
      required: ['contactId', 'channel', 'text', 'at'],
      additionalProperties: false,
    },
    isWrite: true,
  },
];

export const SERVER_PROTOCOL_VERSION = '2026-07-28';

export interface McpServerPorts {
  searchContacts(input: { query: string; contactIds: readonly string[] }): Promise<unknown>;
  sendToContact(input: { contactId: string; channel: string; text: string }): Promise<unknown>;
  scheduleReminder(input: { contactId: string; channel: string; text: string; at: string }): Promise<unknown>;
}

export interface McpServerPrompt {
  name: string;
  description: string;
  instructions: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Denies by default: only names that are both granted and real become tools. */
export const grantedServerTools = (grant: readonly string[]): McpServerTool[] =>
  MCP_SERVER_TOOLS.filter((tool) => grant.includes(tool.name));

const toolResult = (value: unknown, isError = false): unknown => ({
  isError,
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

const stringArgument = (arguments_: Record<string, unknown>, name: string): string => {
  const value = arguments_[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value;
};

const runTool = async (input: {
  tool: McpServerTool;
  arguments: Record<string, unknown>;
  contactIds: readonly string[];
  ports: McpServerPorts;
  suppression: { check(key: string): Promise<boolean>; record(key: string): Promise<void> };
  scope: string;
  window: SuppressionWindow;
  at: Date;
}): Promise<unknown> => {
  if (input.tool.name === 'contacts.search') {
    const query = typeof input.arguments.query === 'string' ? input.arguments.query : '';
    return toolResult(await input.ports.searchContacts({ query, contactIds: input.contactIds }));
  }

  const contactId = stringArgument(input.arguments, 'contactId');
  if (!input.contactIds.includes(contactId)) {
    return toolResult(`Contact ${contactId} is outside the Contact List this Access Token is bound to.`, true);
  }
  const channel = stringArgument(input.arguments, 'channel');
  const text = stringArgument(input.arguments, 'text');

  if (input.tool.name === 'reminder.schedule') {
    const at = stringArgument(input.arguments, 'at');
    const when = Date.parse(at);
    if (Number.isNaN(when)) return toolResult(`${at} is not an instant this server can read.`, true);
    if (when <= input.at.getTime()) return toolResult(`${at} has already passed; a reminder is not a way to send now.`, true);
    return toolResult(await input.ports.scheduleReminder({ contactId, channel, text, at: new Date(when).toISOString() }));
  }

  const key = suppressionKey({ scope: input.scope, tool: input.tool.name, arguments: { contactId, channel, text } });
  if (input.window !== 'none' && await input.suppression.check(key)) {
    return toolResult(`This message was already sent to ${contactId} and its repeat is suppressed for the ${input.window} window.`, false);
  }
  const sent = await input.ports.sendToContact({ contactId, channel, text });
  if (input.window !== 'none') await input.suppression.record(key);
  return toolResult(sent);
};

export const handleMcpServerRequest = async (input: {
  request: JsonRpcRequest;
  grant: readonly string[];
  contactIds: readonly string[];
  prompts: readonly McpServerPrompt[];
  ports: McpServerPorts;
  suppression: { check(key: string): Promise<boolean>; record(key: string): Promise<void> };
  scope: string;
  window: SuppressionWindow;
  at: Date;
}): Promise<JsonRpcResponse> => {
  const id = input.request.id ?? null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
  const tools = grantedServerTools(input.grant);

  switch (input.request.method) {
    case 'initialize':
      return reply({
        protocolVersion: SERVER_PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'flarechat', version: '1' },
      });
    case 'notifications/initialized':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'prompts/list':
      return reply({ prompts: input.prompts.map(({ name, description }) => ({ name, description })) });
    case 'prompts/get': {
      const name = typeof input.request.params?.name === 'string' ? input.request.params.name : '';
      const prompt = input.prompts.find((candidate) => candidate.name === name);
      if (!prompt) return fail(-32602, `No published Prompt is named ${name}.`);
      return reply({
        description: prompt.description,
        messages: [{ role: 'user', content: { type: 'text', text: prompt.instructions } }],
      });
    }
    case 'tools/call': {
      const name = typeof input.request.params?.name === 'string' ? input.request.params.name : '';
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return fail(-32602, `This Access Token may not call ${name}.`);
      const arguments_ = (input.request.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(await runTool({ ...input, tool, arguments: arguments_ }));
      } catch (error) {
        return reply(toolResult(error instanceof Error ? error.message : `${name} failed.`, true));
      }
    }
    default:
      return fail(-32601, `${input.request.method} is not supported by this server.`);
  }
};

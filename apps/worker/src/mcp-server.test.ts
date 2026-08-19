import { describe, expect, it, vi } from 'vitest';

import { grantedServerTools, handleMcpServerRequest, MCP_SERVER_TOOLS, type McpServerPorts } from './mcp-server';

const ports = (): McpServerPorts => ({
  searchContacts: vi.fn(async () => [{ id: 'contact-1', name: '田中', channels: ['line'] }]),
  sendToContact: vi.fn(async () => ({ delivered: true, channel: 'line' })),
  scheduleReminder: vi.fn(async () => ({ scheduled: true, at: '2026-08-19T00:00:00.000Z' })),
});

const suppression = (held: Set<string> = new Set()) => ({
  held,
  check: async (key: string) => held.has(key),
  record: async (key: string) => { held.add(key); },
});

const call = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: '2.0' as const, id: 1, method, ...(params ? { params } : {}) });

const base = (overrides: Partial<Parameters<typeof handleMcpServerRequest>[0]> = {}) => ({
  request: call('tools/list'),
  grant: MCP_SERVER_TOOLS.map((tool) => tool.name),
  contactIds: ['contact-1'],
  prompts: [],
  ports: ports(),
  suppression: suppression(),
  scope: 'token-1',
  window: 'day' as const,
  at: new Date('2026-08-18T09:00:00.000Z'),
  ...overrides,
});

describe('FlareChat as an MCP Server', () => {
  it('offers resolving a Contact and reaching one, which are useless apart', () => {
    expect(MCP_SERVER_TOOLS.map((tool) => tool.name)).toEqual(['contacts.search', 'channel.send', 'reminder.schedule']);
    expect(MCP_SERVER_TOOLS.filter((tool) => tool.isWrite).map((tool) => tool.name)).toEqual(['channel.send', 'reminder.schedule']);
  });

  it('lists only the tools the Access Token was granted', async () => {
    const response = await handleMcpServerRequest(base({ grant: ['contacts.search'] }));

    expect((response.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(['contacts.search']);
  });

  it('refuses a tool outside the grant rather than performing it', async () => {
    const input = base({ grant: ['contacts.search'], request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: 'hi' } }) });

    const response = await handleMcpServerRequest(input);

    expect(response.error?.message).toContain('channel.send');
    expect(input.ports.sendToContact).not.toHaveBeenCalled();
  });

  it('refuses to reach a Contact outside the bound Contact List', async () => {
    const input = base({
      contactIds: ['contact-1'],
      request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-9', channel: 'line', text: 'hi' } }),
    });

    const response = await handleMcpServerRequest(input);

    expect((response.result as { isError: boolean; content: Array<{ text: string }> }).isError).toBe(true);
    expect((response.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('contact-9');
    expect(input.ports.sendToContact).not.toHaveBeenCalled();
  });

  it('reads a Contact only through the bound list', async () => {
    const input = base({ request: call('tools/call', { name: 'contacts.search', arguments: { query: '田中' } }) });

    await handleMcpServerRequest(input);

    expect(input.ports.searchContacts).toHaveBeenCalledWith({ query: '田中', contactIds: ['contact-1'] });
  });

  it('sends once and holds the repeat for the declared window', async () => {
    const shared = suppression();
    const first = base({ suppression: shared, request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: 'hi' } }) });
    await handleMcpServerRequest(first);

    const second = base({ suppression: shared, request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: 'hi' } }) });
    const response = await handleMcpServerRequest(second);

    expect(first.ports.sendToContact).toHaveBeenCalledTimes(1);
    expect(second.ports.sendToContact).not.toHaveBeenCalled();
    const text = (response.result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
    expect(text).toContain('suppressed');
    expect(text).not.toContain('"delivered":true');
  });

  it('does not suppress a different message to the same Contact', async () => {
    const shared = suppression();
    await handleMcpServerRequest(base({ suppression: shared, request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: 'first' } }) }));
    const second = base({ suppression: shared, request: call('tools/call', { name: 'channel.send', arguments: { contactId: 'contact-1', channel: 'line', text: 'second' } }) });

    await handleMcpServerRequest(second);

    expect(second.ports.sendToContact).toHaveBeenCalledTimes(1);
  });

  it('never suppresses a read', async () => {
    const shared = suppression();
    const request = call('tools/call', { name: 'contacts.search', arguments: { query: 'x' } });
    await handleMcpServerRequest(base({ suppression: shared, request }));
    const second = base({ suppression: shared, request });

    await handleMcpServerRequest(second);

    expect(second.ports.searchContacts).toHaveBeenCalledTimes(1);
  });

  it('schedules a reminder rather than sending it now', async () => {
    const input = base({
      request: call('tools/call', { name: 'reminder.schedule', arguments: { contactId: 'contact-1', channel: 'line', text: 'hi', at: '2026-08-19T00:00:00.000Z' } }),
    });

    await handleMcpServerRequest(input);

    expect(input.ports.scheduleReminder).toHaveBeenCalledWith(expect.objectContaining({ at: '2026-08-19T00:00:00.000Z' }));
    expect(input.ports.sendToContact).not.toHaveBeenCalled();
  });

  it('refuses a reminder in the past instead of firing it immediately', async () => {
    const input = base({
      request: call('tools/call', { name: 'reminder.schedule', arguments: { contactId: 'contact-1', channel: 'line', text: 'hi', at: '2026-08-17T00:00:00.000Z' } }),
    });

    const response = await handleMcpServerRequest(input);

    expect((response.result as { isError: boolean }).isError).toBe(true);
    expect(input.ports.scheduleReminder).not.toHaveBeenCalled();
  });

  it('publishes only the Prompts an Account marked public as its skills', async () => {
    const response = await handleMcpServerRequest(base({
      request: call('prompts/list'),
      prompts: [{ name: 'weekly-notice', description: '定例連絡', instructions: 'Send the weekly notice.' }],
    }));

    expect((response.result as { prompts: Array<{ name: string }> }).prompts.map((prompt) => prompt.name)).toEqual(['weekly-notice']);
  });

  it('returns a published Prompt in full when it is asked for', async () => {
    const response = await handleMcpServerRequest(base({
      request: call('prompts/get', { name: 'weekly-notice' }),
      prompts: [{ name: 'weekly-notice', description: '定例連絡', instructions: 'Send the weekly notice.' }],
    }));

    expect(JSON.stringify(response.result)).toContain('Send the weekly notice.');
  });

  it('answers an unknown method as a protocol error', async () => {
    const response = await handleMcpServerRequest(base({ request: call('resources/list') }));

    expect(response.error?.code).toBe(-32601);
  });

  it('answers initialize so an older client can still complete its handshake', async () => {
    const response = await handleMcpServerRequest(base({ request: call('initialize') }));

    expect((response.result as { protocolVersion: string }).protocolVersion).toBeTruthy();
  });
});

describe('granted server tools', () => {
  it('denies by default when a Token names nothing', () => {
    expect(grantedServerTools([])).toEqual([]);
  });

  it('ignores a name that is not one of this server’s tools', () => {
    expect(grantedServerTools(['contacts.search', 'contacts.delete']).map((tool) => tool.name)).toEqual(['contacts.search']);
  });
});

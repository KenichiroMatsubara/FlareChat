import { describe, expect, it, vi } from 'vitest';

import {
  discordHandleFromInteraction,
  discordReply,
  sendDiscordMessage,
  verifyDiscordSignature,
  type DiscordInteraction,
} from './discord';

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const signingKeys = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: hex(raw),
    sign: async (message: string): Promise<string> =>
      hex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(message)))),
  };
};

describe('Discord request signatures', () => {
  it('accepts a request this application actually signed', async () => {
    const keys = await signingKeys();
    const timestamp = '1755500000';
    const body = '{"type":1}';

    await expect(verifyDiscordSignature({
      publicKey: keys.publicKey,
      signature: await keys.sign(timestamp + body),
      timestamp,
      body,
    })).resolves.toBe(true);
  });

  it('refuses a body that was changed after signing', async () => {
    const keys = await signingKeys();
    const timestamp = '1755500000';
    const signature = await keys.sign(`${timestamp}{"type":1}`);

    await expect(verifyDiscordSignature({ publicKey: keys.publicKey, signature, timestamp, body: '{"type":2}' }))
      .resolves.toBe(false);
  });

  it('refuses a signature signed for a different moment', async () => {
    const keys = await signingKeys();
    const body = '{"type":1}';

    await expect(verifyDiscordSignature({
      publicKey: keys.publicKey,
      signature: await keys.sign(`1755500000${body}`),
      timestamp: '1755599999',
      body,
    })).resolves.toBe(false);
  });

  it('refuses rather than throwing when the signature is not readable at all', async () => {
    const keys = await signingKeys();

    await expect(verifyDiscordSignature({ publicKey: keys.publicKey, signature: 'not-hex', timestamp: '1', body: '{}' }))
      .resolves.toBe(false);
    await expect(verifyDiscordSignature({ publicKey: 'not-hex', signature: 'aabb', timestamp: '1', body: '{}' }))
      .resolves.toBe(false);
  });
});

describe('Discord interactions', () => {
  const interaction = (overrides: Record<string, unknown>): DiscordInteraction => ({
    type: 2,
    channel_id: 'channel-1',
    guild_id: 'guild-1',
    member: { user: { id: 'user-1', username: 'tanaka', global_name: '田中' } },
    ...overrides,
  } as DiscordInteraction);

  it('answers the ping Discord uses to check the endpoint', () => {
    expect(discordReply(interaction({ type: 1 }))).toEqual({ type: 1 });
  });

  it('acknowledges a command with a visible message', () => {
    expect(discordReply(interaction({ type: 2 }), '受け付けました')).toEqual({
      type: 4,
      data: { content: '受け付けました' },
    });
  });

  it('discovers the person who used it, and the channel they used it in', () => {
    expect(discordHandleFromInteraction(interaction({}))).toEqual({
      externalId: 'user-1',
      kind: 'single',
      displayName: '田中',
      channelId: 'channel-1',
    });
  });

  it('reads a direct message, where there is no guild member wrapper', () => {
    expect(discordHandleFromInteraction(interaction({
      member: undefined,
      guild_id: undefined,
      user: { id: 'user-2', username: 'sato', global_name: null },
    }))).toEqual({
      externalId: 'user-2',
      kind: 'single',
      displayName: 'sato',
      channelId: 'channel-1',
    });
  });

  it('reports nothing rather than inventing a handle when no user is named', () => {
    expect(discordHandleFromInteraction(interaction({ member: undefined }))).toBeNull();
  });
});

describe('sending to Discord', () => {
  it('posts to the channel with the bot credential', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const stub = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'message-1' }), { headers: { 'Content-Type': 'application/json' } });
    });

    const outcome = await sendDiscordMessage({ fetch: stub, botToken: 'bot-token', channelId: 'channel-1', text: 'hi' });

    expect(outcome).toEqual({ delivered: true, externalId: 'message-1' });
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/channels/channel-1/messages');
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bot bot-token');
  });

  it('reports a refusal as a failure rather than as a delivery', async () => {
    const stub = vi.fn(async () => new Response('missing access', { status: 403 }));

    await expect(sendDiscordMessage({ fetch: stub, botToken: 'bot-token', channelId: 'channel-1', text: 'hi' }))
      .rejects.toThrow(/403/u);
  });
});

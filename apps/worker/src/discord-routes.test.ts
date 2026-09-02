import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './app';
import type { TestApp } from '../test/app';
import { createAutomationTestApp } from '../test/automation';

let fixture: TestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

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

const connectDiscord = async (app_: TestApp, publicKey: string): Promise<Response> =>
  app.fetch(app_.jsonRequest(
    '/api/organizations/organization-1/connections/discord',
    { botToken: 'bot-token', applicationPublicKey: publicKey },
    'PUT',
  ), app_.environment);

const interaction = (app_: TestApp, input: { body: string; signature: string; timestamp: string }): Request =>
  new Request('https://flarechat.example/api/public/organizations/organization-1/discord/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': input.signature,
      'X-Signature-Timestamp': input.timestamp,
    },
    body: input.body,
  });

describe('Discord Connection', () => {
  it('stores the credential and hands back the endpoint Discord must be pointed at', async () => {
    fixture = await createAutomationTestApp();
    const keys = await signingKeys();

    const response = await connectDiscord(fixture, keys.publicKey);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('bot-token');
    expect(JSON.parse(body)).toMatchObject({
      data: { interactionsUrl: expect.stringContaining('/discord/interactions') as unknown as string },
    });
  });

  it('refuses a public key that is not one', async () => {
    fixture = await createAutomationTestApp();

    await expect(connectDiscord(fixture, 'not-a-key').then((response) => response.status)).resolves.toBe(400);
  });
});

describe('Discord interactions endpoint', () => {
  it('refuses a request Discord did not sign', async () => {
    fixture = await createAutomationTestApp();
    const keys = await signingKeys();
    await connectDiscord(fixture, keys.publicKey);
    const body = JSON.stringify({ type: 1 });

    const response = await app.fetch(
      interaction(fixture, { body, signature: 'aa'.repeat(64), timestamp: '1755500000' }),
      fixture.environment,
    );

    expect(response.status).toBe(401);
  });

  it('answers the ping Discord uses to verify the endpoint', async () => {
    fixture = await createAutomationTestApp();
    const keys = await signingKeys();
    await connectDiscord(fixture, keys.publicKey);
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1755500000';

    const response = await app.fetch(
      interaction(fixture, { body, signature: await keys.sign(timestamp + body), timestamp }),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it('discovers the Channel Handle of whoever used it, unlinked to any Contact', async () => {
    fixture = await createAutomationTestApp();
    const keys = await signingKeys();
    await connectDiscord(fixture, keys.publicKey);
    const body = JSON.stringify({
      type: 2,
      channel_id: 'channel-1',
      member: { user: { id: 'user-1', username: 'tanaka', global_name: '田中' } },
    });
    const timestamp = '1755500001';

    const response = await app.fetch(
      interaction(fixture, { body, signature: await keys.sign(timestamp + body), timestamp }),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    expect(fixture.account.rows<{ external_id: string; reply_target: string; display_name: string; contact_id: string | null }>(
      'SELECT external_id, reply_target, display_name, contact_id FROM channel_handles',
    )).toEqual([{ external_id: 'user-1', reply_target: 'channel-1', display_name: '田中', contact_id: null }]);
  });

  it('keeps one handle for a person who uses it twice, following them to a new channel', async () => {
    fixture = await createAutomationTestApp();
    const keys = await signingKeys();
    await connectDiscord(fixture, keys.publicKey);
    const send = async (channelId: string, timestamp: string): Promise<void> => {
      const body = JSON.stringify({ type: 2, channel_id: channelId, member: { user: { id: 'user-1', username: 'tanaka' } } });
      await app.fetch(
        interaction(fixture as TestApp, { body, signature: await keys.sign(timestamp + body), timestamp }),
        (fixture as TestApp).environment,
      );
    };

    await send('channel-1', '1755500002');
    await send('channel-2', '1755500003');

    expect(fixture.account.rows<{ reply_target: string }>('SELECT reply_target FROM channel_handles'))
      .toEqual([{ reply_target: 'channel-2' }]);
  });
});

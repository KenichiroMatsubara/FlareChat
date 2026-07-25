import { describe, expect, it } from 'vitest';

import { batchLineMessages, verifyLineWebhookSignature } from './line';

describe('batchLineMessages', () => {
  it('同じ宛先の通知を最大5件まで1回の送信にまとめる', () => {
    const messages = Array.from({ length: 7 }, (_, index) => ({
      destinationId: 'group-1',
      messageId: String(index),
      body: `通知 ${index}`,
    }));

    const batches = batchLineMessages(messages);

    expect(batches).toHaveLength(2);
    expect(batches[0]?.messages).toHaveLength(5);
    expect(batches[1]?.messages).toHaveLength(2);
  });

  it('異なる宛先の通知を混ぜない', () => {
    const batches = batchLineMessages([
      { destinationId: 'group-1', messageId: '1', body: 'A' },
      { destinationId: 'person-1', messageId: '2', body: 'B' },
      { destinationId: 'group-1', messageId: '3', body: 'C' },
    ]);

    expect(batches).toEqual([
      {
        destinationId: 'group-1',
        messages: [
          { destinationId: 'group-1', messageId: '1', body: 'A' },
          { destinationId: 'group-1', messageId: '3', body: 'C' },
        ],
      },
      {
        destinationId: 'person-1',
        messages: [{ destinationId: 'person-1', messageId: '2', body: 'B' }],
      },
    ]);
  });
});

describe('LINE webhook signatures', () => {
  it('accepts an HMAC-SHA256 signature only for the original webhook body', async () => {
    const secret = 'line-channel-secret';
    const body = '{"events":[]}';
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));

    await expect(verifyLineWebhookSignature(secret, body, signature)).resolves.toBe(true);
    await expect(verifyLineWebhookSignature(secret, `${body} `, signature)).resolves.toBe(false);
  });
});

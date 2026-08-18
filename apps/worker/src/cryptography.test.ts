import { describe, expect, it } from 'vitest';

import { createAccountKey, decrypt, encrypt, masterKey, unwrapAccountKey } from './cryptography';
import { randomToken } from './encoding';

describe('credential envelopes', () => {
  it('encrypts credentials and binds them to their Account context', async () => {
    const key = await masterKey(randomToken(32));
    const envelope = await encrypt('refresh-token', key, 'setup-credential:setup-a');

    await expect(decrypt(envelope, key, 'setup-credential:setup-a')).resolves.toBe('refresh-token');
    await expect(decrypt(envelope, key, 'setup-credential:setup-b')).rejects.toThrow();
  });

  it('wraps each Account key with the deployment master key', async () => {
    const key = await masterKey(randomToken(32));
    const wrapped = await createAccountKey(key, '2026-07', 'organization-a');
    const accountKey = await unwrapAccountKey(wrapped, key, 'organization-a');
    const envelope = await encrypt('google-refresh-token', accountKey, 'google-connection:organization-a:automation-inbox');

    await expect(decrypt(envelope, accountKey, 'google-connection:organization-a:automation-inbox')).resolves.toBe('google-refresh-token');
  });
});

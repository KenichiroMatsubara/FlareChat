import { describe, expect, it } from 'vitest';

import { createOrganizationKey, decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import { randomToken } from './encoding';

describe('credential envelopes', () => {
  it('encrypts credentials and binds them to their Organization context', async () => {
    const key = await masterKey(randomToken(32));
    const envelope = await encrypt('refresh-token', key, 'setup-credential:setup-a');

    await expect(decrypt(envelope, key, 'setup-credential:setup-a')).resolves.toBe('refresh-token');
    await expect(decrypt(envelope, key, 'setup-credential:setup-b')).rejects.toThrow();
  });

  it('wraps each Organization key with the deployment master key', async () => {
    const key = await masterKey(randomToken(32));
    const wrapped = await createOrganizationKey(key, '2026-07', 'organization-a');
    const organizationKey = await unwrapOrganizationKey(wrapped, key, 'organization-a');
    const envelope = await encrypt('google-refresh-token', organizationKey, 'google-connection:organization-a:automation-inbox');

    await expect(decrypt(envelope, organizationKey, 'google-connection:organization-a:automation-inbox')).resolves.toBe('google-refresh-token');
  });
});

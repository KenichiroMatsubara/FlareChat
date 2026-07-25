import type { ApiResult, OrganizationSetup, PasskeyCreationOptions } from '@mail/domain';

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = (await response.json()) as ApiResult<T> & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? '操作に失敗しました。');
  return body.data;
};

export const api = {
  startSetup: (name: string): Promise<{ authorizationUrl: string }> =>
    request('/api/setup', { method: 'POST', body: JSON.stringify({ name }) }),
  currentSetup: (): Promise<OrganizationSetup | null> => request('/api/setup/current'),
  passkeyOptions: (): Promise<PasskeyCreationOptions> => request('/api/setup/passkey/options', { method: 'POST' }),
  verifyPasskey: (credential: unknown): Promise<OrganizationSetup> =>
    request('/api/setup/passkey/verify', { method: 'POST', body: JSON.stringify(credential) }),
};

import { describe, expect, it, vi } from 'vitest';

import { cloudflareControlPlane, type CloudflareFetch } from './cloudflare';
import type { Bindings } from './types';

const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'account-1',
  CLOUDFLARE_API_TOKEN: 'token-1',
  CLOUDFLARE_WORKER_NAME: 'flarechat',
} as Bindings;

const cloudflareResponse = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, result }), {
    headers: { 'Content-Type': 'application/json' },
  });

describe('Cloudflare control plane', () => {
  it('encodes D1 operations as JSON behind its D1Database adapter', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn<CloudflareFetch>(async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith('/d1/database')) {
        return cloudflareResponse({ uuid: 'database-1' });
      }
      return cloudflareResponse([{
        success: true,
        results: [{ name: 'google_connections' }],
        meta: { rows_read: 1 },
      }]);
    });
    const controlPlane = cloudflareControlPlane(environment, fetcher);

    const databaseId = await controlPlane.createDatabase('mail-organization-1');
    const result = await controlPlane.openDatabase(databaseId)
      .prepare('SELECT name FROM sqlite_master WHERE name = ?')
      .bind('google_connections')
      .all<{ name: string }>();

    expect(result.results).toEqual([{ name: 'google_connections' }]);
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[0]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      name: 'mail-organization-1',
      primary_location_hint: 'apac',
    });
    expect(new Headers(requests[1]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      sql: 'SELECT name FROM sqlite_master WHERE name = ?',
      params: ['google_connections'],
    });
  });

  it('encodes Worker binding updates as multipart and inherits every untouched binding', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn<CloudflareFetch>(async (input, init) => {
      requests.push({ url: String(input), init });
      if (!init?.method) {
        return cloudflareResponse({
          bindings: [
            { name: 'AI', type: 'ai' },
            { name: 'GOOGLE_CLIENT_SECRET', type: 'secret_text' },
            { name: 'ORG_EXISTING', type: 'd1', database_id: 'database-existing' },
          ],
        });
      }
      return cloudflareResponse({ bindings: [] });
    });
    const controlPlane = cloudflareControlPlane(environment, fetcher);

    await controlPlane.attachDatabase('ORG_NEW', 'database-new');

    expect(requests).toHaveLength(2);
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(new Headers(requests[0]?.init?.headers).has('content-type')).toBe(false);
    expect(requests[1]?.init?.method).toBe('PATCH');
    expect(new Headers(requests[1]?.init?.headers).has('content-type')).toBe(false);
    expect(requests[1]?.init?.body).toBeInstanceOf(FormData);
    const settings = JSON.parse(String((requests[1]?.init?.body as FormData).get('settings')));
    expect(settings).toEqual({
      bindings: [
        { name: 'AI', type: 'inherit' },
        { name: 'GOOGLE_CLIENT_SECRET', type: 'inherit' },
        { name: 'ORG_EXISTING', type: 'inherit' },
        { name: 'ORG_NEW', type: 'd1', database_id: 'database-new' },
      ],
    });
  });
});

import { readFile } from 'node:fs/promises';

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
  it('preserves dynamically provisioned Organization D1 bindings during deployment', async () => {
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')) as {
      keep_vars?: boolean;
      secrets?: { required?: string[] };
      triggers?: { crons?: string[] };
      unsafe?: { metadata?: { keep_bindings?: string[] } };
      vars?: Record<string, string>;
    };

    expect(config.vars).toMatchObject({
      APP_URL: 'https://flarechat.pinara.workers.dev',
      WEB_ORIGIN: 'https://flarechat.pinara.workers.dev',
      RP_ID: 'flarechat.pinara.workers.dev',
      CLOUDFLARE_WORKER_NAME: 'flarechat',
    });
    expect(config.keep_vars).toBe(true);
    expect(config.triggers?.crons).toEqual(['*/30 * * * *']);
    expect(config.unsafe?.metadata?.keep_bindings).toEqual(expect.arrayContaining([
      'd1',
      'plain_text',
      'json',
      'secret_text',
      'secret_key',
    ]));
    expect(config.secrets?.required).toEqual(expect.arrayContaining([
      'CLOUDFLARE_API_TOKEN',
      'CREDENTIAL_MASTER_KEY',
      'CREDENTIAL_MASTER_KEY_VERSION',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ]));
  });

  it('encodes D1 operations as JSON behind its D1Database adapter', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn<CloudflareFetch>(async (input, init) => {
      requests.push({ url: String(input), init });
      if (!init?.method) {
        return cloudflareResponse([]);
      }
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

    const databaseId = await controlPlane.ensureDatabase(
      'flarechat-organization-owner-at-example-com-123456789abc',
    );
    const result = await controlPlane.openDatabase(databaseId)
      .prepare('SELECT name FROM sqlite_master WHERE name = ?')
      .bind('google_connections')
      .all<{ name: string }>();

    expect(result.results).toEqual([{ name: 'google_connections' }]);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.url).toContain('/d1/database?name=flarechat-organization-');
    expect(new Headers(requests[1]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      name: 'flarechat-organization-owner-at-example-com-123456789abc',
      primary_location_hint: 'apac',
    });
    expect(new Headers(requests[2]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      sql: 'SELECT name FROM sqlite_master WHERE name = ?',
      params: ['google_connections'],
    });
  });

  it('reuses the D1 database with the exact deterministic name', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn<CloudflareFetch>(async (input, init) => {
      requests.push({ url: String(input), init });
      return cloudflareResponse([{
        name: 'flarechat-organization-owner-at-example-com-123456789abc',
        uuid: 'database-existing',
      }]);
    });
    const controlPlane = cloudflareControlPlane(environment, fetcher);

    await expect(controlPlane.ensureDatabase(
      'flarechat-organization-owner-at-example-com-123456789abc',
    )).resolves.toBe('database-existing');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBeUndefined();
    expect(requests[0]?.url).toContain(
      '/d1/database?name=flarechat-organization-owner-at-example-com-123456789abc',
    );
  });

  it('recovers the deterministic database created by a concurrent retry', async () => {
    const requests: string[] = [];
    const fetcher = vi.fn<CloudflareFetch>(async (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
      if (requests.length === 1) return cloudflareResponse([]);
      if (requests.length === 2) {
        return new Response(JSON.stringify({
          success: false,
          errors: [{ message: 'A database with that name already exists.' }],
        }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      return cloudflareResponse([{
        name: 'flarechat-organization-owner-at-example-com-123456789abc',
        uuid: 'database-created-concurrently',
      }]);
    });
    const controlPlane = cloudflareControlPlane(environment, fetcher);

    await expect(controlPlane.ensureDatabase(
      'flarechat-organization-owner-at-example-com-123456789abc',
    )).resolves.toBe('database-created-concurrently');

    expect(requests.map((request) => request.split(' ')[0])).toEqual(['GET', 'POST', 'GET']);
  });

  it('refuses to choose arbitrarily when a deterministic name is duplicated', async () => {
    const fetcher = vi.fn<CloudflareFetch>(async () => cloudflareResponse([
      {
        name: 'flarechat-organization-owner-at-example-com-123456789abc',
        uuid: 'database-1',
      },
      {
        name: 'flarechat-organization-owner-at-example-com-123456789abc',
        uuid: 'database-2',
      },
    ]));
    const controlPlane = cloudflareControlPlane(environment, fetcher);

    await expect(controlPlane.ensureDatabase(
      'flarechat-organization-owner-at-example-com-123456789abc',
    )).rejects.toThrow('Multiple Cloudflare D1 databases have the deterministic name');
  });

  it('encodes Worker binding updates as multipart and inherits every untouched binding', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = vi.fn<CloudflareFetch>(async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith('/settings') && !init?.method) {
        return cloudflareResponse({
          bindings: [
            { name: 'AI', type: 'ai' },
            { name: 'GOOGLE_CLIENT_SECRET', type: 'secret_text' },
            { name: 'ORG_EXISTING', type: 'd1', database_id: 'database-existing' },
          ],
        });
      }
      if (String(input).endsWith('/deployments')) {
        return cloudflareResponse({
          deployments: [{ versions: [{ version_id: 'version-new', percentage: 100 }] }],
        });
      }
      if (String(input).endsWith('/versions/version-new')) {
        return cloudflareResponse({
          resources: {
            bindings: [{ name: 'ORG_NEW', type: 'd1', database_id: 'database-new' }],
          },
        });
      }
      return cloudflareResponse({ bindings: [] });
    });
    const controlPlane = cloudflareControlPlane(environment, fetcher);

    await controlPlane.attachDatabase('ORG_NEW', 'database-new');

    expect(requests).toHaveLength(4);
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

  it('waits until a newly attached D1 binding is present in the deployed Worker version', async () => {
    let deploymentReads = 0;
    const fetcher = vi.fn<CloudflareFetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/settings') && !init?.method) {
        return cloudflareResponse({ bindings: [{ name: 'AI', type: 'ai' }] });
      }
      if (url.endsWith('/settings') && init?.method === 'PATCH') {
        return cloudflareResponse({ bindings: [] });
      }
      if (url.endsWith('/deployments')) {
        deploymentReads += 1;
        return cloudflareResponse({
          deployments: [{
            versions: [{
              version_id: deploymentReads === 1 ? 'version-before-binding' : 'version-with-binding',
              percentage: 100,
            }],
          }],
        });
      }
      if (url.endsWith('/versions/version-before-binding')) {
        return cloudflareResponse({
          resources: { bindings: [{ name: 'CONTROL_DB', type: 'd1', database_id: 'control-db' }] },
        });
      }
      if (url.endsWith('/versions/version-with-binding')) {
        return cloudflareResponse({
          resources: { bindings: [{ name: 'ORG_NEW', type: 'd1', database_id: 'database-new' }] },
        });
      }
      throw new Error(`Unexpected Cloudflare request: ${url}`);
    });
    const controlPlane = cloudflareControlPlane(environment, fetcher);

    await controlPlane.attachDatabase('ORG_NEW', 'database-new');

    expect(deploymentReads).toBe(2);
  });
});

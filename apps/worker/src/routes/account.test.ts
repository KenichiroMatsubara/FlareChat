import { afterEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../../test/app';
import { accountRoute } from './account';
import { resource } from '../response';

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const routes = resource();
routes.get('/organizations/:accountId/echo', accountRoute(async ({ accountId, session }) => ({ accountId, identity: session.identity_id })));
routes.post('/organizations/:accountId/echo', accountRoute<{ value?: string }>(async ({ body }) => ({ value: body.value ?? null })));

const refusal = async (response: Response): Promise<{ status: number; code: string | undefined }> => ({
  status: response.status,
  code: ((await response.json()) as { error?: { code?: string } }).error?.code,
});

describe('a route declared against an Account (ADR 0169)', () => {
  it('hands the handler the resolved Account and session once the seam has admitted the request', async () => {
    fixture = createTestApp();

    const response = await routes.fetch(fixture.request('/organizations/organization-1/echo'), fixture.environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { accountId: 'organization-1', identity: 'identity-1' } });
  });

  it('refuses with a code, not a sentence, when there is no session', async () => {
    fixture = createTestApp();

    const response = await routes.fetch(new Request('https://app.example.com/organizations/organization-1/echo'), fixture.environment);

    await expect(refusal(response)).resolves.toEqual({ status: 401, code: 'unauthenticated' });
  });

  it('refuses an Account the session is no member of', async () => {
    fixture = createTestApp();

    const response = await routes.fetch(fixture.request('/organizations/organization-9/echo'), fixture.environment);

    await expect(refusal(response)).resolves.toEqual({ status: 403, code: 'no_access' });
  });

  it('refuses a suspended Account before any handler runs', async () => {
    fixture = createTestApp();
    fixture.control.execute("UPDATE organizations SET status = 'suspended' WHERE id = 'organization-1'");

    const response = await routes.fetch(fixture.request('/organizations/organization-1/echo'), fixture.environment);

    await expect(refusal(response)).resolves.toEqual({ status: 403, code: 'account_unavailable' });
  });

  it('refuses a missing Account database as unavailable, never as a permission problem', async () => {
    fixture = createTestApp();
    delete (fixture.environment as unknown as Record<string, unknown>).ORG_ORGANIZATION1;

    const response = await routes.fetch(fixture.request('/organizations/organization-1/echo'), fixture.environment);

    await expect(refusal(response)).resolves.toEqual({ status: 503, code: 'database_unavailable' });
  });

  it('refuses a body that is not JSON as invalid', async () => {
    fixture = createTestApp();

    const response = await routes.fetch(fixture.request('/organizations/organization-1/echo', { method: 'POST', body: '{not json' }), fixture.environment);

    await expect(refusal(response)).resolves.toEqual({ status: 400, code: 'invalid' });
  });
});

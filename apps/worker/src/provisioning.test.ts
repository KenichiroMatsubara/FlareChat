import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import { provisionOrganization } from './provisioning';
import { createProvisioningTestApp, type ProvisioningTestApp } from '../test/provisioning';

let fixture: ProvisioningTestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

describe('Organization provisioning', () => {
  it('activates an isolated Organization with its granted account as the Automation Inbox', async () => {
    fixture = await createProvisioningTestApp();
    const cloudflare = vi.fn();
    vi.stubGlobal('fetch', cloudflare);

    await provisionOrganization(fixture.environment, fixture.provisioning);

    const automation = await app.fetch(new Request(
      'https://app.example.com/api/organizations/organization-1/automation',
      { headers: { Cookie: 'mail_session=session-1' } },
    ), fixture.environment);
    const membership = await app.fetch(new Request(
      'https://app.example.com/api/auth/me',
      { headers: { Cookie: 'mail_session=session-1' } },
    ), fixture.environment);
    const bootstrap = await app.fetch(new Request(
      'https://app.example.com/api/bootstrap',
      { headers: { Cookie: 'mail_session=session-1' } },
    ), fixture.environment);

    await expect(automation.json()).resolves.toMatchObject({
      data: { email: 'owner@example.com', enabled: true },
    });
    await expect(membership.json()).resolves.toMatchObject({
      data: {
        organizations: [{
          organizationId: 'organization-1',
          status: 'active',
          role: 'owner',
        }],
      },
    });
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: { kind: 'ready' },
    });
    expect(cloudflare).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import { provisionOrganization } from './provisioning';
import { fleetMigration } from './fleet-migration';
import { retryProvisioning } from './onboarding';
import { applyTestMigrations } from '../test/d1';
import { createProvisioningTestApp, type ProvisioningTestApp } from '../test/provisioning';

let fixture: ProvisioningTestApp | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  fixture?.close();
  fixture = undefined;
});

describe('Organization provisioning', () => {
  it('does not activate a new Organization while a schema release is being prepared', async () => {
    fixture = await createProvisioningTestApp();
    await fleetMigration.prepareRelease(fixture.environment);

    await expect(provisionOrganization(
      fixture.environment,
      fixture.provisioning,
    )).rejects.toThrow(/schema release/u);

    expect(fixture.control.row<{ status: string }>(
      'SELECT status FROM organizations WHERE id = ?',
      fixture.provisioning.organizationId,
    )).toEqual({ status: 'provisioning' });
  });

  it('keeps provisioning pending instead of failing while a schema release is in progress', async () => {
    fixture = await createProvisioningTestApp();
    await fleetMigration.prepareRelease(fixture.environment);

    await retryProvisioning(fixture.environment);

    expect(fixture.control.row<{ state: string }>(
      'SELECT state FROM organization_provisionings WHERE organization_id = ?',
      fixture.provisioning.organizationId,
    )).toEqual({ state: 'provisioning' });
  });

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

  it('refreshes the same Automation Inbox credential without erasing a rediscovered database', async () => {
    fixture = await createProvisioningTestApp();
    applyTestMigrations(fixture.organization, 'organization');
    fixture.organization.execute(
      `INSERT INTO google_connections
        (id, kind, google_subject, inbox_address, granted_scopes, token_envelope,
         gmail_history_id, enabled, status, created_at, updated_at)
       VALUES (?, 'automation_inbox', ?, ?, ?, ?, ?, 1, 'reauthentication_required', ?, ?)`,
      'connection-existing',
      'google-subject-1',
      'owner@example.com',
      '[]',
      '{"stale":true}',
      'history-stale',
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z',
    );
    fixture.organization.execute(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
      'preserved',
      'yes',
      '2026-07-25T00:00:00.000Z',
    );

    await provisionOrganization(fixture.environment, fixture.provisioning);

    expect(fixture.organization.row<{
      id: string;
      gmail_history_id: string;
      status: string;
      token_envelope: string;
    }>('SELECT id, gmail_history_id, status, token_envelope FROM google_connections')).toMatchObject({
      id: 'connection-existing',
      gmail_history_id: 'history-1',
      status: 'active',
    });
    expect(fixture.organization.row<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      'preserved',
    )).toEqual({ value: 'yes' });
    expect(fixture.organization.row<{ token_envelope: string }>(
      'SELECT token_envelope FROM google_connections',
    )?.token_envelope).not.toBe('{"stale":true}');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './api';
import { provisionAccount } from './provisioning';
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

describe('Account provisioning', () => {
  it('does not activate a new Account while a schema release is being prepared', async () => {
    fixture = await createProvisioningTestApp();
    await fleetMigration.prepareRelease(fixture.environment);

    await expect(provisionAccount(
      fixture.environment,
      fixture.provisioning,
    )).rejects.toThrow(/schema release/u);

    expect(fixture.control.row<{ status: string }>(
      'SELECT status FROM organizations WHERE id = ?',
      fixture.provisioning.accountId,
    )).toEqual({ status: 'provisioning' });
  });

  it('keeps provisioning pending instead of failing while a schema release is in progress', async () => {
    fixture = await createProvisioningTestApp();
    await fleetMigration.prepareRelease(fixture.environment);

    await retryProvisioning(fixture.environment);

    expect(fixture.control.row<{ state: string }>(
      'SELECT state FROM organization_provisionings WHERE organization_id = ?',
      fixture.provisioning.accountId,
    )).toEqual({ state: 'provisioning' });
  });

  it('activates an isolated Account with its granted account as the Automation Inbox', async () => {
    fixture = await createProvisioningTestApp();
    const cloudflare = vi.fn();
    vi.stubGlobal('fetch', cloudflare);

    await provisionAccount(fixture.environment, fixture.provisioning);

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
      data: { email: 'owner@example.com', enabled: false },
    });
    await expect(membership.json()).resolves.toMatchObject({
      data: {
        accounts: [{
          accountId: 'organization-1',
          status: 'active',
        }],
      },
    });
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: { kind: 'ready' },
    });
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it('copies the selected Preset while creating an Account', async () => {
    fixture = await createProvisioningTestApp();
    const selected = { ...fixture.provisioning, presetId: 'membership-organization' };

    await provisionAccount(fixture.environment, selected);

    expect(fixture.account.rows<{ name: string }>('SELECT name FROM lists ORDER BY name')).toEqual([
      { name: 'Calendar members' },
      { name: 'LINE members' },
      { name: 'Trusted announcement sources' },
    ]);
    expect(fixture.account.row<{ name: string }>('SELECT name FROM rules')).toEqual({
      name: 'Membership announcements',
    });
    expect(fixture.account.row<{ name: string }>('SELECT name FROM agent_rules')).toEqual({
      name: 'Membership follow-up',
    });
  });

  it('refreshes the same Automation Inbox credential without erasing a rediscovered database', async () => {
    fixture = await createProvisioningTestApp();
    applyTestMigrations(fixture.account, 'organization');
    fixture.account.execute(
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
    fixture.account.execute(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
      'preserved',
      'yes',
      '2026-07-25T00:00:00.000Z',
    );

    await provisionAccount(fixture.environment, fixture.provisioning);

    expect(fixture.account.row<{
      id: string;
      gmail_history_id: string;
      status: string;
      token_envelope: string;
    }>('SELECT id, gmail_history_id, status, token_envelope FROM google_connections')).toMatchObject({
      id: 'connection-existing',
      gmail_history_id: 'history-1',
      status: 'active',
    });
    expect(fixture.account.row<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      'preserved',
    )).toEqual({ value: 'yes' });
    expect(fixture.account.row<{ token_envelope: string }>(
      'SELECT token_envelope FROM google_connections',
    )?.token_envelope).not.toBe('{"stale":true}');
  });
});

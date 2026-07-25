import { describe, expect, it, vi } from 'vitest';

import { api } from './api';

describe('Organization setup client', () => {
  it('sends the distinct initial Owner address when requesting Passkey options', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { challenge: 'challenge' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.setupPasskeyOptions('owner@example.com');

    expect(fetchMock).toHaveBeenCalledWith('/api/setup/passkey/options', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ownerEmail: 'owner@example.com' }),
    }));
    vi.unstubAllGlobals();
  });

  it('loads the Organization-scoped dashboard rather than the retired global automation summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { activeRules: 1, upcomingEvents: 2, pendingJobs: 3, exceptions: 4, lastSyncedAt: null } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.organizationDashboard('organization-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/organizations/organization-1/dashboard', expect.any(Object));
    vi.unstubAllGlobals();
  });

  it('lists and creates Organization-scoped Rules through the tenant API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'rule-1', name: 'Announcements', state: 'draft' } }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.organizationRules('organization-1');
    await api.createOrganizationRule('organization-1', { name: 'Announcements', state: 'draft' });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/organizations/organization-1/rules', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/organizations/organization-1/rules', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'Announcements', state: 'draft' }),
    }));
    vi.unstubAllGlobals();
  });
});

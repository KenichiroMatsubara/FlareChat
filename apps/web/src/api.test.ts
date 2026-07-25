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
});

import { describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { defaultOrganizationName, setupPhaseLabel, shouldShowOrganizationLoading } from './entry';

describe('Organization setup client', () => {
  it('loads one discriminated application state from the bootstrap interface', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        kind: 'ready',
        identity: { email: 'owner@example.com', displayName: 'Owner' },
        organizations: [{ organizationId: 'organization-1', name: 'Example', status: 'active' }],
      },
    }), { status: 200 })));

    await expect(api.bootstrap()).resolves.toMatchObject({
      kind: 'ready',
      organizations: [{ organizationId: 'organization-1' }],
    });

    vi.unstubAllGlobals();
  });

  it('defaults the Organization name to the authenticated Google account name', () => {
    expect(defaultOrganizationName({ email: 'owner@example.com', displayName: '岡崎RAC', organizations: [] })).toBe('岡崎RAC');
    expect(defaultOrganizationName({ email: 'owner@example.com', displayName: '   ', organizations: [] })).toBe('');
  });

  it('reports an empty upstream response without exposing a JSON parser exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 502 })));

    await expect(api.bootstrap()).rejects.toThrow('サービスに接続できませんでした。時間をおいて画面を再読み込みしてください。');

    vi.unstubAllGlobals();
  });

  it('explains that the URL may be stale when an API request receives an HTML response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Not Found</html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    })));

    await expect(api.bootstrap()).rejects.toThrow(
      'サービスから正しい応答を受け取れませんでした。URLを確認して画面を再読み込みしてください。',
    );

    vi.unstubAllGlobals();
  });

  it('loads the Organization-scoped dashboard rather than the retired global automation summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { activeRules: 1, upcomingEvents: 2, pendingJobs: 3, exceptions: 4, lastSyncedAt: null } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.organizationDashboard('organization-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/organizations/organization-1/dashboard', expect.any(Object));
    vi.unstubAllGlobals();
  });

  it('loads the Automation Inbox through the selected Organization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { email: 'owner@example.com', displayName: 'Owner', enabled: true, lastSyncedAt: null, lastError: null, created: 0, skipped: 0, exceptions: 0 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.currentAutomation('organization-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/organizations/organization-1/automation', { credentials: 'include' });
    vi.unstubAllGlobals();
  });

  it('shows Organization loading instead of a false Google connection prompt before the Inbox read completes', () => {
    const member = {
      email: 'owner@example.com',
      displayName: 'Owner',
      organizations: [{ organizationId: 'organization-1', name: 'Example', status: 'active' }],
    };

    expect(shouldShowOrganizationLoading(member, '', false)).toBe(true);
    expect(shouldShowOrganizationLoading(member, 'organization-1', true)).toBe(true);
    expect(shouldShowOrganizationLoading(member, 'organization-1', false)).toBe(false);
  });

  it('returns Organization-scoped Rules supplied by the Worker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'rule-1', name: 'Announcements', state: 'draft' }],
    }), { status: 200 })));

    await expect(api.organizationRules('organization-1')).resolves.toEqual([
      { id: 'rule-1', name: 'Announcements', state: 'draft' },
    ]);

    vi.unstubAllGlobals();
  });

  it('returns a newly created Organization Rule', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'rule-1', name: 'Announcements', state: 'draft' },
    }), { status: 201 })));

    await expect(api.createOrganizationRule(
      'organization-1',
      { name: 'Announcements', state: 'draft' },
    )).resolves.toMatchObject({ id: 'rule-1', name: 'Announcements', state: 'draft' });

    vi.unstubAllGlobals();
  });

  it('loads the tenant-scoped delivery audit for the operations view', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.organizationDeliveryAudit('organization-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/organizations/organization-1/audit/deliveries', expect.any(Object));
    vi.unstubAllGlobals();
  });

  it('names the concrete provisioning phase shown after a failure', () => {
    expect(setupPhaseLabel('storing_credentials')).toBe('Automation Inbox の認証情報を組織DBへ保存しています');
  });
});

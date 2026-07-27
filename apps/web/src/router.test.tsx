import { describe, expect, it } from 'vitest';
import { createMemoryRouter } from 'react-router-dom';

import type { AppState } from '@mail/domain';

import { createAppRoutes, organizationRoutePaths, resolveApplicationRedirect, routePaths } from './router';

describe('application routes', () => {
  it('exposes stable public and organization URLs', () => {
    expect(routePaths).toEqual({
      signedOut: '/',
      setup: '/setup',
      setupConfirm: '/setup/confirm',
      setupProvisioning: '/setup/provisioning',
      setupFailed: '/setup/failed',
      organization: '/organizations/:organizationId',
    });
    expect(organizationRoutePaths).toEqual({
      automation: 'automation',
      connections: 'connections',
      rules: 'rules',
      mailboxTest: 'mailbox-test',
    });
  });

  it('builds shareable organization URLs without string concatenation at call sites', async () => {
    const { organizationUrl } = await import('./router');

    expect(organizationUrl('org/1', 'rules')).toBe('/organizations/org%2F1/rules');
  });

  it('redirects a URL that does not match the durable application state', () => {
    const signedOut = { kind: 'signed_out' } as AppState;
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      organizations: [{ organizationId: 'org-1', name: 'Example', role: 'owner', status: 'active' }],
    } as AppState;

    expect(resolveApplicationRedirect('/setup', signedOut)).toBe('/');
    expect(resolveApplicationRedirect('/setup/confirm', ready)).toBe('/organizations/org-1/automation');
    expect(resolveApplicationRedirect('/organizations/org-1/rules', signedOut)).toBe('/');
    expect(resolveApplicationRedirect('/organizations/org-1/rules', ready)).toBeNull();
  });

  it('supports memory-router deep links and a visible unknown-route match', async () => {
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      organizations: [{ organizationId: 'org-1', name: 'Example', role: 'owner', status: 'active' }],
    } as AppState;
    const router = createMemoryRouter(createAppRoutes({ bootstrap: async () => ready }), { initialEntries: ['/organizations/org-1/rules'] });
    await router.initialize();
    expect(router.state.location.pathname).toBe('/organizations/org-1/rules');
    expect(router.state.matches.at(-1)?.route.path).toBe('rules');

    const unknown = createMemoryRouter(createAppRoutes({ bootstrap: async () => ready }), { initialEntries: ['/unknown'] });
    await unknown.initialize();
    expect(unknown.state.matches.at(-1)?.route.path).toBe('*');
  });
});

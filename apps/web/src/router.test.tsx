import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import type { AppState } from '@mail/domain';

import { createAppRoutes, organizationRoutePaths, resolveApplicationRedirect, routePaths } from './router';
import { logoutFromRouteError } from './routes';

describe('application routes', () => {
  it('exposes stable public and organization URLs', () => {
    expect(routePaths).toEqual({
      signedOut: '/',
      setup: '/setup',
      setupConfirm: '/setup/confirm',
      setupProvisioning: '/setup/provisioning',
      setupFailed: '/setup/failed',
      organization: '/organizations/:organizationId',
      portal: '/portal',
      portalJoin: '/portal/join/:organizationId/:token',
    });
    expect(organizationRoutePaths).toEqual({
      automation: 'automation',
      connections: 'connections',
      rules: 'rules',
      members: 'members',
      mailboxTest: 'mailbox-test',
      tasks: 'tasks',
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
      organizations: [{ organizationId: 'org-1', name: 'Example', status: 'active' }],
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
      organizations: [{ organizationId: 'org-1', name: 'Example', status: 'active' }],
    } as AppState;
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ready,
      logout: async () => ({ loggedOut: true }),
    }), { initialEntries: ['/organizations/org-1/rules'] });
    await router.initialize();
    expect(router.state.location.pathname).toBe('/organizations/org-1/rules');
    expect(router.state.matches.at(-1)?.route.path).toBe('rules');

    const unknown = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ready,
      logout: async () => ({ loggedOut: true }),
    }), { initialEntries: ['/unknown'] });
    await unknown.initialize();
    expect(unknown.state.matches.at(-1)?.route.path).toBe('*');
  });

  it('opens the Organization Task table as a durable deep link', async () => {
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      organizations: [{ organizationId: 'org-1', name: 'Example', status: 'active' }],
    } as AppState;
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ready,
      logout: async () => ({ loggedOut: true }),
    }), { initialEntries: ['/organizations/org-1/tasks'] });
    await router.initialize();
    expect(router.state.matches.at(-1)?.route.path).toBe('tasks');
  });

  it('opens the member roster as a durable deep link', async () => {
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      organizations: [{ organizationId: 'org-1', name: 'Example', status: 'active' }],
    } as AppState;
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ready,
      logout: async () => ({ loggedOut: true }),
    }), { initialEntries: ['/organizations/org-1/members'] });
    await router.initialize();
    expect(router.state.matches.at(-1)?.route.path).toBe('members');
  });

  it('offers a real logout action when a route cannot be displayed', async () => {
    const logout = vi.fn().mockResolvedValue({ loggedOut: true });
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ({ kind: 'signed_out' }),
      logout,
    }), {
      initialEntries: ['/organizations/org-1/automation'],
      hydrationData: {
        loaderData: {},
        errors: { root: new Error('Organization database is unavailable.') },
      },
    });

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain('ログアウトして入口へ戻る');
    expect(markup).toContain('<button');
  });

  it('revokes the session before replacing the broken route with the entry route', async () => {
    const logout = vi.fn().mockResolvedValue({ loggedOut: true });
    const navigate = vi.fn();

    await logoutFromRouteError(logout, navigate);

    expect(logout).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('sends a Member to the Portal and keeps them off the management GUI', () => {
    const member = {
      kind: 'member',
      identity: { email: 'hanako@example.com', displayName: '山田花子' },
      organization: { organizationId: 'org-1', name: 'Example' },
    } as AppState;

    expect(resolveApplicationRedirect('/portal', member)).toBeNull();
    expect(resolveApplicationRedirect('/', member)).toBe('/portal');
    expect(resolveApplicationRedirect('/organizations/org-1/automation', member)).toBe('/portal');
  });

  it('keeps a portal invitation reachable in every application state, so signing in returns to it', () => {
    const signedOut = { kind: 'signed_out' } as AppState;
    const join = '/portal/join/org-1/token-1';

    expect(resolveApplicationRedirect(join, signedOut)).toBeNull();
    expect(resolveApplicationRedirect(join, {
      kind: 'unassigned',
      identity: { email: 'hanako@example.com', displayName: '山田花子' },
    } as AppState)).toBeNull();
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import type { AppState } from '@mail/domain';

import { ApiError } from './api';
import { createAppRoutes, accountRoutePaths, resolveApplicationRedirect, routePaths } from './router';
import { logoutFromRouteError, ContactPortalView } from './routes';
import { pendingKey } from './pending';

describe('application routes', () => {
  it('exposes stable public and organization URLs', () => {
    expect(routePaths).toEqual({
      signedOut: '/',
      setup: '/setup',
      setupConfirm: '/setup/confirm',
      setupProvisioning: '/setup/provisioning',
      setupFailed: '/setup/failed',
      account: '/organizations/:accountId',
      portal: '/portal',
      portalJoin: '/portal/join/:accountId/:token',
    });
    expect(accountRoutePaths).toEqual({
      automation: 'automation',
      chat: 'chat',
      connections: 'connections',
      rules: 'rules',
      contacts: 'members',
      mailboxTest: 'mailbox-test',
      ruleRuns: 'rule-runs',
      eventRefresh: 'event-refresh',
      tasks: 'tasks',
    });
  });

  it('builds shareable organization URLs without string concatenation at call sites', async () => {
    const { accountUrl } = await import('./router');

    expect(accountUrl('org/1', 'rules')).toBe('/organizations/org%2F1/rules');
  });

  it('redirects a URL that does not match the durable application state', () => {
    const signedOut = { kind: 'signed_out' } as AppState;
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      accounts: [{ accountId: 'org-1', name: 'Example', status: 'active' }],
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
      accounts: [{ accountId: 'org-1', name: 'Example', status: 'active' }],
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

  it('opens the Account Task table as a durable deep link', async () => {
    const ready = {
      kind: 'ready',
      identity: { email: 'owner@example.com', displayName: 'Owner' },
      accounts: [{ accountId: 'org-1', name: 'Example', status: 'active' }],
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
      accounts: [{ accountId: 'org-1', name: 'Example', status: 'active' }],
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
        errors: { root: new Error('Account database is unavailable.') },
      },
    });

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain('ログアウトして入口へ戻る');
    expect(markup).toContain('<button');
  });

  it('offers retry first and keeps the session when a schema gate reports its versions', async () => {
    const router = createMemoryRouter(createAppRoutes({
      bootstrap: async () => ({ kind: 'signed_out' }),
      logout: async () => ({ loggedOut: true }),
    }), {
      initialEntries: ['/'],
      hydrationData: {
        loaderData: {},
        errors: {
          root: new ApiError({
            code: 'schema_not_ready',
            databaseKind: 'organization',
            currentMigration: '9999_future.sql',
            expectedMigration: '0017_member_portal.sql',
            requestId: 'request-1',
          }, 503),
        },
      },
    });

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain('再試行');
    expect(markup).toContain('9999_future.sql');
    expect(markup).toContain('0017_member_portal.sql');
    expect(markup.indexOf('再試行')).toBeLessThan(markup.indexOf('ログアウト'));
  });

  it('revokes the session before replacing the broken route with the entry route', async () => {
    const logout = vi.fn().mockResolvedValue({ loggedOut: true });
    const navigate = vi.fn();

    await logoutFromRouteError(logout, navigate);

    expect(logout).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('sends a Contact to the Portal and keeps them off the management GUI', () => {
    const contact = {
      kind: 'member',
      identity: { email: 'hanako@example.com', displayName: '山田花子' },
      account: { accountId: 'org-1', name: 'Example' },
    } as AppState;

    expect(resolveApplicationRedirect('/portal', contact)).toBeNull();
    expect(resolveApplicationRedirect('/', contact)).toBe('/portal');
    expect(resolveApplicationRedirect('/organizations/org-1/automation', contact)).toBe('/portal');
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

describe('Contact Portal progress', () => {
  const portal = {
    account: { accountId: 'org-1', name: 'Example' },
    contact: { contactId: 'member-1', name: '山田' },
    events: [{
      eventId: 'event-1', title: '総会', startsAt: '2026-09-01T01:00:00.000Z', endsAt: '2026-09-01T03:00:00.000Z',
      location: '本部', registrationDeadline: null, status: 'unanswered' as const, comment: '', open: true,
    }],
    tasks: [{
      taskId: 'task-1', title: '参加費を支払う', deadline: '2026-08-25', assigneeRoleName: '会計担当',
      assigneeName: '山田', sourceMessageSubject: '総会案内', description: '', remarks: '', completed: false, mine: true,
    }],
  };
  const view = (pending: (key: string) => boolean, settled: (key: string) => boolean = () => false, running: string[] = []): string =>
    renderToStaticMarkup(<ContactPortalView
      portal={portal}
      running={running}
      pending={pending}
      settled={settled}
      error=""
      onAttendance={vi.fn()}
      onComment={vi.fn()}
      onTaskCompleted={vi.fn()}
      onTaskRemarks={vi.fn()}
      onLogout={vi.fn()}
    />);

  it('reports which attendance answer is being sent', () => {
    const html = view((key) => key === pendingKey.portalAttendance('event-1', 'attending'));

    expect(html.match(/送信中…/gu)?.length).toBe(1);
    expect(html).toContain('欠席');
  });

  it('reports a comment and a remark being saved, and that they were saved', () => {
    const saving = view((key) => key === pendingKey.portalComment('event-1'));
    const saved = view(() => false, (key) => key === pendingKey.portalRemarks('task-1'));

    expect(saving).toContain('保存中…');
    expect(saved).toContain('保存しました');
  });

  it('reports a Contact leaving the portal', () => {
    expect(view((key) => key === pendingKey.portalLogout)).toContain('ログアウト中…');
  });

  it('names the answer being sent in the middle of the page, not only inside the control', () => {
    const html = view(() => true, () => false, [pendingKey.portalAttendance('event-1', 'attending')]);

    expect(html).toContain('class="pending-overlay"');
    expect(html).toContain('出欠を送信しています');
  });
});

describe('route loading progress', () => {
  it('shows a loading screen while the first route resolves', () => {
    const [root] = createAppRoutes({ bootstrap: async () => ({ kind: 'signed_out' } as AppState), logout: async () => ({ loggedOut: true }) });

    expect(root?.hydrateFallbackElement).toBeDefined();
  });
});

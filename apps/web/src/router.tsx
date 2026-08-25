import type { AppState } from '@mail/domain';
import { createBrowserRouter, redirect, type LoaderFunctionArgs } from 'react-router-dom';

import { api } from './api';
import { loadAccount, LoadingRoute, ContactPortalJoinRoute, ContactPortalRoute, NotFoundRoute, OAuthError, AccountLayout, AccountPage, RootLayout, RouteError, SetupConfirmRoute, SetupProgressRoute, SetupRoute } from './routes';

export const routePaths = {
  signedOut: '/',
  setup: '/setup',
  setupConfirm: '/setup/confirm',
  setupProvisioning: '/setup/provisioning',
  setupFailed: '/setup/failed',
  account: '/organizations/:accountId',
  portal: '/portal',
  portalJoin: '/portal/join/:accountId/:token',
} as const;

export const accountRoutePaths = {
  automation: 'automation',
  chat: 'chat',
  automations: 'automations',
  connections: 'connections',
  rules: 'rules',
  contacts: 'members',
  mailboxTest: 'mailbox-test',
  channelTest: 'channel-test',
  ruleRuns: 'rule-runs',
  eventRefresh: 'event-refresh',
  tasks: 'tasks',
  reminders: 'reminders',
} as const;

export const accountUrl = (
  accountId: string,
  page: keyof typeof accountRoutePaths,
): string => `/organizations/${encodeURIComponent(accountId)}/${accountRoutePaths[page]}`;

const firstAccountUrl = (state: Extract<AppState, { kind: 'ready' }>): string => {
  const first = state.accounts[0]?.accountId;
  return first ? accountUrl(first, 'automation') : routePaths.setup;
};

const isAccountPath = (pathname: string): boolean => pathname.startsWith('/organizations/');
const isPortalJoinPath = (pathname: string): boolean => pathname.startsWith('/portal/join/');
const isSetupPath = (pathname: string): boolean => pathname === routePaths.setup || pathname === routePaths.setupConfirm || pathname === routePaths.setupProvisioning || pathname === routePaths.setupFailed;

const accountIdFromPath = (pathname: string): string | null => {
  const match = /^\/organizations\/([^/]+)/u.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

export const resolveApplicationRedirect = (pathname: string, state: AppState): string | null => {
  // A portal invitation is the one entry a Contact has, so it survives every
  // other redirect: signing in returns them to the same link.
  if (isPortalJoinPath(pathname)) return null;
  if (state.kind === 'member') return pathname === routePaths.portal ? null : routePaths.portal;
  if (state.kind === 'signed_out') return pathname === routePaths.signedOut ? null : routePaths.signedOut;
  if (state.kind === 'unassigned') return pathname === routePaths.setup ? null : routePaths.setup;
  if (state.kind === 'confirming_organization') return pathname === routePaths.setupConfirm ? null : routePaths.setupConfirm;
  if (state.kind === 'provisioning') return pathname === routePaths.setupProvisioning ? null : routePaths.setupProvisioning;
  if (state.kind === 'provisioning_failed') return pathname === routePaths.setupFailed ? null : routePaths.setupFailed;

  if (isAccountPath(pathname)) {
    const accountId = accountIdFromPath(pathname);
    return accountId && state.accounts.some((account) => account.accountId === accountId)
      ? null
      : firstAccountUrl(state);
  }
  if (pathname === routePaths.signedOut || isSetupPath(pathname)) return firstAccountUrl(state);
  return null;
};

export type RouterClient = Pick<typeof api, 'bootstrap' | 'logout'>;

const stateLoader = (client: RouterClient) => async ({ request }: LoaderFunctionArgs): Promise<AppState> => {
  const state = await client.bootstrap();
  const destination = resolveApplicationRedirect(new URL(request.url).pathname, state);
  if (destination) throw redirect(destination);
  return state;
};

const rootRoute = (client: RouterClient) => ({
  id: 'root',
  path: '/',
  loader: stateLoader(client),
  element: <RootLayout />,
  hydrateFallbackElement: <LoadingRoute />,
  errorElement: <RouteError logout={client.logout} />,
  children: [
    { index: true, element: <OAuthError /> },
    { path: 'portal', loader: stateLoader(client), element: <ContactPortalRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'portal/join/:accountId/:token', loader: stateLoader(client), element: <ContactPortalJoinRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup', loader: stateLoader(client), element: <SetupRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup/confirm', loader: stateLoader(client), element: <SetupConfirmRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup/provisioning', loader: stateLoader(client), element: <SetupProgressRoute failed={false} />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup/failed', loader: stateLoader(client), element: <SetupProgressRoute failed />, errorElement: <RouteError logout={client.logout} /> },
    {
      path: 'organizations/:accountId',
      loader: ({ params }: LoaderFunctionArgs) => loadAccount(params.accountId ?? ''),
      element: <AccountLayout />,
      errorElement: <RouteError logout={client.logout} />,
      children: [
        { index: true, loader: () => redirect('automation'), element: <LoadingRoute /> },
        { path: 'automation', element: <AccountPage page="automation" /> },
        { path: 'chat', element: <AccountPage page="chat" /> },
        { path: 'automations', element: <AccountPage page="automations" /> },
        { path: 'connections', element: <AccountPage page="connections" /> },
        { path: 'rules', element: <AccountPage page="rules" /> },
        { path: 'rules/schema/:ruleId', element: <AccountPage page="schema-rule" /> },
        { path: 'members', element: <AccountPage page="members" /> },
        { path: 'mailbox-test', element: <AccountPage page="mailbox-test" /> },
        { path: 'channel-test', element: <AccountPage page="channel-test" /> },
        { path: 'rule-runs', element: <AccountPage page="rule-runs" /> },
        { path: 'event-refresh', element: <AccountPage page="event-refresh" /> },
        { path: 'tasks', element: <AccountPage page="tasks" /> },
        { path: 'reminders', element: <AccountPage page="reminders" /> },
      ],
    },
    { path: '*', element: <NotFoundRoute /> },
  ],
});

export const createAppRoutes = (client: RouterClient = api) => [rootRoute(client)];
export const createAppRouter = (client: RouterClient = api) => createBrowserRouter(createAppRoutes(client));

import type { AppState } from '@mail/domain';
import { createBrowserRouter, redirect, type LoaderFunctionArgs } from 'react-router-dom';

import { api } from './api';
import { loadOrganization, LoadingRoute, MemberPortalJoinRoute, MemberPortalRoute, NotFoundRoute, OAuthError, OrganizationLayout, OrganizationPage, RootLayout, RouteError, SetupConfirmRoute, SetupProgressRoute, SetupRoute } from './routes';

export const routePaths = {
  signedOut: '/',
  setup: '/setup',
  setupConfirm: '/setup/confirm',
  setupProvisioning: '/setup/provisioning',
  setupFailed: '/setup/failed',
  organization: '/organizations/:organizationId',
  portal: '/portal',
  portalJoin: '/portal/join/:organizationId/:token',
} as const;

export const organizationRoutePaths = {
  automation: 'automation',
  connections: 'connections',
  rules: 'rules',
  members: 'members',
  ruleRuns: 'rule-runs',
  eventRefresh: 'event-refresh',
  tasks: 'tasks',
} as const;

export const organizationUrl = (
  organizationId: string,
  page: keyof typeof organizationRoutePaths,
): string => `/organizations/${encodeURIComponent(organizationId)}/${organizationRoutePaths[page]}`;

const firstOrganizationUrl = (state: Extract<AppState, { kind: 'ready' }>): string => {
  const first = state.organizations[0]?.organizationId;
  return first ? organizationUrl(first, 'automation') : routePaths.setup;
};

const isOrganizationPath = (pathname: string): boolean => pathname.startsWith('/organizations/');
const isPortalJoinPath = (pathname: string): boolean => pathname.startsWith('/portal/join/');
const isSetupPath = (pathname: string): boolean => pathname === routePaths.setup || pathname === routePaths.setupConfirm || pathname === routePaths.setupProvisioning || pathname === routePaths.setupFailed;

const organizationIdFromPath = (pathname: string): string | null => {
  const match = /^\/organizations\/([^/]+)/u.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

export const resolveApplicationRedirect = (pathname: string, state: AppState): string | null => {
  // A portal invitation is the one entry a Member has, so it survives every
  // other redirect: signing in returns them to the same link.
  if (isPortalJoinPath(pathname)) return null;
  if (state.kind === 'member') return pathname === routePaths.portal ? null : routePaths.portal;
  if (state.kind === 'signed_out') return pathname === routePaths.signedOut ? null : routePaths.signedOut;
  if (state.kind === 'unassigned') return pathname === routePaths.setup ? null : routePaths.setup;
  if (state.kind === 'confirming_organization') return pathname === routePaths.setupConfirm ? null : routePaths.setupConfirm;
  if (state.kind === 'provisioning') return pathname === routePaths.setupProvisioning ? null : routePaths.setupProvisioning;
  if (state.kind === 'provisioning_failed') return pathname === routePaths.setupFailed ? null : routePaths.setupFailed;

  if (isOrganizationPath(pathname)) {
    const organizationId = organizationIdFromPath(pathname);
    return organizationId && state.organizations.some((organization) => organization.organizationId === organizationId)
      ? null
      : firstOrganizationUrl(state);
  }
  if (pathname === routePaths.signedOut || isSetupPath(pathname)) return firstOrganizationUrl(state);
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
    { path: 'portal', loader: stateLoader(client), element: <MemberPortalRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'portal/join/:organizationId/:token', loader: stateLoader(client), element: <MemberPortalJoinRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup', loader: stateLoader(client), element: <SetupRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup/confirm', loader: stateLoader(client), element: <SetupConfirmRoute />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup/provisioning', loader: stateLoader(client), element: <SetupProgressRoute failed={false} />, errorElement: <RouteError logout={client.logout} /> },
    { path: 'setup/failed', loader: stateLoader(client), element: <SetupProgressRoute failed />, errorElement: <RouteError logout={client.logout} /> },
    {
      path: 'organizations/:organizationId',
      loader: ({ params }: LoaderFunctionArgs) => loadOrganization(params.organizationId ?? ''),
      element: <OrganizationLayout />,
      errorElement: <RouteError logout={client.logout} />,
      children: [
        { index: true, loader: () => redirect('automation'), element: <LoadingRoute /> },
        { path: 'automation', element: <OrganizationPage page="automation" /> },
        { path: 'connections', element: <OrganizationPage page="connections" /> },
        { path: 'rules', element: <OrganizationPage page="rules" /> },
        { path: 'members', element: <OrganizationPage page="members" /> },
        { path: 'mailbox-test', element: <OrganizationPage page="rule-runs" /> },
        { path: 'rule-runs', element: <OrganizationPage page="rule-runs" /> },
        { path: 'event-refresh', element: <OrganizationPage page="event-refresh" /> },
        { path: 'tasks', element: <OrganizationPage page="tasks" /> },
      ],
    },
    { path: '*', element: <NotFoundRoute /> },
  ],
});

export const createAppRoutes = (client: RouterClient = api) => [rootRoute(client)];
export const createAppRouter = (client: RouterClient = api) => createBrowserRouter(createAppRoutes(client));

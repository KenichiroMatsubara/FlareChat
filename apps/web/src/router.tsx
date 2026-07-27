import type { AppState } from '@mail/domain';
import { createBrowserRouter, Outlet, redirect, type LoaderFunctionArgs } from 'react-router-dom';

import { api } from './api';
import { loadOrganization, LoadingRoute, NotFoundRoute, OAuthError, OrganizationLayout, OrganizationPage, RouteError, SetupConfirmRoute, SetupProgressRoute, SetupRoute } from './routes';

export const routePaths = {
  signedOut: '/',
  setup: '/setup',
  setupConfirm: '/setup/confirm',
  setupProvisioning: '/setup/provisioning',
  setupFailed: '/setup/failed',
  organization: '/organizations/:organizationId',
} as const;

export const organizationRoutePaths = {
  automation: 'automation',
  connections: 'connections',
  rules: 'rules',
  mailboxTest: 'mailbox-test',
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
const isSetupPath = (pathname: string): boolean => pathname === routePaths.setup || pathname === routePaths.setupConfirm || pathname === routePaths.setupProvisioning || pathname === routePaths.setupFailed;

const organizationIdFromPath = (pathname: string): string | null => {
  const match = /^\/organizations\/([^/]+)/u.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

export const resolveApplicationRedirect = (pathname: string, state: AppState): string | null => {
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

export type RouterClient = Pick<typeof api, 'bootstrap'>;

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
  element: <Outlet />,
  errorElement: <RouteError />,
  children: [
    { index: true, element: <OAuthError /> },
    { path: 'setup', loader: stateLoader(client), element: <SetupRoute />, errorElement: <RouteError /> },
    { path: 'setup/confirm', loader: stateLoader(client), element: <SetupConfirmRoute />, errorElement: <RouteError /> },
    { path: 'setup/provisioning', loader: stateLoader(client), element: <SetupProgressRoute failed={false} />, errorElement: <RouteError /> },
    { path: 'setup/failed', loader: stateLoader(client), element: <SetupProgressRoute failed />, errorElement: <RouteError /> },
    {
      path: 'organizations/:organizationId',
      loader: ({ params }: LoaderFunctionArgs) => loadOrganization(params.organizationId ?? ''),
      element: <OrganizationLayout />,
      errorElement: <RouteError />,
      children: [
        { index: true, loader: () => redirect('automation'), element: <LoadingRoute /> },
        { path: 'automation', element: <OrganizationPage page="automation" /> },
        { path: 'connections', element: <OrganizationPage page="connections" /> },
        { path: 'rules', element: <OrganizationPage page="rules" /> },
        { path: 'mailbox-test', element: <OrganizationPage page="mail-test" /> },
      ],
    },
    { path: '*', element: <NotFoundRoute /> },
  ],
});

export const createAppRoutes = (client: RouterClient = api) => [rootRoute(client)];
export const createAppRouter = (client: RouterClient = api) => createBrowserRouter(createAppRoutes(client));

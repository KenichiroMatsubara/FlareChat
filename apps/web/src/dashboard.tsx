import { CalendarClock, CheckSquare, CircleAlert, LogOut, Mail, Menu, MessageSquare, Pencil, Play, RefreshCw, Settings, ShieldAlert, ShieldCheck, SlidersHorizontal, UsersRound, X } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { isRouteErrorResponse, NavLink, Outlet, useLoaderData, useLocation, useNavigate, useNavigation, useRevalidator, useRouteError, type LoaderFunctionArgs } from 'react-router-dom';

import type { AccountMembership, AppState } from '@mail/domain';

import { api } from './api';
import { pendingKey, ROUTE_NAVIGATION_KEY, usePendingOperations } from './pending';
import { PendingOverlay } from './progress';

export type ReadyState = Extract<AppState, { kind: 'ready' }>;

/** What every screen shares (ADR 0170): the application state and the Account. */
export interface AccountData {
  state: ReadyState;
  account: AccountMembership;
}

export const loadAccount = async (accountId: string): Promise<AccountData> => {
  const state = await api.bootstrap();
  if (state.kind !== 'ready') throw new Response('Account is not ready', { status: 409 });
  const account = state.accounts.find((value) => value.accountId === accountId);
  if (!account) throw new Response('Account was not found', { status: 404 });
  return { state, account };
};

/** The Account a screen loader is asked for, read from the route. */
export const accountIdOf = ({ params }: LoaderFunctionArgs): string => params.accountId ?? '';

/** The shell's context: the state, the Account, and the two actions every screen offers. */
export interface AccountShell extends AccountData {
  logout: () => void;
  reauthenticate: () => void;
  leaving: boolean;
  reauthenticating: boolean;
}

const AccountContext = createContext<AccountShell | null>(null);

export const useAccount = (): AccountShell => {
  const value = useContext(AccountContext);
  if (!value) throw new Error('Account shell context is unavailable.');
  return value;
};

export const needsGoogleReauthentication = (error: string): boolean =>
  /token has been expired or revoked/iu.test(error);

export const GoogleReauthenticationAction = ({ onClick, busy = false }: { onClick: () => void; busy?: boolean }) =>
  <button className="secondary credential-recovery" onClick={onClick} disabled={busy}>
    {busy ? <RefreshCw className="spin" size={16} /> : <ShieldCheck size={16} />}
    {busy ? 'Google へ接続中…' : 'Automation Inbox を再接続する'}
  </button>;

/** Width at which the collapsed navigation drawer becomes the standing side bar. */
export const DESKTOP_NAVIGATION_QUERY = '(min-width: 1101px)';

export const NAVIGATION_PANEL_ID = 'app-navigation';

interface NavigationItem {
  readonly to: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}

/** The nine screens, each named for what it is responsible for (ADR 0167). */
const navigationItems: readonly NavigationItem[] = [
  { to: 'automation', label: '自動化', icon: <Play size={16} /> },
  { to: 'chat', label: 'チャット', icon: <MessageSquare size={16} /> },
  { to: 'automations', label: '定期実行', icon: <CalendarClock size={16} /> },
  { to: 'tasks', label: 'タスク', icon: <CheckSquare size={16} /> },
  { to: 'operations', label: '運用', icon: <ShieldAlert size={16} /> },
  { to: 'rules', label: 'ルール', icon: <SlidersHorizontal size={16} /> },
  { to: 'prompts', label: 'Prompt', icon: <Pencil size={16} /> },
  { to: 'contacts', label: '連絡先', icon: <UsersRound size={16} /> },
  { to: 'connections', label: '接続設定', icon: <Settings size={16} /> },
];

/**
 * The Account shell: navigation, the picker, and an outlet for the screen
 * (ADR 0170). It loads nothing a screen reads and holds no screen's state.
 */
export const Dashboard = () => {
  const { state, account } = useLoaderData<AccountData>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const location = useLocation();
  const operations = usePendingOperations();
  const [menuOpen, setMenuOpen] = useState(false);
  const navigating = navigation.state !== 'idle';
  const leaving = operations.pending(pendingKey.logout);
  const reauthenticating = operations.pending(pendingKey.reauthenticate);
  const logout = (): void => void operations.run(pendingKey.logout, async () => { await api.logout(); navigate('/', { replace: true }); });
  const reauthenticate = (): void => void operations.run(pendingKey.reauthenticate, async () => {
    window.location.assign((await api.reauthorizeAutomationInbox(account.accountId)).authorizationUrl);
  });

  useEffect(() => setMenuOpen(false), [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const desktop = window.matchMedia(DESKTOP_NAVIGATION_QUERY);
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenuOpen(false); };
    const closeOnDesktop = (): void => { if (desktop.matches) setMenuOpen(false); };
    const scrollLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    desktop.addEventListener('change', closeOnDesktop);
    return () => {
      document.body.style.overflow = scrollLock;
      window.removeEventListener('keydown', closeOnEscape);
      desktop.removeEventListener('change', closeOnDesktop);
    };
  }, [menuOpen]);

  const shell: AccountShell = { state, account, logout, reauthenticate, leaving, reauthenticating };
  return <AccountContext.Provider value={shell}><div className="app-shell">
    <header className="app-topbar">
      <div className="app-brand"><span><Mail size={20} /></span><strong>FlareChat</strong></div>
      <button type="button" className="topbar-toggle" aria-controls={NAVIGATION_PANEL_ID} aria-expanded={menuOpen} aria-label={menuOpen ? 'メニューを閉じる' : 'メニューを開く'} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
    </header>
    <PendingOverlay running={navigating ? [ROUTE_NAVIGATION_KEY, ...operations.running] : operations.running} />
    {menuOpen && <button type="button" className="topbar-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setMenuOpen(false)} />}
    <div className="app-body">
      <div id={NAVIGATION_PANEL_ID} className={menuOpen ? 'topbar-panel open' : 'topbar-panel'}>
        <label className="organization-picker"><span className="sr-only">Account</span><select aria-label="Account" value={account.accountId} disabled={navigating} onChange={(event) => navigate(`/organizations/${encodeURIComponent(event.target.value)}/automation`)}>{state.accounts.map((membership) => <option key={membership.accountId} value={membership.accountId}>{membership.name}</option>)}</select></label>
        <nav aria-label="メインナビゲーション">
          {navigationItems.map((item) => <NavLink key={item.to} to={item.to} className={({ isActive, isPending }) => [isActive ? 'active' : '', isPending ? 'loading' : ''].filter(Boolean).join(' ')} onClick={() => setMenuOpen(false)}>{item.icon}{item.label}</NavLink>)}
        </nav>
        <button className="topbar-logout" onClick={logout} disabled={leaving}>{leaving ? <RefreshCw className="spin" size={16} /> : <LogOut size={16} />}{leaving ? 'ログアウト中…' : 'ログアウト'}</button>
      </div>
      <main className={navigating ? 'app-content navigating' : 'app-content'} aria-busy={navigating}>
        {operations.error && <div className="dashboard-error"><p><CircleAlert size={17} />{operations.error}</p></div>}
        <Outlet key={account.accountId} />
      </main>
    </div>
  </div></AccountContext.Provider>;
};

/** A screen whose loader failed, shown inside the shell so the way out stays visible. */
export const ScreenError = () => {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const { reauthenticate, reauthenticating } = useAccount();
  const message = isRouteErrorResponse(error)
    ? error.status === 404 ? 'この画面の対象が見つかりません。' : error.statusText || '画面を表示できませんでした。'
    : error instanceof Error ? error.message : '画面を表示できませんでした。';
  return <section className="page-layout">
    <div className="dashboard-error">
      <p><CircleAlert size={17} />{message}</p>
      {needsGoogleReauthentication(message) && <GoogleReauthenticationAction onClick={reauthenticate} busy={reauthenticating} />}
      <button className="secondary" type="button" onClick={() => void revalidator.revalidate()} disabled={revalidator.state !== 'idle'}>
        {revalidator.state !== 'idle' ? <><RefreshCw className="spin" size={14} />再試行中…</> : '再試行'}
      </button>
    </div>
  </section>;
};

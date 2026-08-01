import { CheckSquare, CircleAlert, LogOut, Mail, Menu, Play, Settings, ShieldCheck, SlidersHorizontal, UsersRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import type { AutomationStatus, AutomationSummary, MailboxTestAiRequest, MailboxTestMatch, MailboxTestPreview, OrganizationConnections, OrganizationLineDestination, OrganizationMembership, OrganizationRecipient, OrganizationRecipientInput, OrganizationRule, OrganizationRuleInput, OrganizationTask, RecipientLineDestinationInput, TaskRoleAssignment } from './api';
import { AutomationPage, ConnectionsPage, MailboxTestPage, MembersPage, RulesPage, TasksPage } from './dashboard-pages';

export type Page = 'automation' | 'connections' | 'rules' | 'members' | 'mail-test' | 'tasks';

export const needsGoogleReauthentication = (error: string): boolean =>
  /token has been expired or revoked/iu.test(error);

export const GoogleReauthenticationAction = ({ onClick }: { onClick: () => void }) =>
  <button className="secondary credential-recovery" onClick={onClick}><ShieldCheck size={16} />Automation Inbox を再接続する</button>;

/** Width at which the collapsed navigation panel becomes the inline top bar. */
export const DESKTOP_NAVIGATION_QUERY = '(min-width: 1101px)';

export const NAVIGATION_PANEL_ID = 'app-navigation';

interface NavigationItem {
  readonly to: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}

const navigationItems: readonly NavigationItem[] = [
  { to: '../automation', label: '自動化', icon: <Play size={16} /> },
  { to: '../connections', label: '接続設定', icon: <Settings size={16} /> },
  { to: '../rules', label: 'ルール', icon: <SlidersHorizontal size={16} /> },
  { to: '../members', label: 'メンバー', icon: <UsersRound size={16} /> },
  { to: '../tasks', label: 'タスク', icon: <CheckSquare size={16} /> },
  { to: '../mailbox-test', label: 'メールテスト', icon: <SlidersHorizontal size={16} /> },
];

export interface DashboardProps {
  page?: Page;
  automation: AutomationStatus | null;
  summary: AutomationSummary | null;
  busy: boolean;
  error: string;
  onRun: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onLogout: () => void;
  onReauthenticate: () => void;
  organization: { name: string; role: string } | null;
  organizationId?: string;
  organizations?: OrganizationMembership[];
  canManage: boolean;
  connections: OrganizationConnections | null;
  lineChannelAccessToken: string;
  lineChannelSecret: string;
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  onLineChannelAccessTokenChange: (value: string) => void;
  onLineChannelSecretChange: (value: string) => void;
  onAiApiKeyChange: (value: string) => void;
  onAiModelChange: (value: string) => void;
  onAiBaseUrlChange: (value: string) => void;
  settingsBusy: boolean;
  onSaveConnections: () => void;
  aiTestPrompt: string;
  aiTestResult: string;
  aiTestBusy: boolean;
  onAiTestPromptChange: (value: string) => void;
  onTestAi: () => void;
  mailTestSubject: string;
  mailTestMatches: MailboxTestMatch[];
  mailTestAiRequest: MailboxTestAiRequest | null;
  mailTestPreview: MailboxTestPreview | null;
  mailTestBusy: boolean;
  mailTestCreatedEventIds: string[];
  onMailTestSubjectChange: (value: string) => void;
  onSearchMailbox: () => void;
  onPrepareMailbox: (messageId: string) => void;
  onPreviewMailbox: (messageId: string) => void;
  onCreateCalendarEvent: () => void;
  organizationRules: OrganizationRule[];
  ruleBusy: boolean;
  onCreateRule: (input: OrganizationRuleInput) => Promise<void>;
  organizationTasks: OrganizationTask[];
  onUpdateTask: (taskId: string, input: { completed?: boolean; remarks?: string }) => void;
  taskRoleAssignments: TaskRoleAssignment[];
  taskMembers: Array<{ identityId: string; displayName: string }>;
  onAssignTaskRole: (role: 'organizer' | 'treasurer', identityId: string) => void;
  organizationRecipients: OrganizationRecipient[];
  lineDestinations: OrganizationLineDestination[];
  memberBusy: boolean;
  onCreateRecipient: (input: OrganizationRecipientInput) => Promise<OrganizationRecipient | null>;
  onUpdateRecipient: (recipientId: string, input: Partial<Pick<OrganizationRecipient, 'name' | 'email' | 'tags' | 'state'>>) => Promise<void>;
  onSetLineDestination: (recipientId: string, input: RecipientLineDestinationInput) => Promise<void>;
  onUnlinkLineDestination: (recipientId: string, lineDestinationId: string) => Promise<void>;
  onRefreshRecipients: () => void;
}

export const Dashboard = (props: DashboardProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const page = props.page ?? 'automation';
  const content = page === 'automation'
    ? <AutomationPage {...props} />
    : page === 'connections'
      ? <ConnectionsPage {...props} />
      : page === 'rules'
        ? <RulesPage {...props} />
        : page === 'members'
          ? <MembersPage {...props} />
          : page === 'tasks' ? <TasksPage {...props} /> : <MailboxTestPage {...props} />;
  const requiresGoogleReauthentication = needsGoogleReauthentication(props.error)
    || props.automation?.status === 'reauthentication_required';
  const recoveryMessage = props.error || 'Automation Inbox の認証が失効しています。Google に再接続してください。';

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

  return <div className="app-shell">
    <header className="app-topbar">
      <div className="app-brand"><span><Mail size={20} /></span><strong>Mail Automation</strong></div>
      <button type="button" className="topbar-toggle" aria-controls={NAVIGATION_PANEL_ID} aria-expanded={menuOpen} aria-label={menuOpen ? 'メニューを閉じる' : 'メニューを開く'} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
      <div id={NAVIGATION_PANEL_ID} className={menuOpen ? 'topbar-panel open' : 'topbar-panel'}>
        {props.organizations && props.organizationId && <label className="organization-picker"><span className="sr-only">Organization</span><select aria-label="Organization" value={props.organizationId} onChange={(event) => navigate(`/organizations/${encodeURIComponent(event.target.value)}/automation`)}>{props.organizations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.name}</option>)}</select></label>}
        <nav aria-label="メインナビゲーション">
          {navigationItems.map((item) => <NavLink key={item.to} to={item.to} className={({ isActive }) => isActive ? 'active' : ''} onClick={() => setMenuOpen(false)}>{item.icon}{item.label}</NavLink>)}
        </nav>
        <button className="topbar-logout" onClick={props.onLogout} disabled={props.busy}><LogOut size={16} />ログアウト</button>
      </div>
    </header>
    {menuOpen && <button type="button" className="topbar-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setMenuOpen(false)} />}
    <main className="app-content">
      {(props.error || requiresGoogleReauthentication) && <div className="dashboard-error"><p><CircleAlert size={17} />{recoveryMessage}</p>{requiresGoogleReauthentication && <GoogleReauthenticationAction onClick={props.onReauthenticate} />}</div>}
      {content}
    </main>
  </div>;
};

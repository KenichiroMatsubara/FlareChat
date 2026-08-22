import { CalendarClock, CheckSquare, CircleAlert, LogOut, Mail, Menu, MessageSquare, Play, RefreshCw, Send, Settings, ShieldCheck, SlidersHorizontal, UsersRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import type { AgentRunIndex, AgentRunTranscript, AutomationStatus, AutomationSummary, GuestRegistrationRoster, MailboxTestAiRequest, MailboxTestMatch, MailboxTestPreview, MailboxTestRefreshOutcome, MailboxTestRefreshPlan, MailboxTestRefreshRequest, AccountAgentRule, AccountConnections, AccountLineDestination, AccountMembership, AccountPrompt, AccountContact, AccountContactInput, AccountRule, AccountRuleInput, AccountTask, AccountTypedList, PresetSummary, ContactLineDestinationInput, RuleRun } from './api';
import { AutomationPage, ConnectionsPage, EventRefreshPage, MailboxTestPage, ContactsPage, RuleRunsPage, RulesPage, TasksPage } from './dashboard-pages';
import { ChannelTestPage } from './channel-test';
import { ChatPage } from './chat';
import { AutomationsPage } from './automations';
import { pendingKey, ROUTE_NAVIGATION_KEY } from './pending';
import { PendingOverlay } from './progress';

export type Page = 'automation' | 'chat' | 'automations' | 'connections' | 'rules' | 'members' | 'mailbox-test' | 'channel-test' | 'rule-runs' | 'event-refresh' | 'tasks';

export const needsGoogleReauthentication = (error: string): boolean =>
  /token has been expired or revoked/iu.test(error);

export const GoogleReauthenticationAction = ({ onClick, busy = false }: { onClick: () => void; busy?: boolean }) =>
  <button className="secondary credential-recovery" onClick={onClick} disabled={busy}>
    {busy ? <RefreshCw className="spin" size={16} /> : <ShieldCheck size={16} />}
    {busy ? 'Google へ接続中…' : 'Automation Inbox を再接続する'}
  </button>;

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
  { to: '../chat', label: 'チャット', icon: <MessageSquare size={16} /> },
  { to: '../automations', label: '定期実行', icon: <CalendarClock size={16} /> },
  { to: '../connections', label: '接続設定', icon: <Settings size={16} /> },
  { to: '../rules', label: 'ルール', icon: <SlidersHorizontal size={16} /> },
  { to: '../members', label: '連絡先', icon: <UsersRound size={16} /> },
  { to: '../tasks', label: 'タスク', icon: <CheckSquare size={16} /> },
  { to: '../mailbox-test', label: 'メールテスト', icon: <Mail size={16} /> },
  { to: '../channel-test', label: '送信テスト', icon: <Send size={16} /> },
  { to: '../rule-runs', label: 'Rule Runs', icon: <SlidersHorizontal size={16} /> },
  { to: '../event-refresh', label: '予定の再同期', icon: <RefreshCw size={16} /> },
];

export interface DashboardProps {
  page?: Page;
  automation: AutomationStatus | null;
  summary: AutomationSummary | null;
  /** True while the named operation runs, so only its own control reports it. */
  isPending: (key: string) => boolean;
  /** True for a short while after the named operation succeeded. */
  isSettled: (key: string) => boolean;
  /** True while React Router is loading another route's data. */
  navigating: boolean;
  /** Every operation this screen has in flight, named in the centre of the page. */
  runningOperations: readonly string[];
  error: string;
  onRun: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onLogout: () => void;
  onReauthenticate: () => void;
  account: { name: string } | null;
  accountId?: string;
  accounts?: AccountMembership[];
  connections: AccountConnections | null;
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
  guestRegistrations: GuestRegistrationRoster[];
  attachmentFolderPath: string;
  savedAttachmentFolderPath: string;
  onAttachmentFolderPathChange: (value: string) => void;
  onSaveAttachmentFolderPath: () => void;
  responseWindowDays: string;
  savedResponseWindowDays: number;
  onResponseWindowDaysChange: (value: string) => void;
  onSaveResponseWindowDays: () => void;
  onSaveLineConnection: () => void;
  onSaveAiConnection: () => void;
  aiTestPrompt: string;
  aiTestResult: string;
  onAiTestPromptChange: (value: string) => void;
  onTestAi: () => void;
  mailTestSubject: string;
  mailTestMatches: MailboxTestMatch[];
  mailTestAiRequest: MailboxTestAiRequest | null;
  mailTestPreview: MailboxTestPreview | null;
  draftRulePreview: MailboxTestPreview | null;
  mailTestCreatedEventIds: string[];
  mailTestRuleRunIds: string[];
  mailTestRefreshRequest: MailboxTestRefreshRequest | null;
  mailTestRefreshPlan: MailboxTestRefreshPlan | null;
  mailTestRefreshOutcome: MailboxTestRefreshOutcome | null;
  onMailTestSubjectChange: (value: string) => void;
  onSearchMailbox: () => void;
  onPrepareMailbox: (messageId: string) => void;
  onPreviewMailbox: (messageId: string) => void;
  onPreviewDraftMailbox: (messageId: string, ruleId: string) => void;
  onCreateMailboxTestEvents: () => void;
  onStartDraftRuleRun: (ruleId: string) => void;
  onPrepareRefresh: () => void;
  onPlanRefresh: () => void;
  onApplyRefresh: (candidateIndexes: number[]) => void;
  accountRules: AccountRule[];
  accountLists: AccountTypedList[];
  onCreateRule: (input: AccountRuleInput) => Promise<void>;
  /** The Contacts a notice can actually reach, and the Channels each is reachable on. */
  noticeTargets: Array<{ id: string; name: string; channels: string[] }>;
  /** The named sets of Contacts this Account holds, so a Rule can say who it tells. */
  contactLists: Array<{ id: string; name: string; contactIds: string[] }>;
  onSaveNoticeContacts: (ruleId: string, contactIds: string[]) => Promise<void>;
  onUpdateRule: (ruleId: string, input: Partial<Pick<AccountRule, 'state' | 'executionMode' | 'noticeContactListId' | 'permittedRecipientListIds' | 'permittedLineListIds'>>) => Promise<void>;
  prompts: AccountPrompt[];
  agentRules: AccountAgentRule[];
  agentRuns: AgentRunIndex[];
  agentTranscript: AgentRunTranscript | null;
  ruleRuns: RuleRun[];
  onDecideRuleRun: (runId: string, decision: 'approve' | 'reject') => void;
  onCreatePrompt: (input: { name: string; instructions: string }) => Promise<void>;
  onUpdatePrompt: (promptId: string, input: { name?: string; instructions?: string }) => Promise<void>;
  onDeletePrompt: (promptId: string) => Promise<void>;
  onCreateAgentRule: (input: { name: string; promptId: string; state: 'draft' | 'active'; executionMode?: 'read_only' | 'approval' | 'unattended'; selectionPolicy: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[]; priority?: number }) => Promise<void>;
  onUpdateAgentRule: (agentRuleId: string, input: { state?: 'draft' | 'active' | 'suspended' | 'archived'; executionMode?: 'read_only' | 'approval' | 'unattended'; permittedRecipientListIds?: string[]; permittedLineListIds?: string[] }) => Promise<void>;
  onLoadAgentTranscript: (runId: string) => void;
  accountTasks: AccountTask[];
  onUpdateTask: (taskId: string, input: { completed?: boolean; remarks?: string; assigneeContactId?: string | null }) => void;
  taskContacts: Array<{ contactId: string; displayName: string }>;
  /** Task ids an accepted proposal could not be applied to. */
  accountContacts: AccountContact[];
  lineDestinations: AccountLineDestination[];
  onCreateContact: (input: AccountContactInput) => Promise<AccountContact | null>;
  onUpdateContact: (contactId: string, input: Partial<Pick<AccountContact, 'name' | 'email' | 'description' | 'tags' | 'state'>>) => Promise<void>;
  onSetLineDestination: (contactId: string, input: ContactLineDestinationInput) => Promise<void>;
  onUnlinkLineDestination: (contactId: string, lineDestinationId: string) => Promise<void>;
  onRegisterLineDestination: (input: ContactLineDestinationInput) => Promise<void>;
  onRemoveLineDestination: (lineDestinationId: string) => Promise<void>;
  onRefreshContacts: () => void;
  presets: PresetSummary[];
  onApplyPreset: (presetId: string, conflictPolicy?: 'duplicate') => void;
}

export const Dashboard = (props: DashboardProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const loggingOut = props.isPending(pendingKey.logout);
  const page = props.page ?? 'automation';
  const content = page === 'automation'
    ? <AutomationPage {...props} />
    : page === 'chat'
      ? <ChatPage accountId={props.accountId ?? ''} />
      : page === 'automations'
        ? <AutomationsPage accountId={props.accountId ?? ''} />
        : page === 'channel-test'
          ? <ChannelTestPage accountId={props.accountId ?? ''} />
    : page === 'connections'
      ? <ConnectionsPage {...props} />
      : page === 'rules'
        ? <RulesPage {...props} />
        : page === 'members'
          ? <ContactsPage {...props} />
          : page === 'tasks'
            ? <TasksPage {...props} />
            : page === 'mailbox-test'
              ? <MailboxTestPage {...props} />
              : page === 'event-refresh' ? <EventRefreshPage {...props} /> : <RuleRunsPage {...props} />;
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
        {props.accounts && props.accountId && <label className="organization-picker"><span className="sr-only">Account</span><select aria-label="Account" value={props.accountId} disabled={props.navigating} onChange={(event) => navigate(`/organizations/${encodeURIComponent(event.target.value)}/automation`)}>{props.accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.name}</option>)}</select></label>}
        <nav aria-label="メインナビゲーション">
          {navigationItems.map((item) => <NavLink key={item.to} to={item.to} className={({ isActive, isPending }) => [isActive ? 'active' : '', isPending ? 'loading' : ''].filter(Boolean).join(' ')} onClick={() => setMenuOpen(false)}>{item.icon}{item.label}</NavLink>)}
        </nav>
        <button className="topbar-logout" onClick={props.onLogout} disabled={loggingOut}>{loggingOut ? <RefreshCw className="spin" size={16} /> : <LogOut size={16} />}{loggingOut ? 'ログアウト中…' : 'ログアウト'}</button>
      </div>
    </header>
    <PendingOverlay running={props.navigating ? [ROUTE_NAVIGATION_KEY, ...props.runningOperations] : props.runningOperations} />
    {menuOpen && <button type="button" className="topbar-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setMenuOpen(false)} />}
    <main className={props.navigating ? 'app-content navigating' : 'app-content'} aria-busy={props.navigating}>
      {(props.error || requiresGoogleReauthentication) && <div className="dashboard-error"><p><CircleAlert size={17} />{recoveryMessage}</p>{requiresGoogleReauthentication && <GoogleReauthenticationAction onClick={props.onReauthenticate} busy={props.isPending(pendingKey.reauthenticate)} />}</div>}
      {content}
    </main>
  </div>;
};

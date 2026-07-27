import { CheckSquare, CircleAlert, LogOut, Mail, Play, Settings, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';

import type { AutomationStatus, AutomationSummary, MailboxTestGeminiRequest, MailboxTestMatch, MailboxTestPreview, OrganizationConnections, OrganizationMembership, OrganizationRule, OrganizationRuleInput, OrganizationTask, TaskRoleAssignment } from './api';
import { AutomationPage, ConnectionsPage, MailboxTestPage, RulesPage, TasksPage } from './dashboard-pages';

export type Page = 'automation' | 'connections' | 'rules' | 'mail-test' | 'tasks';

export const needsGoogleReauthentication = (error: string): boolean =>
  /token has been expired or revoked/iu.test(error);

export const GoogleReauthenticationAction = ({ onClick }: { onClick: () => void }) =>
  <button className="secondary credential-recovery" onClick={onClick}><ShieldCheck size={16} />Automation Inbox を再接続する</button>;

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
  geminiApiKey: string;
  aiModel: string;
  onLineChannelAccessTokenChange: (value: string) => void;
  onLineChannelSecretChange: (value: string) => void;
  onGeminiApiKeyChange: (value: string) => void;
  onAiModelChange: (value: string) => void;
  settingsBusy: boolean;
  onSaveConnections: () => void;
  geminiTestPrompt: string;
  geminiTestResult: string;
  geminiTestBusy: boolean;
  onGeminiTestPromptChange: (value: string) => void;
  onTestGemini: () => void;
  mailTestSubject: string;
  mailTestMatches: MailboxTestMatch[];
  mailTestGeminiRequest: MailboxTestGeminiRequest | null;
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
}

export const Dashboard = (props: DashboardProps) => {
  const navigate = useNavigate();
  const page = props.page ?? 'automation';
  const content = page === 'automation'
    ? <AutomationPage {...props} />
    : page === 'connections'
      ? <ConnectionsPage {...props} />
      : page === 'rules'
        ? <RulesPage {...props} />
      : page === 'tasks' ? <TasksPage {...props} /> : <MailboxTestPage {...props} />;
  const requiresGoogleReauthentication = needsGoogleReauthentication(props.error)
    || props.automation?.status === 'reauthentication_required';
  const recoveryMessage = props.error || 'Automation Inbox の認証が失効しています。Google に再接続してください。';
  return <div className="app-shell">
    <header className="app-topbar">
      <div className="app-brand"><span><Mail size={20} /></span><strong>Mail Automation</strong></div>
      {props.organizations && props.organizationId && <label className="organization-picker"><span className="sr-only">Organization</span><select aria-label="Organization" value={props.organizationId} onChange={(event) => navigate(`/organizations/${encodeURIComponent(event.target.value)}/automation`)}>{props.organizations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.name}</option>)}</select></label>}
      <nav aria-label="メインナビゲーション">
        <NavLink to="../automation" className={({ isActive }) => isActive ? 'active' : ''}><Play size={16} />自動化</NavLink>
        <NavLink to="../connections" className={({ isActive }) => isActive ? 'active' : ''}><Settings size={16} />接続設定</NavLink>
        <NavLink to="../rules" className={({ isActive }) => isActive ? 'active' : ''}><SlidersHorizontal size={16} />ルール</NavLink>
        <NavLink to="../tasks" className={({ isActive }) => isActive ? 'active' : ''}><CheckSquare size={16} />タスク</NavLink>
        <NavLink to="../mailbox-test" className={({ isActive }) => isActive ? 'active' : ''}><SlidersHorizontal size={16} />メールテスト</NavLink>
      </nav>
      <button className="topbar-logout" onClick={props.onLogout} disabled={props.busy}><LogOut size={16} />ログアウト</button>
    </header>
    <main className="app-content">
      {(props.error || requiresGoogleReauthentication) && <div className="dashboard-error"><p><CircleAlert size={17} />{recoveryMessage}</p>{requiresGoogleReauthentication && <GoogleReauthenticationAction onClick={props.onReauthenticate} />}</div>}
      {content}
    </main>
  </div>;
};

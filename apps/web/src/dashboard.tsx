import { CircleAlert, LogOut, Mail, Play, Settings, SlidersHorizontal } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';

import type { AutomationStatus, AutomationSummary, MailboxTestGeminiRequest, MailboxTestMatch, MailboxTestPreview, OrganizationConnections, OrganizationMembership, OrganizationRule, OrganizationRuleInput } from './api';
import { AutomationPage, ConnectionsPage, MailboxTestPage, RulesPage } from './dashboard-pages';

export type Page = 'automation' | 'connections' | 'rules' | 'mail-test';

export interface DashboardProps {
  page?: Page;
  automation: AutomationStatus | null;
  summary: AutomationSummary | null;
  busy: boolean;
  error: string;
  onRun: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onLogout: () => void;
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
  mailTestCreatedEventId: string;
  onMailTestSubjectChange: (value: string) => void;
  onSearchMailbox: () => void;
  onPrepareMailbox: (messageId: string) => void;
  onPreviewMailbox: (messageId: string) => void;
  onCreateCalendarEvent: () => void;
  organizationRules: OrganizationRule[];
  ruleBusy: boolean;
  onCreateRule: (input: OrganizationRuleInput) => Promise<void>;
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
        : <MailboxTestPage {...props} />;
  return <div className="app-shell">
    <header className="app-topbar">
      <div className="app-brand"><span><Mail size={20} /></span><strong>Mail Automation</strong></div>
      {props.organizations && props.organizationId && <label className="organization-picker"><span className="sr-only">Organization</span><select aria-label="Organization" value={props.organizationId} onChange={(event) => navigate(`/organizations/${encodeURIComponent(event.target.value)}/automation`)}>{props.organizations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.name}</option>)}</select></label>}
      <nav aria-label="メインナビゲーション">
        <NavLink to="../automation" className={({ isActive }) => isActive ? 'active' : ''}><Play size={16} />自動化</NavLink>
        <NavLink to="../connections" className={({ isActive }) => isActive ? 'active' : ''}><Settings size={16} />接続設定</NavLink>
        <NavLink to="../rules" className={({ isActive }) => isActive ? 'active' : ''}><SlidersHorizontal size={16} />ルール</NavLink>
        <NavLink to="../mailbox-test" className={({ isActive }) => isActive ? 'active' : ''}><SlidersHorizontal size={16} />メールテスト</NavLink>
      </nav>
      <button className="topbar-logout" onClick={props.onLogout} disabled={props.busy}><LogOut size={16} />ログアウト</button>
    </header>
    <main className="app-content">
      {props.error && <p className="dashboard-error"><CircleAlert size={17} />{props.error}</p>}
      {content}
    </main>
  </div>;
};

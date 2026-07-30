import { RefreshCw } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { isRouteErrorResponse, NavLink, Outlet, useLoaderData, useNavigate, useRevalidator, useRouteError, useSearchParams } from 'react-router-dom';

import type { AppState } from '@mail/domain';

import { api } from './api';
import type { AutomationStatus, AutomationSummary, AuthMe, DeliveryAuditRecord, MailboxTestAiRequest, MailboxTestMatch, MailboxTestPreview, OrganizationConnections, OrganizationDashboard, OrganizationLineDestination, OrganizationMembership, OrganizationRecipient, OrganizationRecipientInput, OrganizationRule, OrganizationRuleInput, OrganizationTask, TaskRoleConfiguration } from './api';
import { defaultOrganizationName, setupPhaseLabel, SignedOutEntry } from './entry';
import { Dashboard } from './dashboard';

export const DEFAULT_MAIL_TEST_SUBJECT = '名古屋名城RAC30周年記念式典のご案内';

export const OAuthError = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryError = searchParams.get('error') ?? '';
  const [error, setError] = useState(queryError);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!queryError) return;
    setError(queryError);
    setSearchParams({}, { replace: true });
  }, [queryError, setSearchParams]);
  const begin = async (intent: 'login' | 'organization_setup') => {
    setBusy(true); setError('');
    try { window.location.assign((await api.beginGoogleEntry(intent)).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google 認可を開始できませんでした。'); setBusy(false); }
  };
  return <SignedOutEntry busy={busy} error={error} onSelect={(intent) => void begin(intent)} />;
};

const SetupCard = ({ children }: { children: React.ReactNode }) => <main className="setup-shell"><section className="setup-card login-card">{children}</section></main>;

export const SetupRoute = () => {
  const state = useLoaderData() as AppState;
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const logout = async () => {
    setBusy(true);
    try { await api.logout(); navigate('/', { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'ログアウトできませんでした。'); setBusy(false); }
  };
  if (state.kind !== 'unassigned') return null;
  const begin = async () => {
    setBusy(true); setError('');
    try { window.location.assign((await api.beginGoogleEntry('organization_setup')).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google 認可を開始できませんでした。'); setBusy(false); }
  };
  return <SetupCard>
    <div className="setup-brand"><strong>Mail Automation</strong><small>CREATE ORGANIZATION</small></div>
    <p className="eyebrow">NO ORGANIZATION</p><h1>Organizationをセットアップ</h1>
    <p className="setup-copy">Automation Inboxを認可すると、このGoogleアカウントを初期OwnerとしてOrganization DBを作成します。</p>
    {error && <p className="setup-error">{error}</p>}
    <button className="primary" onClick={() => void begin()} disabled={busy}>{busy ? 'Googleへ接続中…' : 'Automation Inboxを認可する'}</button>
    <button className="quiet-button" onClick={() => void logout()} disabled={busy}>ログアウト</button>
  </SetupCard>;
};

export const SetupConfirmRoute = () => {
  const state = useLoaderData() as AppState;
  const navigate = useNavigate();
  const [name, setName] = useState(state.kind === 'confirming_organization' ? state.setup.name : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (state.kind !== 'confirming_organization') return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.confirmOnboarding(name); navigate('/setup/provisioning', { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '組織の作成を開始できませんでした。'); setBusy(false); }
  };
  return <SetupCard><form className="setup-form" onSubmit={(event) => void submit(event)}>
    {error && <p className="setup-error">{error}</p>}
    <p className="eyebrow">CONFIRM ORGANIZATION</p><h1>組織名を確認</h1>
    <p className="setup-copy">認可したGoogleアカウントをAutomation Inboxと初期Ownerにします。</p>
    <label>組織名<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="organization" required /></label>
    <button className="primary" disabled={busy}>{busy ? '組織DBを作成中…' : 'この名前で組織を作成する'}</button>
  </form></SetupCard>;
};

export const SetupProgressRoute = ({ failed }: { failed: boolean }) => {
  const state = useLoaderData() as AppState;
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (failed || state.kind !== 'provisioning') return undefined;
    const timer = window.setInterval(() => revalidator.revalidate(), 5_000);
    return () => window.clearInterval(timer);
  }, [failed, revalidator, state.kind]);
  if (failed && state.kind !== 'provisioning_failed') return null;
  if (!failed && state.kind !== 'provisioning') return null;
  const retry = async () => {
    setBusy(true); setError('');
    try { await api.retryOnboarding(); navigate('/setup/provisioning', { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '組織DBの作成を再試行できませんでした。'); setBusy(false); }
  };
  const restart = async () => {
    setBusy(true); setError('');
    try { await api.cancelOnboarding(); navigate('/setup', { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '組織セットアップをやり直せませんでした。'); setBusy(false); }
  };
  if (failed && state.kind === 'provisioning_failed') return <SetupCard>
    <p className="eyebrow">FAILED PHASE</p><h1>組織DBを準備できませんでした</h1>
    <p className="setup-copy">{setupPhaseLabel(state.phase)}</p>
    <p className="setup-error">{state.error ?? '組織DBの作成に失敗しました。'}{error && ` ${error}`}</p>
    <button className="primary" onClick={() => void retry()} disabled={busy}>{busy ? '再試行中…' : 'この段階から再試行する'}</button>
    <button className="quiet-button" onClick={() => void restart()} disabled={busy}>最初からやり直す</button>
  </SetupCard>;
  if (!failed && state.kind === 'provisioning') return <SetupCard>
    <p className="eyebrow">PROVISIONING</p><h1>組織を準備しています</h1>
    <p className="setup-copy">{setupPhaseLabel(state.phase)}</p>
    <div className="loading"><RefreshCw className="spin" size={18} />状態を確認中…</div>
  </SetupCard>;
  return null;
};

export interface OrganizationRouteData {
  state: Extract<AppState, { kind: 'ready' }>;
  organization: OrganizationMembership;
  automation: AutomationStatus | null;
  connections: OrganizationConnections;
  dashboard: OrganizationDashboard;
  rules: OrganizationRule[];
  audit: DeliveryAuditRecord[];
  tasks: OrganizationTask[];
  taskRoles: TaskRoleConfiguration;
  recipients: OrganizationRecipient[];
  lineDestinations: OrganizationLineDestination[];
}

export const loadOrganization = async (organizationId: string): Promise<OrganizationRouteData> => {
  const state = await api.bootstrap();
  if (state.kind !== 'ready') throw new Response('Organization is not ready', { status: 409 });
  const organization = state.organizations.find((value) => value.organizationId === organizationId);
  if (!organization) throw new Response('Organization was not found', { status: 404 });
  const [automation, connections, dashboard, rules, audit, tasks, taskRoles, recipients, lineDestinations] = await Promise.all([
    api.currentAutomation(organizationId),
    api.organizationConnections(organizationId),
    api.organizationDashboard(organizationId),
    api.organizationRules(organizationId),
    api.organizationDeliveryAudit(organizationId),
    api.organizationTasks(organizationId),
    api.organizationTaskRoles(organizationId),
    api.organizationRecipients(organizationId),
    api.organizationLineDestinations(organizationId),
  ]);
  return { state, organization, automation, connections, dashboard, rules, audit, tasks, taskRoles, recipients, lineDestinations };
};

interface OrganizationContextValue extends OrganizationRouteData {
  busy: boolean;
  error: string;
  summary: AutomationSummary | null;
  setEnabled: (enabled: boolean) => void;
  run: () => void;
  saveConnections: () => void;
  testAi: () => void;
  searchMailbox: () => void;
  prepareMailbox: (messageId: string) => void;
  previewMailbox: (messageId: string) => void;
  createCalendarEvent: () => void;
  createRule: (input: OrganizationRuleInput) => Promise<void>;
  updateTask: (taskId: string, input: { completed?: boolean; remarks?: string }) => void;
  assignTaskRole: (role: 'organizer' | 'treasurer', identityId: string) => void;
  createRecipient: (input: OrganizationRecipientInput) => Promise<void>;
  updateRecipient: (recipientId: string, input: Partial<Pick<OrganizationRecipient, 'name' | 'email' | 'tags' | 'state'>>) => Promise<void>;
  refreshRecipients: () => void;
  lineChannelAccessToken: string;
  lineChannelSecret: string;
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  aiTestPrompt: string;
  aiTestResult: string;
  aiTestBusy: boolean;
  mailTestSubject: string;
  mailTestMatches: MailboxTestMatch[];
  mailTestAiRequest: MailboxTestAiRequest | null;
  mailTestPreview: MailboxTestPreview | null;
  mailTestBusy: boolean;
  mailTestCreatedEventIds: string[];
  settingsBusy: boolean;
  ruleBusy: boolean;
  memberBusy: boolean;
  setLineChannelAccessToken: (value: string) => void;
  setLineChannelSecret: (value: string) => void;
  setAiApiKey: (value: string) => void;
  setAiModel: (value: string) => void;
  setAiBaseUrl: (value: string) => void;
  setAiTestPrompt: (value: string) => void;
  setMailTestSubject: (value: string) => void;
  logout: () => void;
  reauthenticate: () => void;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);
const useOrganization = (): OrganizationContextValue => {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error('Organization route context is unavailable.');
  return value;
};

export const OrganizationLayout = () => {
  const initial = useLoaderData() as OrganizationRouteData;
  const navigate = useNavigate();
  const [data, setData] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const [lineChannelAccessToken, setLineChannelAccessToken] = useState('');
  const [lineChannelSecret, setLineChannelSecret] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState(data.connections.ai.model);
  const [aiBaseUrl, setAiBaseUrl] = useState(data.connections.ai.baseUrl);
  const [aiTestPrompt, setAiTestPrompt] = useState('日本の首都を一文で教えてください。');
  const [aiTestResult, setAiTestResult] = useState('');
  const [aiTestBusy, setAiTestBusy] = useState(false);
  const [mailTestSubject, setMailTestSubject] = useState(DEFAULT_MAIL_TEST_SUBJECT);
  const [mailTestMatches, setMailTestMatches] = useState<MailboxTestMatch[]>([]);
  const [mailTestAiRequest, setMailTestAiRequest] = useState<MailboxTestAiRequest | null>(null);
  const [mailTestPreview, setMailTestPreview] = useState<MailboxTestPreview | null>(null);
  const [mailTestBusy, setMailTestBusy] = useState(false);
  const [mailTestCreatedEventIds, setMailTestCreatedEventIds] = useState<string[]>([]);

  useEffect(() => {
    setData(initial);
    setAiModel(initial.connections.ai.model);
    setAiBaseUrl(initial.connections.ai.baseUrl);
    setLineChannelAccessToken('');
    setLineChannelSecret('');
    setAiApiKey('');
    setSummary(null);
  }, [initial]);

  const withError = async (work: () => Promise<void>, setBusyState: (busy: boolean) => void): Promise<void> => {
    setBusyState(true); setError('');
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作に失敗しました。'); }
    finally { setBusyState(false); }
  };
  const run = () => void withError(async () => { const value = await api.runAutomation(data.organization.organizationId); const automation = await api.currentAutomation(data.organization.organizationId); setSummary(value); setData((current) => ({ ...current, automation })); }, setBusy);
  const setEnabled = (enabled: boolean) => void withError(async () => { await api.setEnabled(data.organization.organizationId, enabled); const automation = await api.currentAutomation(data.organization.organizationId); setData((current) => ({ ...current, automation })); }, setBusy);
  const saveConnections = () => void withError(async () => {
    const connections = await api.saveOrganizationConnections(data.organization.organizationId, { line: { channelAccessToken: lineChannelAccessToken || undefined, channelSecret: lineChannelSecret || undefined }, ai: { apiKey: aiApiKey || undefined, model: aiModel, baseUrl: aiBaseUrl } });
    setData((current) => ({ ...current, connections })); setLineChannelAccessToken(''); setLineChannelSecret(''); setAiApiKey('');
  }, setSettingsBusy);
  const testAi = () => void withError(async () => { const result = await api.testAiConnection(data.organization.organizationId, aiTestPrompt); setAiTestResult(result.text); }, setAiTestBusy);
  const searchMailbox = () => void withError(async () => { setMailTestAiRequest(null); setMailTestPreview(null); setMailTestCreatedEventIds([]); setMailTestMatches((await api.searchMailboxForTest(data.organization.organizationId, mailTestSubject.trim())).messages); }, setMailTestBusy);
  const prepareMailbox = (messageId: string) => void withError(async () => { setMailTestAiRequest(await api.prepareMailboxTestAiRequest(data.organization.organizationId, messageId)); setMailTestPreview(null); setMailTestCreatedEventIds([]); }, setMailTestBusy);
  const previewMailbox = (messageId: string) => void withError(async () => {
    if (mailTestAiRequest?.id !== messageId) throw new Error('先に AI への送信内容を確認してください。');
    setMailTestPreview(await api.previewMailboxTestEvent(data.organization.organizationId, messageId));
    setMailTestCreatedEventIds([]);
  }, setMailTestBusy);
  const createCalendarEvent = () => void withError(async () => { if (mailTestPreview) setMailTestCreatedEventIds((await api.createMailboxTestCalendarEvent(data.organization.organizationId, mailTestPreview.confirmationToken)).eventIds); }, setMailTestBusy);
  const createRule = async (input: OrganizationRuleInput): Promise<void> => withError(async () => { const rule = await api.createOrganizationRule(data.organization.organizationId, input); setData((current) => ({ ...current, rules: [...current.rules, rule] })); }, setRuleBusy);
  const updateTask = (taskId: string, input: { completed?: boolean; remarks?: string }) => void withError(async () => {
    const task = await api.updateOrganizationTask(data.organization.organizationId, taskId, input);
    setData((current) => ({ ...current, tasks: current.tasks.map((currentTask) => currentTask.id === task.id ? task : currentTask) }));
  }, setBusy);
  const assignTaskRole = (role: 'organizer' | 'treasurer', identityId: string) => void withError(async () => {
    const assignment = await api.assignOrganizationTaskRole(data.organization.organizationId, role, identityId);
    setData((current) => ({ ...current, taskRoles: { ...current.taskRoles, assignments: [...current.taskRoles.assignments.filter((currentAssignment) => currentAssignment.role !== role), assignment] } }));
  }, setBusy);
  const reloadRecipients = async (): Promise<void> => {
    const [recipients, lineDestinations] = await Promise.all([
      api.organizationRecipients(data.organization.organizationId),
      api.organizationLineDestinations(data.organization.organizationId),
    ]);
    setData((current) => ({ ...current, recipients, lineDestinations }));
  };
  const createRecipient = async (input: OrganizationRecipientInput): Promise<void> =>
    withError(async () => {
      await api.createOrganizationRecipient(data.organization.organizationId, input);
      await reloadRecipients();
    }, setMemberBusy);
  const updateRecipient = async (
    recipientId: string,
    input: Partial<Pick<OrganizationRecipient, 'name' | 'email' | 'tags' | 'state'>>,
  ): Promise<void> => withError(async () => {
    await api.updateOrganizationRecipient(data.organization.organizationId, recipientId, input);
    await reloadRecipients();
  }, setMemberBusy);
  const refreshRecipients = () => void withError(reloadRecipients, setMemberBusy);
  const logout = () => void withError(async () => { await api.logout(); navigate('/', { replace: true }); }, setBusy);
  const reauthenticate = () => void withError(async () => { window.location.assign((await api.reauthorizeAutomationInbox(data.organization.organizationId)).authorizationUrl); }, setBusy);
  const value: OrganizationContextValue = { ...data, busy, error, summary, setEnabled, run, saveConnections, testAi, searchMailbox, prepareMailbox, previewMailbox, createCalendarEvent, createRule, updateTask, assignTaskRole, createRecipient, updateRecipient, refreshRecipients, lineChannelAccessToken, lineChannelSecret, aiApiKey, aiModel, aiBaseUrl, aiTestPrompt, aiTestResult, aiTestBusy, mailTestSubject, mailTestMatches, mailTestAiRequest, mailTestPreview, mailTestBusy, mailTestCreatedEventIds, settingsBusy, ruleBusy, memberBusy, setLineChannelAccessToken, setLineChannelSecret, setAiApiKey, setAiModel, setAiBaseUrl, setAiTestPrompt, setMailTestSubject, logout, reauthenticate };
  return <OrganizationContext.Provider value={value}><Outlet /></OrganizationContext.Provider>;
};

type OrganizationPage = 'automation' | 'connections' | 'rules' | 'members' | 'mail-test' | 'tasks';
export const OrganizationPage = ({ page }: { page: OrganizationPage }) => {
  const value = useOrganization();
  const auth: AuthMe = { email: value.state.identity.email, displayName: value.state.identity.displayName, organizations: value.state.organizations };
  return <Dashboard
    page={page}
    automation={value.automation}
    summary={value.summary}
    busy={value.busy}
    error={value.error}
    onRun={value.run}
    onSetEnabled={value.setEnabled}
    onLogout={value.logout}
    onReauthenticate={value.reauthenticate}
    organization={value.organization}
    organizationId={value.organization.organizationId}
    organizations={auth.organizations}
    canManage={value.organization.role === 'owner' || value.organization.role === 'admin'}
    connections={value.connections}
    lineChannelAccessToken={value.lineChannelAccessToken}
    lineChannelSecret={value.lineChannelSecret}
    aiApiKey={value.aiApiKey}
    aiModel={value.aiModel}
    aiBaseUrl={value.aiBaseUrl}
    onLineChannelAccessTokenChange={value.setLineChannelAccessToken}
    onLineChannelSecretChange={value.setLineChannelSecret}
    onAiApiKeyChange={value.setAiApiKey}
    onAiModelChange={value.setAiModel}
    onAiBaseUrlChange={value.setAiBaseUrl}
    settingsBusy={value.settingsBusy}
    onSaveConnections={value.saveConnections}
    aiTestPrompt={value.aiTestPrompt}
    aiTestResult={value.aiTestResult}
    aiTestBusy={value.aiTestBusy}
    onAiTestPromptChange={value.setAiTestPrompt}
    onTestAi={value.testAi}
    mailTestSubject={value.mailTestSubject}
    mailTestMatches={value.mailTestMatches}
    mailTestAiRequest={value.mailTestAiRequest}
    mailTestPreview={value.mailTestPreview}
    mailTestBusy={value.mailTestBusy}
    mailTestCreatedEventIds={value.mailTestCreatedEventIds}
    onMailTestSubjectChange={value.setMailTestSubject}
    onSearchMailbox={value.searchMailbox}
    onPrepareMailbox={value.prepareMailbox}
    onPreviewMailbox={value.previewMailbox}
    onCreateCalendarEvent={value.createCalendarEvent}
    organizationRules={value.rules}
    ruleBusy={value.ruleBusy}
    onCreateRule={value.createRule}
    organizationTasks={value.tasks}
    onUpdateTask={value.updateTask}
    taskRoleAssignments={value.taskRoles.assignments}
    taskMembers={value.taskRoles.members}
    onAssignTaskRole={value.assignTaskRole}
    organizationRecipients={value.recipients}
    lineDestinations={value.lineDestinations}
    memberBusy={value.memberBusy}
    onCreateRecipient={value.createRecipient}
    onUpdateRecipient={value.updateRecipient}
    onRefreshRecipients={value.refreshRecipients}
  />;
};

export const NotFoundRoute = () => <SetupCard><p className="eyebrow">404</p><h1>ページが見つかりません</h1><p className="setup-copy">このURLには対応する画面がありません。</p><NavLink className="primary" to="/">入口へ戻る</NavLink></SetupCard>;

type Logout = () => Promise<{ loggedOut: boolean }>;
type EntryNavigation = (to: string, options: { replace: true }) => void;

export const logoutFromRouteError = async (
  logout: Logout,
  navigate: EntryNavigation,
): Promise<void> => {
  await logout();
  navigate('/', { replace: true });
};

export const RouteError = ({ logout = api.logout }: { logout?: Logout }) => {
  const error = useRouteError();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const message = isRouteErrorResponse(error) ? error.status === 404 ? 'Organizationまたはページが見つかりません。' : error.statusText : error instanceof Error ? error.message : '画面を表示できませんでした。';
  const leave = async () => {
    setBusy(true);
    setLogoutError('');
    try {
      await logoutFromRouteError(logout, navigate);
    } catch (cause) {
      setLogoutError(cause instanceof Error ? cause.message : 'ログアウトできませんでした。');
      setBusy(false);
    }
  };
  return <SetupCard>
    <p className="eyebrow">ROUTE ERROR</p>
    <h1>画面を表示できません</h1>
    <p className="setup-error">{message}</p>
    {logoutError && <p className="setup-error">{logoutError}</p>}
    <button className="primary" type="button" onClick={() => void leave()} disabled={busy}>
      {busy ? 'ログアウト中…' : 'ログアウトして入口へ戻る'}
    </button>
  </SetupCard>;
};

export const LoadingRoute = () => <SetupCard><div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div></SetupCard>;

export const organizationDefaultName = (state: Extract<AppState, { kind: 'ready' }>): string => defaultOrganizationName({ email: state.identity.email, displayName: state.identity.displayName, organizations: state.organizations });

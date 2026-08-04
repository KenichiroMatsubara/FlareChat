import { RefreshCw } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { isRouteErrorResponse, NavLink, Outlet, useLoaderData, useNavigate, useParams, useRevalidator, useRouteError, useSearchParams } from 'react-router-dom';

import type { AppState } from '@mail/domain';

import { api } from './api';
import type { MemberAttendanceStatus, MemberPortal, AgentRunIndex, AgentRunTranscript, AutomationStatus, AutomationSummary, AuthMe, DeliveryAuditRecord, MailboxTestAiRequest, MailboxTestMatch, MailboxTestPreview, OrganizationAgentRule, OrganizationConnections, OrganizationDashboard, OrganizationLineDestination, OrganizationMembership, OrganizationPrompt, OrganizationMember, OrganizationMemberInput, OrganizationRule, OrganizationRuleInput, OrganizationTask, OrganizationTypedList, PresetSummary, ProposedAction, MemberLineDestinationInput, TaskRoleConfiguration } from './api';
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

export const PresetSetupChoice = ({ presets, selectedId, onChange }: {
  presets: PresetSummary[];
  selectedId: string;
  onChange: (presetId: string) => void;
}) => <fieldset className="preset-choice">
  <legend>Preset</legend>
  {presets.map((preset) => <label key={preset.id}>
    <input
      type="checkbox"
      checked={selectedId === preset.id}
      onChange={(event) => onChange(event.target.checked ? preset.id : '')}
    />
    <span><strong>{preset.name}</strong><small>{preset.description}</small></span>
  </label>)}
  <p>選択した構成をOrganization作成時にコピーします。後の製品更新とはリンクされません。</p>
</fieldset>;

export const SetupConfirmRoute = () => {
  const state = useLoaderData() as AppState;
  const navigate = useNavigate();
  const [name, setName] = useState(state.kind === 'confirming_organization' ? state.setup.name : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [presetId, setPresetId] = useState('');
  useEffect(() => {
    void api.presets().then(setPresets).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Presetを読み込めませんでした。');
    });
  }, []);
  if (state.kind !== 'confirming_organization') return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.confirmOnboarding(name, presetId || undefined); navigate('/setup/provisioning', { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '組織の作成を開始できませんでした。'); setBusy(false); }
  };
  return <SetupCard><form className="setup-form" onSubmit={(event) => void submit(event)}>
    {error && <p className="setup-error">{error}</p>}
    <p className="eyebrow">CONFIRM ORGANIZATION</p><h1>組織名を確認</h1>
    <p className="setup-copy">認可したGoogleアカウントをAutomation Inboxと初期Ownerにします。</p>
    <label>組織名<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="organization" required /></label>
    <PresetSetupChoice presets={presets} selectedId={presetId} onChange={setPresetId} />
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
  prompts: OrganizationPrompt[];
  agentRules: OrganizationAgentRule[];
  agentRuns: AgentRunIndex[];
  lists: OrganizationTypedList[];
  audit: DeliveryAuditRecord[];
  tasks: OrganizationTask[];
  taskRoles: TaskRoleConfiguration;
  members: OrganizationMember[];
  lineDestinations: OrganizationLineDestination[];
  presets: PresetSummary[];
  attachmentFolder: { path: string };
}

export const loadOrganization = async (organizationId: string): Promise<OrganizationRouteData> => {
  const state = await api.bootstrap();
  if (state.kind !== 'ready') throw new Response('Organization is not ready', { status: 409 });
  const organization = state.organizations.find((value) => value.organizationId === organizationId);
  if (!organization) throw new Response('Organization was not found', { status: 404 });
  const [automation, connections, dashboard, rules, prompts, agentRules, agentRuns, lists, audit, tasks, taskRoles, members, lineDestinations, presets, attachmentFolder] = await Promise.all([
    api.currentAutomation(organizationId),
    api.organizationConnections(organizationId),
    api.organizationDashboard(organizationId),
    api.organizationRules(organizationId),
    api.organizationPrompts(organizationId),
    api.organizationAgentRules(organizationId),
    api.organizationAgentRuns(organizationId),
    api.organizationLists(organizationId),
    api.organizationDeliveryAudit(organizationId),
    api.organizationTasks(organizationId),
    api.organizationTaskRoles(organizationId),
    api.organizationMembers(organizationId),
    api.organizationLineDestinations(organizationId),
    api.presets(),
    api.organizationAttachmentFolder(organizationId),
  ]);
  return { state, organization, automation, connections, dashboard, rules, prompts, agentRules, agentRuns, lists, audit, tasks, taskRoles, members, lineDestinations, presets, attachmentFolder };
};

interface OrganizationContextValue extends OrganizationRouteData {
  busy: boolean;
  error: string;
  summary: AutomationSummary | null;
  setEnabled: (enabled: boolean) => void;
  run: () => void;
  saveLineConnection: () => void;
  saveAiConnection: () => void;
  testAi: () => void;
  searchMailbox: () => void;
  prepareMailbox: (messageId: string) => void;
  previewMailbox: (messageId: string) => void;
  createCalendarEvent: () => void;
  createRule: (input: OrganizationRuleInput) => Promise<void>;
  updateRule: (ruleId: string, input: Pick<OrganizationRuleInput, 'permittedRecipientListIds' | 'permittedLineListIds'>) => Promise<void>;
  agentTranscript: AgentRunTranscript | null;
  proposedActions: ProposedAction[];
  createPrompt: (input: { name: string; instructions: string }) => Promise<void>;
  updatePrompt: (promptId: string, input: { name?: string; instructions?: string }) => Promise<void>;
  deletePrompt: (promptId: string) => Promise<void>;
  createAgentRule: (input: { name: string; promptId: string; state: 'active' | 'suspended'; executionMode?: 'read_only' | 'approval' | 'unattended'; selectionPolicy: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[]; priority?: number }) => Promise<void>;
  updateAgentRule: (agentRuleId: string, input: { state?: 'active' | 'suspended' | 'archived'; executionMode?: 'read_only' | 'approval' | 'unattended'; permittedRecipientListIds?: string[]; permittedLineListIds?: string[] }) => Promise<void>;
  loadAgentTranscript: (runId: string) => void;
  decideProposedAction: (actionId: string, decision: 'approve' | 'reject') => void;
  decideProposedActionBatch: (runId: string, decision: 'approve' | 'reject') => void;
  updateTask: (taskId: string, input: { completed?: boolean; remarks?: string }) => void;
  createTaskRole: (input: { displayName: string; description: string }) => Promise<void>;
  updateTaskRole: (roleId: string, input: { displayName?: string; description?: string }) => Promise<void>;
  deleteTaskRole: (roleId: string) => Promise<void>;
  assignTaskRole: (roleId: string, memberId: string) => void;
  createMember: (input: OrganizationMemberInput) => Promise<OrganizationMember | null>;
  updateMember: (memberId: string, input: Partial<Pick<OrganizationMember, 'name' | 'email' | 'tags' | 'state'>>) => Promise<void>;
  setLineDestination: (memberId: string, input: MemberLineDestinationInput) => Promise<void>;
  unlinkLineDestination: (memberId: string, lineDestinationId: string) => Promise<void>;
  registerLineDestination: (input: MemberLineDestinationInput) => Promise<void>;
  removeLineDestination: (lineDestinationId: string) => Promise<void>;
  refreshMembers: () => void;
  applyPreset: (presetId: string, conflictPolicy?: 'duplicate') => void;
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
  lineSettingsBusy: boolean;
  aiSettingsBusy: boolean;
  attachmentFolderPath: string;
  setAttachmentFolderPath: (value: string) => void;
  attachmentFolderBusy: boolean;
  saveAttachmentFolderPath: () => void;
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
  const [lineSettingsBusy, setLineSettingsBusy] = useState(false);
  const [aiSettingsBusy, setAiSettingsBusy] = useState(false);
  const [attachmentFolderBusy, setAttachmentFolderBusy] = useState(false);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const [lineChannelAccessToken, setLineChannelAccessToken] = useState('');
  const [lineChannelSecret, setLineChannelSecret] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState(data.connections.ai.model);
  const [aiBaseUrl, setAiBaseUrl] = useState(data.connections.ai.baseUrl);
  const [attachmentFolderPath, setAttachmentFolderPath] = useState(data.attachmentFolder.path);
  const [aiTestPrompt, setAiTestPrompt] = useState('日本の首都を一文で教えてください。');
  const [aiTestResult, setAiTestResult] = useState('');
  const [aiTestBusy, setAiTestBusy] = useState(false);
  const [mailTestSubject, setMailTestSubject] = useState(DEFAULT_MAIL_TEST_SUBJECT);
  const [mailTestMatches, setMailTestMatches] = useState<MailboxTestMatch[]>([]);
  const [mailTestAiRequest, setMailTestAiRequest] = useState<MailboxTestAiRequest | null>(null);
  const [mailTestPreview, setMailTestPreview] = useState<MailboxTestPreview | null>(null);
  const [mailTestBusy, setMailTestBusy] = useState(false);
  const [mailTestCreatedEventIds, setMailTestCreatedEventIds] = useState<string[]>([]);
  const [agentTranscript, setAgentTranscript] = useState<AgentRunTranscript | null>(null);
  const [proposedActions, setProposedActions] = useState<ProposedAction[]>([]);

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
  const saveLineConnection = () => void withError(async () => {
    const line = await api.saveOrganizationLineConnection(data.organization.organizationId, {
      channelAccessToken: lineChannelAccessToken || undefined,
      channelSecret: lineChannelSecret || undefined,
    });
    setData((current) => ({ ...current, connections: { ...current.connections, line } }));
    setLineChannelAccessToken('');
    setLineChannelSecret('');
  }, setLineSettingsBusy);
  const saveAiConnection = () => void withError(async () => {
    const ai = await api.saveOrganizationAiConnection(data.organization.organizationId, {
      apiKey: aiApiKey || undefined,
      model: aiModel,
      baseUrl: aiBaseUrl,
    });
    setData((current) => ({ ...current, connections: { ...current.connections, ai } }));
    setAiApiKey('');
  }, setAiSettingsBusy);
  const saveAttachmentFolderPath = () => void withError(async () => {
    const attachmentFolder = await api.saveOrganizationAttachmentFolder(data.organization.organizationId, attachmentFolderPath);
    setData((current) => ({ ...current, attachmentFolder }));
    setAttachmentFolderPath(attachmentFolder.path);
  }, setAttachmentFolderBusy);
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
  const updateRule = async (ruleId: string, input: Pick<OrganizationRuleInput, 'permittedRecipientListIds' | 'permittedLineListIds'>): Promise<void> => withError(async () => {
    const updated = await api.updateOrganizationRule(data.organization.organizationId, ruleId, input);
    setData((current) => ({ ...current, rules: current.rules.map((rule) => rule.id === ruleId ? { ...rule, ...updated } : rule) }));
  }, setRuleBusy);
  const createPrompt = async (input: { name: string; instructions: string }): Promise<void> => withError(async () => {
    const prompt = await api.createOrganizationPrompt(data.organization.organizationId, input);
    setData((current) => ({ ...current, prompts: [...current.prompts, prompt] }));
  }, setRuleBusy);
  const updatePrompt = async (promptId: string, input: { name?: string; instructions?: string }): Promise<void> => withError(async () => {
    const updated = await api.updateOrganizationPrompt(data.organization.organizationId, promptId, input);
    setData((current) => ({ ...current, prompts: current.prompts.map((prompt) => prompt.id === promptId ? { ...prompt, ...updated } : prompt) }));
  }, setRuleBusy);
  const deletePrompt = async (promptId: string): Promise<void> => withError(async () => {
    await api.removeOrganizationPrompt(data.organization.organizationId, promptId);
    setData((current) => ({ ...current, prompts: current.prompts.filter((prompt) => prompt.id !== promptId) }));
  }, setRuleBusy);
  const createAgentRule = async (input: { name: string; promptId: string; state: 'active' | 'suspended'; executionMode?: 'read_only' | 'approval' | 'unattended'; selectionPolicy: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[]; priority?: number }): Promise<void> => withError(async () => {
    const rule = await api.createOrganizationAgentRule(data.organization.organizationId, input);
    setData((current) => ({ ...current, agentRules: [...current.agentRules, rule] }));
  }, setRuleBusy);
  const updateAgentRule = async (agentRuleId: string, input: { state?: 'active' | 'suspended' | 'archived'; executionMode?: 'read_only' | 'approval' | 'unattended'; permittedRecipientListIds?: string[]; permittedLineListIds?: string[] }): Promise<void> => withError(async () => {
    const updated = await api.updateOrganizationAgentRule(data.organization.organizationId, agentRuleId, input);
    setData((current) => ({ ...current, agentRules: current.agentRules.map((rule) => rule.id === agentRuleId ? updated : rule) }));
  }, setRuleBusy);
  const loadAgentTranscript = (runId: string) => void withError(async () => {
    const [transcript, actions] = await Promise.all([api.agentRunTranscript(data.organization.organizationId, runId), api.agentProposedActions(data.organization.organizationId, runId)]);
    setAgentTranscript(transcript);
    setProposedActions(actions);
  }, setRuleBusy);
  const decideProposedAction = (actionId: string, decision: 'approve' | 'reject') => void withError(async () => {
    const decided = await api.decideProposedAction(data.organization.organizationId, actionId, decision);
    setProposedActions((current) => current.map((action) => action.id === actionId ? { ...action, ...decided } : action));
  }, setRuleBusy);
  const decideProposedActionBatch = (runId: string, decision: 'approve' | 'reject') => void withError(async () => {
    const decided = await api.decideProposedActionBatch(data.organization.organizationId, runId, decision);
    const byId = new Map(decided.map((action) => [action.id, action]));
    setProposedActions((current) => current.map((action) => byId.get(action.id) ?? action));
  }, setRuleBusy);
  const updateTask = (taskId: string, input: { completed?: boolean; remarks?: string }) => void withError(async () => {
    const task = await api.updateOrganizationTask(data.organization.organizationId, taskId, input);
    setData((current) => ({ ...current, tasks: current.tasks.map((currentTask) => currentTask.id === task.id ? task : currentTask) }));
  }, setBusy);
  const createTaskRole = async (input: { displayName: string; description: string }): Promise<void> => withError(async () => {
    const role = await api.createOrganizationTaskRole(data.organization.organizationId, input);
    setData((current) => ({ ...current, taskRoles: { ...current.taskRoles, roles: [...current.taskRoles.roles, role] } }));
  }, setBusy);
  const updateTaskRole = async (roleId: string, input: { displayName?: string; description?: string }): Promise<void> => withError(async () => {
    const role = await api.updateOrganizationTaskRole(data.organization.organizationId, roleId, input);
    setData((current) => ({ ...current, taskRoles: { ...current.taskRoles, roles: current.taskRoles.roles.map((item) => item.id === role.id ? role : item) } }));
  }, setBusy);
  const deleteTaskRole = async (roleId: string): Promise<void> => withError(async () => {
    await api.removeOrganizationTaskRole(data.organization.organizationId, roleId);
    setData((current) => ({ ...current, taskRoles: { ...current.taskRoles, roles: current.taskRoles.roles.filter((role) => role.id !== roleId), assignments: current.taskRoles.assignments.filter((assignment) => assignment.roleId !== roleId) } }));
  }, setBusy);
  const assignTaskRole = (roleId: string, memberId: string) => void withError(async () => {
    const assignment = await api.assignOrganizationTaskRole(data.organization.organizationId, roleId, memberId);
    setData((current) => ({ ...current, taskRoles: { ...current.taskRoles, assignments: [...current.taskRoles.assignments.filter((currentAssignment) => currentAssignment.roleId !== roleId), assignment] } }));
  }, setBusy);
  const reloadMembers = async (): Promise<void> => {
    const [members, lineDestinations] = await Promise.all([
      api.organizationMembers(data.organization.organizationId),
      api.organizationLineDestinations(data.organization.organizationId),
    ]);
    setData((current) => ({ ...current, members, lineDestinations }));
  };
  const createMember = async (input: OrganizationMemberInput): Promise<OrganizationMember | null> => {
    let created: OrganizationMember | null = null;
    await withError(async () => {
      created = await api.createOrganizationMember(data.organization.organizationId, input);
      await reloadMembers();
    }, setMemberBusy);
    return created;
  };
  const updateMember = async (
    memberId: string,
    input: Partial<Pick<OrganizationMember, 'name' | 'email' | 'tags' | 'state'>>,
  ): Promise<void> => withError(async () => {
    await api.updateOrganizationMember(data.organization.organizationId, memberId, input);
    await reloadMembers();
  }, setMemberBusy);
  const setLineDestination = async (memberId: string, input: MemberLineDestinationInput): Promise<void> =>
    withError(async () => {
      await api.setMemberLineDestination(data.organization.organizationId, memberId, input);
      await reloadMembers();
    }, setMemberBusy);
  const unlinkLineDestination = async (memberId: string, lineDestinationId: string): Promise<void> =>
    withError(async () => {
      await api.removeMemberLineDestination(data.organization.organizationId, memberId, lineDestinationId);
      await reloadMembers();
    }, setMemberBusy);
  const registerLineDestination = async (input: MemberLineDestinationInput): Promise<void> =>
    withError(async () => {
      await api.registerLineDestination(data.organization.organizationId, input);
      await reloadMembers();
    }, setMemberBusy);
  const removeLineDestination = async (lineDestinationId: string): Promise<void> =>
    withError(async () => {
      await api.removeLineDestination(data.organization.organizationId, lineDestinationId);
      await reloadMembers();
    }, setMemberBusy);
  const refreshMembers = () => void withError(reloadMembers, setMemberBusy);
  const applyPreset = (presetId: string, conflictPolicy?: 'duplicate') => void withError(async () => {
    await api.applyOrganizationPreset(data.organization.organizationId, presetId, conflictPolicy);
    const [rules, prompts, agentRules, lists, taskRoles] = await Promise.all([
      api.organizationRules(data.organization.organizationId),
      api.organizationPrompts(data.organization.organizationId),
      api.organizationAgentRules(data.organization.organizationId),
      api.organizationLists(data.organization.organizationId),
      api.organizationTaskRoles(data.organization.organizationId),
    ]);
    setData((current) => ({ ...current, rules, prompts, agentRules, lists, taskRoles }));
  }, setRuleBusy);
  const logout = () => void withError(async () => { await api.logout(); navigate('/', { replace: true }); }, setBusy);
  const reauthenticate = () => void withError(async () => { window.location.assign((await api.reauthorizeAutomationInbox(data.organization.organizationId)).authorizationUrl); }, setBusy);
  const value: OrganizationContextValue = { ...data, busy, error, summary, setEnabled, run, saveLineConnection, saveAiConnection, testAi, searchMailbox, prepareMailbox, previewMailbox, createCalendarEvent, createRule, updateRule, agentTranscript, proposedActions, createPrompt, updatePrompt, deletePrompt, createAgentRule, updateAgentRule, loadAgentTranscript, decideProposedAction, decideProposedActionBatch, updateTask, createTaskRole, updateTaskRole, deleteTaskRole, assignTaskRole, createMember, updateMember, setLineDestination, unlinkLineDestination, registerLineDestination, removeLineDestination, refreshMembers, applyPreset, lineChannelAccessToken, lineChannelSecret, aiApiKey, aiModel, aiBaseUrl, aiTestPrompt, aiTestResult, aiTestBusy, mailTestSubject, mailTestMatches, mailTestAiRequest, mailTestPreview, mailTestBusy, mailTestCreatedEventIds, lineSettingsBusy, aiSettingsBusy, ruleBusy, memberBusy, attachmentFolderPath, setAttachmentFolderPath, attachmentFolderBusy, saveAttachmentFolderPath, setLineChannelAccessToken, setLineChannelSecret, setAiApiKey, setAiModel, setAiBaseUrl, setAiTestPrompt, setMailTestSubject, logout, reauthenticate };
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
    lineSettingsBusy={value.lineSettingsBusy}
    aiSettingsBusy={value.aiSettingsBusy}
    onSaveLineConnection={value.saveLineConnection}
    onSaveAiConnection={value.saveAiConnection}
    attachmentFolderPath={value.attachmentFolderPath}
    savedAttachmentFolderPath={value.attachmentFolder.path}
    onAttachmentFolderPathChange={value.setAttachmentFolderPath}
    attachmentFolderBusy={value.attachmentFolderBusy}
    onSaveAttachmentFolderPath={value.saveAttachmentFolderPath}
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
    organizationLists={value.lists}
    ruleBusy={value.ruleBusy}
    onCreateRule={value.createRule}
    onUpdateRule={value.updateRule}
    prompts={value.prompts}
    agentRules={value.agentRules}
    agentRuns={value.agentRuns}
    agentTranscript={value.agentTranscript}
    proposedActions={value.proposedActions}
    onCreatePrompt={value.createPrompt}
    onUpdatePrompt={value.updatePrompt}
    onDeletePrompt={value.deletePrompt}
    onCreateAgentRule={value.createAgentRule}
    onUpdateAgentRule={value.updateAgentRule}
    onLoadAgentTranscript={value.loadAgentTranscript}
    onDecideProposedAction={value.decideProposedAction}
    onDecideProposedActionBatch={value.decideProposedActionBatch}
    organizationTasks={value.tasks}
    onUpdateTask={value.updateTask}
    taskRoles={value.taskRoles.roles}
    taskRoleAssignments={value.taskRoles.assignments}
    taskMembers={value.taskRoles.members}
    onCreateTaskRole={value.createTaskRole}
    onUpdateTaskRole={value.updateTaskRole}
    onDeleteTaskRole={value.deleteTaskRole}
    onAssignTaskRole={value.assignTaskRole}
    organizationMembers={value.members}
    lineDestinations={value.lineDestinations}
    memberBusy={value.memberBusy}
    onCreateMember={value.createMember}
    onUpdateMember={value.updateMember}
    onSetLineDestination={value.setLineDestination}
    onUnlinkLineDestination={value.unlinkLineDestination}
    onRegisterLineDestination={value.registerLineDestination}
    onRemoveLineDestination={value.removeLineDestination}
    onRefreshMembers={value.refreshMembers}
    presets={value.presets}
    onApplyPreset={value.applyPreset}
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
  const revalidator = useRevalidator();
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
    <button className="primary" type="button" onClick={() => revalidator.revalidate()} disabled={revalidator.state !== 'idle'}>
      {revalidator.state !== 'idle' ? '再試行中…' : '再試行'}
    </button>
    <button className="quiet-button" type="button" onClick={() => void leave()} disabled={busy}>
      {busy ? 'ログアウト中…' : 'ログアウトして入口へ戻る'}
    </button>
  </SetupCard>;
};

export const LoadingRoute = () => <SetupCard><div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div></SetupCard>;

export const organizationDefaultName = (state: Extract<AppState, { kind: 'ready' }>): string => defaultOrganizationName({ email: state.identity.email, displayName: state.identity.displayName, organizations: state.organizations });

/**
 * The single-use link that first brings a Member into the Member Portal. It is
 * the only entry: a Member reaches it through their linked LINE Destination,
 * signs in with the identity-only Google grant, and is bound to that account.
 */
export const MemberPortalJoinRoute = () => {
  const state = useLoaderData() as AppState;
  const parameters = useParams();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const organizationId = parameters.organizationId ?? '';
  const token = parameters.token ?? '';
  const signIn = async () => {
    setBusy(true); setError('');
    try { window.location.assign((await api.beginGoogleEntry('login')).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google 認可を開始できませんでした。'); setBusy(false); }
  };
  const join = async () => {
    setBusy(true); setError('');
    try {
      await api.joinMemberPortal(organizationId, token);
      navigate('/portal', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'このリンクは使用できませんでした。');
      setBusy(false);
    }
  };
  return <SetupCard>
    <div className="setup-brand"><strong>Mail Automation</strong><small>MEMBER PORTAL</small></div>
    <p className="eyebrow">JOIN</p><h1>メンバーページを開く</h1>
    {error && <p className="setup-error">{error}</p>}
    {state.kind === 'signed_out'
      ? <>
        <p className="setup-copy">Googleでログインすると、このリンクのメンバーとしてアカウントが結び付きます。以降はこのアカウントだけで入れます。</p>
        <button className="primary" onClick={() => void signIn()} disabled={busy}>{busy ? 'Googleへ接続中…' : 'Googleでログイン'}</button>
      </>
      : <>
        <p className="setup-copy">{state.identity.email} をこのメンバーに結び付けます。リンクは一度だけ使えます。</p>
        <button className="primary" onClick={() => void join()} disabled={busy}>{busy ? '確認中…' : 'このアカウントで開始する'}</button>
      </>}
  </SetupCard>;
};

const attendanceLabel: Record<MemberAttendanceStatus, string> = {
  unanswered: '未回答',
  attending: '出席',
  not_attending: '欠席',
};

/** The one signed-in page a Member has: attendance, comments, and their Tasks. */
export const MemberPortalRoute = () => {
  const [portal, setPortal] = useState<MemberPortal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reload = async (): Promise<void> => { setPortal(await api.memberPortal()); };
  useEffect(() => {
    void reload().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'メンバーページを開けませんでした。'));
  }, []);
  const withError = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('');
    try { await work(); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作に失敗しました。'); }
    finally { setBusy(false); }
  };
  if (!portal) return <SetupCard>{error ? <p className="setup-error">{error}</p> : <div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div>}</SetupCard>;
  return <main className="portal-shell">
    <header className="portal-header">
      <div><p className="eyebrow">{portal.organization.name}</p><h1>{portal.member.name} さんのページ</h1></div>
      <button className="quiet-button" onClick={() => void api.logout().then(() => window.location.assign('/'))}>ログアウト</button>
    </header>
    {error && <p className="setup-error">{error}</p>}
    <section className="portal-section">
      <h2>出欠登録</h2>
      {portal.events.length === 0 && <p className="portal-empty">登録が必要な予定はありません。</p>}
      {portal.events.map((event) => <article key={event.eventId} className="portal-event">
        <div><h3>{event.title}</h3><p>{event.startsAt}{event.location && ` ・ ${event.location}`}</p></div>
        {event.open
          ? <div className="portal-answer">
            {(['attending', 'not_attending'] as const).map((status) => <button
              key={status}
              type="button"
              className={event.status === status ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() => void withError(() => api.registerMemberAttendance(event.eventId, { status, comment: event.comment }).then(() => undefined))}
            >{attendanceLabel[status]}</button>)}
            <label>コメント<input
              defaultValue={event.comment}
              maxLength={1_000}
              onBlur={(change) => { if (change.target.value !== event.comment) void withError(() => api.registerMemberAttendance(event.eventId, { status: event.status, comment: change.target.value }).then(() => undefined)); }}
            /></label>
          </div>
          : <p className="portal-locked">回答期限を過ぎました（現在: {attendanceLabel[event.status]}）</p>}
      </article>)}
    </section>
    <section className="portal-section">
      <h2>タスク</h2>
      {portal.tasks.length === 0 && <p className="portal-empty">タスクはありません。</p>}
      {portal.tasks.map((task) => <article key={task.taskId} className={`portal-task ${task.mine ? 'mine' : ''}`}>
        <div>
          <h3>{task.title}</h3>
          <p>{task.assigneeRoleName} ・ {task.assigneeName} ・ 期限 {task.deadline}</p>
          <p className="portal-task-source">{task.sourceMessageSubject}</p>
        </div>
        {task.mine
          ? <div className="portal-answer">
            <label><input
              type="checkbox"
              checked={task.completed}
              disabled={busy}
              onChange={(change) => void withError(() => api.updateMemberTask(task.taskId, { completed: change.target.checked }).then(() => undefined))}
            />完了</label>
            <label>備考<input
              defaultValue={task.remarks}
              onBlur={(change) => { if (change.target.value !== task.remarks) void withError(() => api.updateMemberTask(task.taskId, { remarks: change.target.value }).then(() => undefined)); }}
            /></label>
          </div>
          : <p className="portal-locked">{task.completed ? '完了' : '未完了'}</p>}
      </article>)}
    </section>
  </main>;
};

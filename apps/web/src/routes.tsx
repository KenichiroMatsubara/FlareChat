import { RefreshCw } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { isRouteErrorResponse, NavLink, Outlet, useLoaderData, useNavigate, useNavigation, useParams, useRevalidator, useRouteError, useSearchParams } from 'react-router-dom';

import type { AppState } from '@mail/domain';

import { api } from './api';
import type { MemberAttendanceStatus, MemberPortal, AgentRunIndex, AgentRunTranscript, AutomationStatus, AutomationSummary, AuthMe, DeliveryAuditRecord, GuestRegistrationRoster, MailboxTestAiRequest, MailboxTestMatch, MailboxTestPreview, MailboxTestRefreshOutcome, MailboxTestRefreshPlan, MailboxTestRefreshRequest, OrganizationAgentRule, OrganizationConnections, OrganizationDashboard, OrganizationLineDestination, OrganizationMembership, OrganizationPrompt, OrganizationMember, OrganizationMemberInput, OrganizationRule, OrganizationRuleInput, OrganizationTask, OrganizationTypedList, PresetSummary, ProposedAction, MemberLineDestinationInput, TaskAssignmentProposal, TaskReassignmentReview, TaskRoleConfiguration } from './api';
import { defaultOrganizationName, setupPhaseLabel, SignedOutEntry } from './entry';
import { pendingKey, usePendingOperations, type PendingOperations } from './pending';
import { PendingOverlay } from './progress';
import { Dashboard } from './dashboard';

export const DEFAULT_MAIL_TEST_SUBJECT = '名古屋名城RAC30周年記念式典のご案内';

/**
 * A route loader can run several API calls in parallel (e.g. switching
 * Organization) while the previous page stays on screen, so without this bar
 * that wait looks indistinguishable from the app being stuck.
 */
export const NavigationProgress = () => {
  const navigation = useNavigation();
  const active = navigation.state !== 'idle';
  return <div className={active ? 'nav-progress active' : 'nav-progress'} role="progressbar" aria-hidden={!active}>
    {active && <span className="sr-only">読み込み中…</span>}
  </div>;
};

export const RootLayout = () => <><NavigationProgress /><Outlet /></>;

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
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetId, setPresetId] = useState('');
  useEffect(() => {
    void api.presets().then(setPresets).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Presetを読み込めませんでした。');
    }).finally(() => setPresetsLoading(false));
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
    {presetsLoading
      ? <div className="loading"><RefreshCw className="spin" size={16} />Presetを読み込み中…</div>
      : <PresetSetupChoice presets={presets} selectedId={presetId} onChange={setPresetId} />}
    <button className="primary" disabled={busy || presetsLoading}>{busy ? '組織DBを作成中…' : 'この名前で組織を作成する'}</button>
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
    <div className="loading"><RefreshCw className="spin" size={18} />{revalidator.state === 'idle' ? '5秒ごとに状態を確認しています…' : '状態を確認中…'}</div>
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
  taskReassignment: TaskReassignmentReview;
  members: OrganizationMember[];
  lineDestinations: OrganizationLineDestination[];
  presets: PresetSummary[];
  attachmentFolder: { path: string };
  responseWindow: { days: number };
  guestRegistrations: GuestRegistrationRoster[];
}

export const loadOrganization = async (organizationId: string): Promise<OrganizationRouteData> => {
  const state = await api.bootstrap();
  if (state.kind !== 'ready') throw new Response('Organization is not ready', { status: 409 });
  const organization = state.organizations.find((value) => value.organizationId === organizationId);
  if (!organization) throw new Response('Organization was not found', { status: 404 });
  const [automation, connections, dashboard, rules, prompts, agentRules, agentRuns, lists, audit, tasks, taskRoles, taskReassignment, members, lineDestinations, presets, attachmentFolder, guestRegistrations, responseWindow] = await Promise.all([
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
    api.organizationTaskReassignment(organizationId),
    api.organizationMembers(organizationId),
    api.organizationLineDestinations(organizationId),
    api.presets(),
    api.organizationAttachmentFolder(organizationId),
    api.organizationGuestRegistrations(organizationId),
    api.organizationResponseWindow(organizationId),
  ]);
  return { state, organization, automation, connections, dashboard, rules, prompts, agentRules, agentRuns, lists, audit, tasks, taskRoles, taskReassignment, members, lineDestinations, presets, attachmentFolder, guestRegistrations, responseWindow };
};

const roleChangeOpensReassignment = (current: OrganizationRouteData): OrganizationRouteData => ({
  ...current,
  taskReassignment: { ...current.taskReassignment, pending: true, rolesChangedAt: new Date().toISOString() },
});

interface OrganizationContextValue extends OrganizationRouteData, PendingOperations {
  summary: AutomationSummary | null;
  setEnabled: (enabled: boolean) => void;
  runAutomation: () => void;
  saveLineConnection: () => void;
  saveAiConnection: () => void;
  testAi: () => void;
  searchMailbox: () => void;
  prepareMailbox: (messageId: string) => void;
  previewMailbox: (messageId: string) => void;
  createCalendarEvent: () => void;
  prepareRefresh: () => void;
  planRefresh: () => void;
  applyRefresh: (candidateIndexes: number[]) => void;
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
  taskReassignmentProposals: TaskAssignmentProposal[];
  taskReassignmentSkipped: string[];
  suggestTaskReassignments: () => void;
  applyTaskReassignments: (assignments: Array<{ taskId: string; roleId: string }>) => void;
  discardTaskReassignments: () => void;
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
  mailTestSubject: string;
  mailTestMatches: MailboxTestMatch[];
  mailTestAiRequest: MailboxTestAiRequest | null;
  mailTestPreview: MailboxTestPreview | null;
  mailTestCreatedEventIds: string[];
  mailTestRefreshRequest: MailboxTestRefreshRequest | null;
  mailTestRefreshPlan: MailboxTestRefreshPlan | null;
  mailTestRefreshOutcome: MailboxTestRefreshOutcome | null;
  attachmentFolderPath: string;
  setAttachmentFolderPath: (value: string) => void;
  saveAttachmentFolderPath: () => void;
  responseWindowDays: string;
  setResponseWindowDays: (value: string) => void;
  saveResponseWindowDays: () => void;
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
  const operations = usePendingOperations();
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const [lineChannelAccessToken, setLineChannelAccessToken] = useState('');
  const [lineChannelSecret, setLineChannelSecret] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState(data.connections.ai.model);
  const [aiBaseUrl, setAiBaseUrl] = useState(data.connections.ai.baseUrl);
  const [attachmentFolderPath, setAttachmentFolderPath] = useState(data.attachmentFolder.path);
  const [responseWindowDays, setResponseWindowDays] = useState(String(data.responseWindow.days));
  const [aiTestPrompt, setAiTestPrompt] = useState('日本の首都を一文で教えてください。');
  const [aiTestResult, setAiTestResult] = useState('');
  const [mailTestSubject, setMailTestSubject] = useState(DEFAULT_MAIL_TEST_SUBJECT);
  const [mailTestMatches, setMailTestMatches] = useState<MailboxTestMatch[]>([]);
  const [mailTestAiRequest, setMailTestAiRequest] = useState<MailboxTestAiRequest | null>(null);
  const [mailTestPreview, setMailTestPreview] = useState<MailboxTestPreview | null>(null);
  const [mailTestCreatedEventIds, setMailTestCreatedEventIds] = useState<string[]>([]);
  const [mailTestRefreshRequest, setMailTestRefreshRequest] = useState<MailboxTestRefreshRequest | null>(null);
  const [mailTestRefreshPlan, setMailTestRefreshPlan] = useState<MailboxTestRefreshPlan | null>(null);
  const [mailTestRefreshOutcome, setMailTestRefreshOutcome] = useState<MailboxTestRefreshOutcome | null>(null);
  const [agentTranscript, setAgentTranscript] = useState<AgentRunTranscript | null>(null);
  const [proposedActions, setProposedActions] = useState<ProposedAction[]>([]);
  const [taskReassignmentProposals, setTaskReassignmentProposals] = useState<TaskAssignmentProposal[]>([]);
  const [taskReassignmentSkipped, setTaskReassignmentSkipped] = useState<string[]>([]);

  useEffect(() => {
    setData(initial);
    setAiModel(initial.connections.ai.model);
    setAiBaseUrl(initial.connections.ai.baseUrl);
    setLineChannelAccessToken('');
    setLineChannelSecret('');
    setAiApiKey('');
    setSummary(null);
    setTaskReassignmentProposals([]);
    setTaskReassignmentSkipped([]);
  }, [initial]);

  const organizationId = data.organization.organizationId;
  const runOperation = operations.run;
  const runAutomation = () => void runOperation(pendingKey.automationRun, async () => {
    const value = await api.runAutomation(organizationId);
    const automation = await api.currentAutomation(organizationId);
    setSummary(value);
    setData((current) => ({ ...current, automation }));
  });
  const setEnabled = (enabled: boolean) => void runOperation(pendingKey.automationEnabled, async () => {
    await api.setEnabled(organizationId, enabled);
    const automation = await api.currentAutomation(organizationId);
    setData((current) => ({ ...current, automation }));
  });
  const saveLineConnection = () => void runOperation(pendingKey.lineConnection, async () => {
    const line = await api.saveOrganizationLineConnection(organizationId, {
      channelAccessToken: lineChannelAccessToken || undefined,
      channelSecret: lineChannelSecret || undefined,
    });
    setData((current) => ({ ...current, connections: { ...current.connections, line } }));
    setLineChannelAccessToken('');
    setLineChannelSecret('');
  });
  const saveAiConnection = () => void runOperation(pendingKey.aiConnection, async () => {
    const ai = await api.saveOrganizationAiConnection(organizationId, {
      apiKey: aiApiKey || undefined,
      model: aiModel,
      baseUrl: aiBaseUrl,
    });
    setData((current) => ({ ...current, connections: { ...current.connections, ai } }));
    setAiApiKey('');
  });
  const saveResponseWindowDays = () => void runOperation(pendingKey.responseWindow, async () => {
    const responseWindow = await api.saveOrganizationResponseWindow(organizationId, Number(responseWindowDays.trim()));
    setData((current) => ({ ...current, responseWindow }));
    setResponseWindowDays(String(responseWindow.days));
  });

  const saveAttachmentFolderPath = () => void runOperation(pendingKey.attachmentFolder, async () => {
    const attachmentFolder = await api.saveOrganizationAttachmentFolder(organizationId, attachmentFolderPath);
    setData((current) => ({ ...current, attachmentFolder }));
    setAttachmentFolderPath(attachmentFolder.path);
  });
  const testAi = () => void runOperation(pendingKey.aiTest, async () => {
    setAiTestResult('');
    setAiTestResult((await api.testAiConnection(organizationId, aiTestPrompt)).text);
  });
  const searchMailbox = () => void runOperation(pendingKey.mailSearch, async () => {
    setMailTestAiRequest(null);
    setMailTestPreview(null);
    setMailTestCreatedEventIds([]);
    setMailTestMatches((await api.searchMailboxForTest(organizationId, mailTestSubject.trim())).messages);
  });
  const prepareMailbox = (messageId: string) => void runOperation(pendingKey.mailPrepare(messageId), async () => {
    setMailTestAiRequest(await api.prepareMailboxTestAiRequest(organizationId, messageId));
    setMailTestPreview(null);
    setMailTestCreatedEventIds([]);
  });
  const previewMailbox = (messageId: string) => void runOperation(pendingKey.mailPreview, async () => {
    if (mailTestAiRequest?.id !== messageId) throw new Error('先に AI への送信内容を確認してください。');
    setMailTestPreview(await api.previewMailboxTestEvent(organizationId, messageId));
    setMailTestCreatedEventIds([]);
  });
  const createCalendarEvent = () => void runOperation(pendingKey.mailCreateEvents, async () => {
    if (mailTestPreview) setMailTestCreatedEventIds((await api.createMailboxTestCalendarEvent(organizationId, mailTestPreview.confirmationToken)).eventIds);
  });
  const prepareRefresh = () => void runOperation(pendingKey.refreshPrepare, async () => {
    if (!mailTestPreview) throw new Error('先に AI 抽出を実行してください。');
    setMailTestRefreshPlan(null);
    setMailTestRefreshOutcome(null);
    setMailTestRefreshRequest(await api.prepareMailboxTestRefreshRequest(organizationId, mailTestPreview.id, mailTestPreview.confirmationToken));
  });
  const planRefresh = () => void runOperation(pendingKey.refreshPlan, async () => {
    if (!mailTestPreview) throw new Error('先に AI 抽出を実行してください。');
    setMailTestRefreshOutcome(null);
    setMailTestRefreshPlan(await api.planMailboxTestRefresh(organizationId, mailTestPreview.id, mailTestPreview.confirmationToken));
  });
  const applyRefresh = (candidateIndexes: number[]) => void runOperation(pendingKey.refreshApply, async () => {
    if (!mailTestRefreshPlan) throw new Error('先に既存予定と照合してください。');
    const outcome = await api.applyMailboxTestRefresh(organizationId, mailTestRefreshPlan.confirmationToken, candidateIndexes);
    setMailTestRefreshOutcome(outcome);
    if (outcome.confirmationToken) {
      setMailTestRefreshPlan({
        ...mailTestRefreshPlan,
        confirmationToken: outcome.confirmationToken,
        ...(outcome.expiresAt ? { expiresAt: outcome.expiresAt } : {}),
        entries: outcome.conflicts.map((conflict) => ({
          candidateIndex: conflict.candidateIndex,
          candidate: conflict.candidate,
          target: conflict.current,
          changedFields: conflict.changedFields,
          desired: mailTestRefreshPlan.entries.find((entry) => entry.candidateIndex === conflict.candidateIndex)?.desired ?? null,
        })),
      });
    }
  });
  const createRule = async (input: OrganizationRuleInput): Promise<void> => runOperation(pendingKey.ruleCreate, async () => {
    const rule = await api.createOrganizationRule(organizationId, input);
    setData((current) => ({ ...current, rules: [...current.rules, rule] }));
  });
  const updateRule = async (ruleId: string, input: Pick<OrganizationRuleInput, 'permittedRecipientListIds' | 'permittedLineListIds'>): Promise<void> => runOperation(pendingKey.ruleUpdate(ruleId), async () => {
    const updated = await api.updateOrganizationRule(organizationId, ruleId, input);
    setData((current) => ({ ...current, rules: current.rules.map((rule) => rule.id === ruleId ? { ...rule, ...updated } : rule) }));
  });
  const createPrompt = async (input: { name: string; instructions: string }): Promise<void> => runOperation(pendingKey.promptCreate, async () => {
    const prompt = await api.createOrganizationPrompt(organizationId, input);
    setData((current) => ({ ...current, prompts: [...current.prompts, prompt] }));
  });
  const updatePrompt = async (promptId: string, input: { name?: string; instructions?: string }): Promise<void> => runOperation(pendingKey.promptUpdate(promptId), async () => {
    const updated = await api.updateOrganizationPrompt(organizationId, promptId, input);
    setData((current) => ({ ...current, prompts: current.prompts.map((prompt) => prompt.id === promptId ? { ...prompt, ...updated } : prompt) }));
  });
  const deletePrompt = async (promptId: string): Promise<void> => runOperation(pendingKey.promptDelete(promptId), async () => {
    await api.removeOrganizationPrompt(organizationId, promptId);
    setData((current) => ({ ...current, prompts: current.prompts.filter((prompt) => prompt.id !== promptId) }));
  });
  const createAgentRule = async (input: { name: string; promptId: string; state: 'active' | 'suspended'; executionMode?: 'read_only' | 'approval' | 'unattended'; selectionPolicy: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[]; priority?: number }): Promise<void> => runOperation(pendingKey.agentRuleCreate, async () => {
    const rule = await api.createOrganizationAgentRule(organizationId, input);
    setData((current) => ({ ...current, agentRules: [...current.agentRules, rule] }));
  });
  const updateAgentRule = async (agentRuleId: string, input: { state?: 'active' | 'suspended' | 'archived'; executionMode?: 'read_only' | 'approval' | 'unattended'; permittedRecipientListIds?: string[]; permittedLineListIds?: string[] }): Promise<void> => runOperation(pendingKey.agentRuleUpdate(agentRuleId), async () => {
    const updated = await api.updateOrganizationAgentRule(organizationId, agentRuleId, input);
    setData((current) => ({ ...current, agentRules: current.agentRules.map((rule) => rule.id === agentRuleId ? updated : rule) }));
  });
  const loadAgentTranscript = (runId: string) => void runOperation(pendingKey.agentRunTranscript(runId), async () => {
    const [transcript, actions] = await Promise.all([api.agentRunTranscript(organizationId, runId), api.agentProposedActions(organizationId, runId)]);
    setAgentTranscript(transcript);
    setProposedActions(actions);
  });
  const decideProposedAction = (actionId: string, decision: 'approve' | 'reject') => void runOperation(pendingKey.actionDecision(actionId, decision), async () => {
    const decided = await api.decideProposedAction(organizationId, actionId, decision);
    setProposedActions((current) => current.map((action) => action.id === actionId ? { ...action, ...decided } : action));
  });
  const decideProposedActionBatch = (runId: string, decision: 'approve' | 'reject') => void runOperation(pendingKey.actionBatch(runId, decision), async () => {
    const decided = await api.decideProposedActionBatch(organizationId, runId, decision);
    const byId = new Map(decided.map((action) => [action.id, action]));
    setProposedActions((current) => current.map((action) => byId.get(action.id) ?? action));
  });
  const updateTask = (taskId: string, input: { completed?: boolean; remarks?: string }) => void runOperation(pendingKey.taskUpdate(taskId), async () => {
    const task = await api.updateOrganizationTask(organizationId, taskId, input);
    setData((current) => ({ ...current, tasks: current.tasks.map((currentTask) => currentTask.id === task.id ? task : currentTask) }));
  });
  const createTaskRole = async (input: { displayName: string; description: string }): Promise<void> => runOperation(pendingKey.taskRoleCreate, async () => {
    const role = await api.createOrganizationTaskRole(organizationId, input);
    setData((current) => roleChangeOpensReassignment({ ...current, taskRoles: { ...current.taskRoles, roles: [...current.taskRoles.roles, role] } }));
  });
  const updateTaskRole = async (roleId: string, input: { displayName?: string; description?: string }): Promise<void> => runOperation(pendingKey.taskRoleUpdate(roleId), async () => {
    const role = await api.updateOrganizationTaskRole(organizationId, roleId, input);
    setData((current) => roleChangeOpensReassignment({ ...current, taskRoles: { ...current.taskRoles, roles: current.taskRoles.roles.map((item) => item.id === role.id ? role : item) } }));
  });
  const deleteTaskRole = async (roleId: string): Promise<void> => runOperation(pendingKey.taskRoleDelete(roleId), async () => {
    await api.removeOrganizationTaskRole(organizationId, roleId);
    setData((current) => roleChangeOpensReassignment({ ...current, taskRoles: { ...current.taskRoles, roles: current.taskRoles.roles.filter((role) => role.id !== roleId), assignments: current.taskRoles.assignments.filter((assignment) => assignment.roleId !== roleId) } }));
  });
  const assignTaskRole = (roleId: string, memberId: string) => void runOperation(pendingKey.taskRoleAssign(roleId), async () => {
    const assignment = await api.assignOrganizationTaskRole(organizationId, roleId, memberId);
    setData((current) => ({ ...current, taskRoles: { ...current.taskRoles, assignments: [...current.taskRoles.assignments.filter((currentAssignment) => currentAssignment.roleId !== roleId), assignment] } }));
  });
  const suggestTaskReassignments = () => void runOperation(pendingKey.reassignmentSuggest, async () => {
    setTaskReassignmentSkipped([]);
    const suggested = await api.suggestOrganizationTaskReassignments(organizationId);
    setTaskReassignmentProposals(suggested.proposals);
    setData((current) => ({ ...current, taskReassignment: suggested.review }));
  });
  const applyTaskReassignments = (assignments: Array<{ taskId: string; roleId: string }>) => void runOperation(pendingKey.reassignmentApply, async () => {
    const applied = await api.applyOrganizationTaskReassignments(organizationId, assignments);
    const reassigned = new Map(applied.tasks.map((task) => [task.id, task]));
    setTaskReassignmentProposals([]);
    setTaskReassignmentSkipped(applied.skipped);
    setData((current) => ({ ...current, tasks: current.tasks.map((task) => reassigned.get(task.id) ?? task), taskReassignment: applied.review }));
  });
  const discardTaskReassignments = (): void => {
    setTaskReassignmentProposals([]);
    setTaskReassignmentSkipped([]);
  };
  const reloadMembers = async (): Promise<void> => {
    const [members, lineDestinations] = await Promise.all([
      api.organizationMembers(organizationId),
      api.organizationLineDestinations(organizationId),
    ]);
    setData((current) => ({ ...current, members, lineDestinations }));
  };
  const createMember = async (input: OrganizationMemberInput): Promise<OrganizationMember | null> => {
    let created: OrganizationMember | null = null;
    await runOperation(pendingKey.memberCreate, async () => {
      created = await api.createOrganizationMember(organizationId, input);
      await reloadMembers();
    });
    return created;
  };
  const updateMember = async (
    memberId: string,
    input: Partial<Pick<OrganizationMember, 'name' | 'email' | 'tags' | 'state'>>,
  ): Promise<void> => runOperation(pendingKey.memberUpdate(memberId), async () => {
    await api.updateOrganizationMember(organizationId, memberId, input);
    await reloadMembers();
  });
  const setLineDestination = async (memberId: string, input: MemberLineDestinationInput): Promise<void> =>
    runOperation(pendingKey.lineDestinationSet(memberId), async () => {
      await api.setMemberLineDestination(organizationId, memberId, input);
      await reloadMembers();
    });
  const unlinkLineDestination = async (memberId: string, lineDestinationId: string): Promise<void> =>
    runOperation(pendingKey.lineDestinationUnlink(lineDestinationId), async () => {
      await api.removeMemberLineDestination(organizationId, memberId, lineDestinationId);
      await reloadMembers();
    });
  const registerLineDestination = async (input: MemberLineDestinationInput): Promise<void> =>
    runOperation(pendingKey.lineDestinationRegister, async () => {
      await api.registerLineDestination(organizationId, input);
      await reloadMembers();
    });
  const removeLineDestination = async (lineDestinationId: string): Promise<void> =>
    runOperation(pendingKey.lineDestinationRemove(lineDestinationId), async () => {
      await api.removeLineDestination(organizationId, lineDestinationId);
      await reloadMembers();
    });
  const refreshMembers = () => void runOperation(pendingKey.memberRefresh, reloadMembers);
  const applyPreset = (presetId: string, conflictPolicy?: 'duplicate') => void runOperation(pendingKey.presetApply(presetId), async () => {
    await api.applyOrganizationPreset(organizationId, presetId, conflictPolicy);
    const [rules, prompts, agentRules, lists, taskRoles] = await Promise.all([
      api.organizationRules(organizationId),
      api.organizationPrompts(organizationId),
      api.organizationAgentRules(organizationId),
      api.organizationLists(organizationId),
      api.organizationTaskRoles(organizationId),
    ]);
    setData((current) => ({ ...current, rules, prompts, agentRules, lists, taskRoles }));
  });
  const logout = () => void runOperation(pendingKey.logout, async () => { await api.logout(); navigate('/', { replace: true }); });
  const reauthenticate = () => void runOperation(pendingKey.reauthenticate, async () => { window.location.assign((await api.reauthorizeAutomationInbox(organizationId)).authorizationUrl); });
  const value: OrganizationContextValue = { ...data, ...operations, summary, setEnabled, runAutomation, saveLineConnection, saveAiConnection, testAi, searchMailbox, prepareMailbox, previewMailbox, createCalendarEvent, createRule, updateRule, agentTranscript, proposedActions, createPrompt, updatePrompt, deletePrompt, createAgentRule, updateAgentRule, loadAgentTranscript, decideProposedAction, decideProposedActionBatch, updateTask, createTaskRole, updateTaskRole, deleteTaskRole, assignTaskRole, taskReassignmentProposals, taskReassignmentSkipped, suggestTaskReassignments, applyTaskReassignments, discardTaskReassignments, createMember, updateMember, setLineDestination, unlinkLineDestination, registerLineDestination, removeLineDestination, refreshMembers, applyPreset, lineChannelAccessToken, lineChannelSecret, aiApiKey, aiModel, aiBaseUrl, aiTestPrompt, aiTestResult, mailTestSubject, mailTestMatches, mailTestAiRequest, mailTestPreview, mailTestCreatedEventIds, mailTestRefreshRequest, mailTestRefreshPlan, mailTestRefreshOutcome, prepareRefresh, planRefresh, applyRefresh, attachmentFolderPath, setAttachmentFolderPath, saveAttachmentFolderPath, responseWindowDays, setResponseWindowDays, saveResponseWindowDays, setLineChannelAccessToken, setLineChannelSecret, setAiApiKey, setAiModel, setAiBaseUrl, setAiTestPrompt, setMailTestSubject, logout, reauthenticate };
  return <OrganizationContext.Provider value={value}><Outlet /></OrganizationContext.Provider>;
};

type OrganizationPage = 'automation' | 'connections' | 'rules' | 'members' | 'mail-test' | 'tasks';
export const OrganizationPage = ({ page }: { page: OrganizationPage }) => {
  const value = useOrganization();
  const navigation = useNavigation();
  const auth: AuthMe = { email: value.state.identity.email, displayName: value.state.identity.displayName, organizations: value.state.organizations };
  return <Dashboard
    page={page}
    automation={value.automation}
    summary={value.summary}
    isPending={value.pending}
    isSettled={value.settled}
    runningOperations={value.running}
    navigating={navigation.state !== 'idle'}
    error={value.error}
    onRun={value.runAutomation}
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
    onSaveLineConnection={value.saveLineConnection}
    onSaveAiConnection={value.saveAiConnection}
    guestRegistrations={value.guestRegistrations}
    attachmentFolderPath={value.attachmentFolderPath}
    savedAttachmentFolderPath={value.attachmentFolder.path}
    onAttachmentFolderPathChange={value.setAttachmentFolderPath}
    onSaveAttachmentFolderPath={value.saveAttachmentFolderPath}
    responseWindowDays={value.responseWindowDays}
    savedResponseWindowDays={value.responseWindow.days}
    onResponseWindowDaysChange={value.setResponseWindowDays}
    onSaveResponseWindowDays={value.saveResponseWindowDays}
    aiTestPrompt={value.aiTestPrompt}
    aiTestResult={value.aiTestResult}
    onAiTestPromptChange={value.setAiTestPrompt}
    onTestAi={value.testAi}
    mailTestSubject={value.mailTestSubject}
    mailTestMatches={value.mailTestMatches}
    mailTestAiRequest={value.mailTestAiRequest}
    mailTestPreview={value.mailTestPreview}
    mailTestCreatedEventIds={value.mailTestCreatedEventIds}
    mailTestRefreshRequest={value.mailTestRefreshRequest}
    mailTestRefreshPlan={value.mailTestRefreshPlan}
    mailTestRefreshOutcome={value.mailTestRefreshOutcome}
    onPrepareRefresh={value.prepareRefresh}
    onPlanRefresh={value.planRefresh}
    onApplyRefresh={value.applyRefresh}
    onMailTestSubjectChange={value.setMailTestSubject}
    onSearchMailbox={value.searchMailbox}
    onPrepareMailbox={value.prepareMailbox}
    onPreviewMailbox={value.previewMailbox}
    onCreateCalendarEvent={value.createCalendarEvent}
    organizationRules={value.rules}
    organizationLists={value.lists}
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
    taskReassignment={value.taskReassignment}
    taskReassignmentProposals={value.taskReassignmentProposals}
    taskReassignmentSkipped={value.taskReassignmentSkipped}
    onSuggestTaskReassignments={value.suggestTaskReassignments}
    onApplyTaskReassignments={value.applyTaskReassignments}
    onDiscardTaskReassignments={value.discardTaskReassignments}
    organizationMembers={value.members}
    lineDestinations={value.lineDestinations}
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
export interface MemberPortalViewProps {
  portal: MemberPortal;
  running: readonly string[];
  pending: (key: string) => boolean;
  settled: (key: string) => boolean;
  error: string;
  onAttendance: (eventId: string, status: MemberAttendanceStatus, comment: string) => void;
  onComment: (eventId: string, status: MemberAttendanceStatus, comment: string) => void;
  onTaskCompleted: (taskId: string, completed: boolean) => void;
  onTaskRemarks: (taskId: string, remarks: string) => void;
  onLogout: () => void;
}

/** The Member Portal itself: every control reports the one answer it is sending. */
export const MemberPortalView = ({ portal, running, pending, settled, error, onAttendance, onComment, onTaskCompleted, onTaskRemarks, onLogout }: MemberPortalViewProps) => {
  const leaving = pending(pendingKey.portalLogout);
  return <main className="portal-shell">
    <PendingOverlay running={running} />
    <header className="portal-header">
      <div><p className="eyebrow">{portal.organization.name}</p><h1>{portal.member.name} さんのページ</h1></div>
      <button className="quiet-button" disabled={leaving} onClick={onLogout}>{leaving ? 'ログアウト中…' : 'ログアウト'}</button>
    </header>
    {error && <p className="setup-error">{error}</p>}
    <section className="portal-section">
      <h2>出欠登録</h2>
      {portal.events.length === 0 && <p className="portal-empty">登録が必要な予定はありません。</p>}
      {portal.events.map((event) => {
        const answering = (status: MemberAttendanceStatus): boolean => pending(pendingKey.portalAttendance(event.eventId, status));
        const commenting = pending(pendingKey.portalComment(event.eventId));
        return <article key={event.eventId} className="portal-event" aria-busy={commenting || answering('attending') || answering('not_attending')}>
          <div><h3>{event.title}</h3><p>{event.startsAt}{event.location && ` ・ ${event.location}`}</p></div>
          {event.open
            ? <div className="portal-answer">
              {(['attending', 'not_attending'] as const).map((status) => <button
                key={status}
                type="button"
                className={event.status === status ? 'primary' : 'secondary'}
                disabled={answering(status)}
                onClick={() => onAttendance(event.eventId, status, event.comment)}
              >{answering(status) ? <><RefreshCw className="spin" size={14} />送信中…</> : attendanceLabel[status]}</button>)}
              <label>コメント<input
                defaultValue={event.comment}
                maxLength={1_000}
                disabled={commenting}
                onBlur={(change) => { if (change.target.value !== event.comment) onComment(event.eventId, event.status, change.target.value); }}
              />{commenting
                ? <small className="portal-field-state"><RefreshCw className="spin" size={12} />保存中…</small>
                : settled(pendingKey.portalComment(event.eventId)) ? <small className="portal-field-state saved">保存しました</small> : null}</label>
            </div>
            : <p className="portal-locked">回答期限を過ぎました（現在: {attendanceLabel[event.status]}）</p>}
        </article>;
      })}
    </section>
    <section className="portal-section">
      <h2>タスク</h2>
      {portal.tasks.length === 0 && <p className="portal-empty">タスクはありません。</p>}
      {portal.tasks.map((task) => {
        const completing = pending(pendingKey.portalTask(task.taskId));
        const remarking = pending(pendingKey.portalRemarks(task.taskId));
        return <article key={task.taskId} className={`portal-task ${task.mine ? 'mine' : ''}`} aria-busy={completing || remarking}>
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
                disabled={completing}
                onChange={(change) => onTaskCompleted(task.taskId, change.target.checked)}
              />完了{completing && <RefreshCw className="spin" size={12} />}</label>
              <label>備考<input
                defaultValue={task.remarks}
                disabled={remarking}
                onBlur={(change) => { if (change.target.value !== task.remarks) onTaskRemarks(task.taskId, change.target.value); }}
              />{remarking
                ? <small className="portal-field-state"><RefreshCw className="spin" size={12} />保存中…</small>
                : settled(pendingKey.portalRemarks(task.taskId)) ? <small className="portal-field-state saved">保存しました</small> : null}</label>
            </div>
            : <p className="portal-locked">{task.completed ? '完了' : '未完了'}</p>}
        </article>;
      })}
    </section>
  </main>;
};

/** The one signed-in page a Member has: attendance, comments, and their Tasks. */
export const MemberPortalRoute = () => {
  const [portal, setPortal] = useState<MemberPortal | null>(null);
  const [loadError, setLoadError] = useState('');
  const { running, pending, settled, error, run } = usePendingOperations();
  const reload = async (): Promise<void> => { setPortal(await api.memberPortal()); };
  useEffect(() => {
    void reload().catch((cause: unknown) => setLoadError(cause instanceof Error ? cause.message : 'メンバーページを開けませんでした。'));
  }, []);
  const answer = (key: string, work: () => Promise<unknown>): void => void run(key, async () => { await work(); await reload(); });
  if (!portal) return <SetupCard>{loadError ? <p className="setup-error">{loadError}</p> : <div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div>}</SetupCard>;
  return <MemberPortalView
    portal={portal}
    running={running}
    pending={pending}
    settled={settled}
    error={loadError || error}
    onAttendance={(eventId, status, comment) => answer(pendingKey.portalAttendance(eventId, status), () => api.registerMemberAttendance(eventId, { status, comment }))}
    onComment={(eventId, status, comment) => answer(pendingKey.portalComment(eventId), () => api.registerMemberAttendance(eventId, { status, comment }))}
    onTaskCompleted={(taskId, completed) => answer(pendingKey.portalTask(taskId), () => api.updateMemberTask(taskId, { completed }))}
    onTaskRemarks={(taskId, remarks) => answer(pendingKey.portalRemarks(taskId), () => api.updateMemberTask(taskId, { remarks }))}
    onLogout={() => void run(pendingKey.portalLogout, async () => { await api.logout(); window.location.assign('/'); })}
  />;
};

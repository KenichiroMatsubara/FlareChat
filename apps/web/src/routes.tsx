import { RefreshCw } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { isRouteErrorResponse, NavLink, Outlet, useLoaderData, useNavigate, useNavigation, useParams, useRevalidator, useRouteError, useSearchParams } from 'react-router-dom';

import type { AppState } from '@mail/domain';

import { api } from './api';
import type { ContactAttendanceStatus, ContactPortal, AgentRunIndex, AgentRunTranscript, AutomationStatus, AutomationSummary, AuthMe, DeliveryAuditRecord, GuestRegistrationRoster, MailboxTestAiRequest, MailboxTestMatch, MailboxTestPreview, MailboxTestRefreshOutcome, MailboxTestRefreshPlan, MailboxTestRefreshRequest, AccountAgentRule, AccountConnections, AccountDashboard, AccountLineDestination, AccountMembership, AccountPrompt, AccountContact, AccountContactInput, AccountRule, AccountRuleInput, AccountTask, AccountTypedList, PresetSummary, ContactLineDestinationInput, RuleRun } from './api';
import { defaultAccountName, setupPhaseLabel, SignedOutEntry } from './entry';
import { pendingKey, usePendingOperations, type PendingOperations } from './pending';
import { PendingOverlay } from './progress';
import { Dashboard } from './dashboard';

export const DEFAULT_MAIL_TEST_SUBJECT = '名古屋名城RAC30周年記念式典のご案内';

/**
 * A route loader can run several API calls in parallel (e.g. switching
 * Account) while the previous page stays on screen, so without this bar
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
    <div className="setup-brand"><strong>FlareChat</strong><small>CREATE ACCOUNT</small></div>
    <p className="eyebrow">NO ACCOUNT</p><h1>Accountをセットアップ</h1>
    <p className="setup-copy">Automation Inboxを認可すると、このGoogleアカウントを初期OwnerとしてAccount DBを作成します。</p>
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
  <p>選択した構成をAccount作成時にコピーします。後の製品更新とはリンクされません。</p>
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
    <p className="eyebrow">CONFIRM ACCOUNT</p><h1>組織名を確認</h1>
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

export interface AccountRouteData {
  state: Extract<AppState, { kind: 'ready' }>;
  account: AccountMembership;
  automation: AutomationStatus | null;
  connections: AccountConnections;
  dashboard: AccountDashboard;
  rules: AccountRule[];
  prompts: AccountPrompt[];
  agentRules: AccountAgentRule[];
  agentRuns: AgentRunIndex[];
  ruleRuns: RuleRun[];
  lists: AccountTypedList[];
  audit: DeliveryAuditRecord[];
  tasks: AccountTask[];
  taskContacts: Array<{ contactId: string; displayName: string }>;
  noticeTargets: Array<{ id: string; name: string; channels: string[] }>;
  contactLists: Array<{ id: string; name: string; contactIds: string[] }>;
  contacts: AccountContact[];
  lineDestinations: AccountLineDestination[];
  presets: PresetSummary[];
  attachmentFolder: { path: string };
  responseWindow: { days: number };
  guestRegistrations: GuestRegistrationRoster[];
}

export const loadAccount = async (accountId: string): Promise<AccountRouteData> => {
  const state = await api.bootstrap();
  if (state.kind !== 'ready') throw new Response('Account is not ready', { status: 409 });
  const account = state.accounts.find((value) => value.accountId === accountId);
  if (!account) throw new Response('Account was not found', { status: 404 });
  const [automation, connections, dashboard, rules, prompts, agentRules, agentRuns, ruleRuns, lists, audit, tasks, contacts, lineDestinations, presets, attachmentFolder, guestRegistrations, responseWindow, noticeTargets, contactLists] = await Promise.all([
    api.currentAutomation(accountId),
    api.accountConnections(accountId),
    api.accountDashboard(accountId),
    api.accountRules(accountId),
    api.accountPrompts(accountId),
    api.accountAgentRules(accountId),
    api.accountAgentRuns(accountId),
    api.accountRuleRuns(accountId),
    api.accountLists(accountId),
    api.accountDeliveryAudit(accountId),
    api.accountTasks(accountId),
    api.accountContacts(accountId),
    api.accountLineDestinations(accountId),
    api.presets(),
    api.accountAttachmentFolder(accountId),
    api.accountGuestRegistrations(accountId),
    api.accountResponseWindow(accountId),
    api.channelTestTargets(accountId),
    api.contactLists(accountId),
  ]);
  return {
    state, account, automation, connections, dashboard, rules, prompts, agentRules, agentRuns, ruleRuns, lists, audit, tasks,
    taskContacts: contacts.filter((contact) => contact.state === 'active').map((contact) => ({ contactId: contact.id, displayName: contact.name })),
    // Who a Rule's notice may be addressed to (ADR 0166). Email is the ordinary
    // way to reach a person, so every active Contact holding an address is
    // offered; a group or a room holds no address and is offered on the Channel
    // the Channel Test found it reachable on. A Contact with neither is left
    // out, because ticking it would do nothing.
    noticeTargets: contacts.flatMap((contact) => {
      if (contact.state !== 'active') return [];
      if (contact.email) return [{ id: contact.id, name: contact.name, channels: ['email'] }];
      const reachable = noticeTargets.find((target) => target.id === contact.id);
      return reachable?.channels.length ? [{ id: contact.id, name: contact.name, channels: reachable.channels }] : [];
    }),
    contactLists,
    contacts, lineDestinations, presets, attachmentFolder, guestRegistrations, responseWindow,
  };
};

interface AccountContextValue extends AccountRouteData, PendingOperations {
  summary: AutomationSummary | null;
  setEnabled: (enabled: boolean) => void;
  runAutomation: () => void;
  saveLineConnection: () => void;
  saveAiConnection: () => void;
  testAi: () => void;
  searchMailbox: () => void;
  prepareMailbox: (messageId: string) => void;
  previewMailbox: (messageId: string) => void;
  previewDraftMailbox: (messageId: string, ruleId: string) => void;
  createMailboxTestEvents: () => void;
  startDraftRuleRun: (ruleId: string) => void;
  prepareRefresh: () => void;
  planRefresh: () => void;
  applyRefresh: (candidateIndexes: number[]) => void;
  createRule: (input: AccountRuleInput) => Promise<void>;
  saveNoticeContacts: (ruleId: string, contactIds: string[]) => Promise<void>;
  updateRule: (ruleId: string, input: Partial<Pick<AccountRule, 'name' | 'state' | 'executionMode' | 'selectionPolicy' | 'priority' | 'noticeContactListId' | 'permittedRecipientListIds' | 'permittedLineListIds'>>) => Promise<void>;
  agentTranscript: AgentRunTranscript | null;
  createPrompt: (input: { name: string; instructions: string }) => Promise<void>;
  updatePrompt: (promptId: string, input: { name?: string; instructions?: string }) => Promise<void>;
  deletePrompt: (promptId: string) => Promise<void>;
  createAgentRule: (input: { name: string; promptId: string; state: 'draft' | 'active'; executionMode?: 'read_only' | 'approval' | 'unattended'; selectionPolicy: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[]; priority?: number }) => Promise<void>;
  updateAgentRule: (agentRuleId: string, input: { state?: 'draft' | 'active' | 'suspended' | 'archived'; executionMode?: 'read_only' | 'approval' | 'unattended'; permittedRecipientListIds?: string[]; permittedLineListIds?: string[] }) => Promise<void>;
  loadAgentTranscript: (runId: string) => void;
  decideRuleRun: (runId: string, decision: 'approve' | 'reject') => void;
  updateTask: (taskId: string, input: { completed?: boolean; remarks?: string }) => void;
  createContact: (input: AccountContactInput) => Promise<AccountContact | null>;
  updateContact: (contactId: string, input: Partial<Pick<AccountContact, 'name' | 'email' | 'tags' | 'state'>>) => Promise<void>;
  setLineDestination: (contactId: string, input: ContactLineDestinationInput) => Promise<void>;
  unlinkLineDestination: (contactId: string, lineDestinationId: string) => Promise<void>;
  registerLineDestination: (input: ContactLineDestinationInput) => Promise<void>;
  removeLineDestination: (lineDestinationId: string) => Promise<void>;
  refreshContacts: () => void;
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
  draftRulePreview: MailboxTestPreview | null;
  mailTestCreatedEventIds: string[];
  mailTestRuleRunIds: string[];
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

const AccountContext = createContext<AccountContextValue | null>(null);
const useAccount = (): AccountContextValue => {
  const value = useContext(AccountContext);
  if (!value) throw new Error('Account route context is unavailable.');
  return value;
};

export const AccountLayout = () => {
  const initial = useLoaderData() as AccountRouteData;
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
  const [draftRulePreview, setDraftRulePreview] = useState<MailboxTestPreview | null>(null);
  const [mailTestCreatedEventIds, setMailTestCreatedEventIds] = useState<string[]>([]);
  const [mailTestRuleRunIds, setMailTestRuleRunIds] = useState<string[]>([]);
  const [mailTestRefreshRequest, setMailTestRefreshRequest] = useState<MailboxTestRefreshRequest | null>(null);
  const [mailTestRefreshPlan, setMailTestRefreshPlan] = useState<MailboxTestRefreshPlan | null>(null);
  const [mailTestRefreshOutcome, setMailTestRefreshOutcome] = useState<MailboxTestRefreshOutcome | null>(null);
  const [agentTranscript, setAgentTranscript] = useState<AgentRunTranscript | null>(null);

  useEffect(() => {
    setData(initial);
    setAiModel(initial.connections.ai.model);
    setAiBaseUrl(initial.connections.ai.baseUrl);
    setLineChannelAccessToken('');
    setLineChannelSecret('');
    setAiApiKey('');
    setSummary(null);
  }, [initial]);

  const accountId = data.account.accountId;
  const runOperation = operations.run;
  const runAutomation = () => void runOperation(pendingKey.automationRun, async () => {
    const value = await api.runAutomation(accountId);
    const [automation, ruleRuns] = await Promise.all([
      api.currentAutomation(accountId),
      api.accountRuleRuns(accountId),
    ]);
    setSummary(value);
    setData((current) => ({ ...current, automation, ruleRuns }));
  });
  const setEnabled = (enabled: boolean) => void runOperation(pendingKey.automationEnabled, async () => {
    await api.setEnabled(accountId, enabled);
    const automation = await api.currentAutomation(accountId);
    setData((current) => ({ ...current, automation }));
  });
  const saveLineConnection = () => void runOperation(pendingKey.lineConnection, async () => {
    const line = await api.saveAccountLineConnection(accountId, {
      channelAccessToken: lineChannelAccessToken || undefined,
      channelSecret: lineChannelSecret || undefined,
    });
    setData((current) => ({ ...current, connections: { ...current.connections, line } }));
    setLineChannelAccessToken('');
    setLineChannelSecret('');
  });
  const saveAiConnection = () => void runOperation(pendingKey.aiConnection, async () => {
    const ai = await api.saveAccountAiConnection(accountId, {
      apiKey: aiApiKey || undefined,
      model: aiModel,
      baseUrl: aiBaseUrl,
    });
    setData((current) => ({ ...current, connections: { ...current.connections, ai } }));
    setAiApiKey('');
  });
  const saveResponseWindowDays = () => void runOperation(pendingKey.responseWindow, async () => {
    const responseWindow = await api.saveAccountResponseWindow(accountId, Number(responseWindowDays.trim()));
    setData((current) => ({ ...current, responseWindow }));
    setResponseWindowDays(String(responseWindow.days));
  });

  const saveAttachmentFolderPath = () => void runOperation(pendingKey.attachmentFolder, async () => {
    const attachmentFolder = await api.saveAccountAttachmentFolder(accountId, attachmentFolderPath);
    setData((current) => ({ ...current, attachmentFolder }));
    setAttachmentFolderPath(attachmentFolder.path);
  });
  const testAi = () => void runOperation(pendingKey.aiTest, async () => {
    setAiTestResult('');
    setAiTestResult((await api.testAiConnection(accountId, aiTestPrompt)).text);
  });
  const searchMailbox = () => void runOperation(pendingKey.mailSearch, async () => {
    setMailTestAiRequest(null);
    setMailTestPreview(null);
    setDraftRulePreview(null);
    setMailTestCreatedEventIds([]);
    setMailTestRuleRunIds([]);
    setMailTestMatches((await api.searchMailboxForTest(accountId, mailTestSubject.trim())).messages);
  });
  const prepareMailbox = (messageId: string) => void runOperation(pendingKey.mailPrepare(messageId), async () => {
    setMailTestAiRequest(await api.prepareMailboxTestAiRequest(accountId, messageId));
    setMailTestPreview(null);
    setDraftRulePreview(null);
    setMailTestCreatedEventIds([]);
    setMailTestRuleRunIds([]);
  });
  const previewMailbox = (messageId: string) => void runOperation(pendingKey.mailPreview, async () => {
    if (mailTestAiRequest?.id !== messageId) throw new Error('先に AI への送信内容を確認してください。');
    setMailTestPreview(await api.previewMailboxTestEvent(accountId, messageId));
    setMailTestCreatedEventIds([]);
  });
  const previewDraftMailbox = (messageId: string, ruleId: string) => void runOperation(pendingKey.mailPreview, async () => {
    if (mailTestAiRequest?.id !== messageId) throw new Error('先に AI への送信内容を確認してください。');
    setDraftRulePreview(await api.previewDraftRuleEvent(accountId, messageId, ruleId));
    setMailTestRuleRunIds([]);
  });
  const createMailboxTestEvents = () => void runOperation(pendingKey.mailCreate, async () => {
    if (!mailTestPreview) throw new Error('先に AI 抽出を実行してください。');
    setMailTestCreatedEventIds((await api.createMailboxTestCalendarEvents(
      accountId,
      mailTestPreview.confirmationToken,
    )).eventIds);
  });
  const startDraftRuleRun = (ruleId: string) => void runOperation(pendingKey.mailStartRuleRun, async () => {
    if (draftRulePreview) {
      const run = await api.startMailboxTestRuleRun(accountId, draftRulePreview.confirmationToken, ruleId);
      setMailTestRuleRunIds([run.id]);
      setData((current) => ({ ...current, ruleRuns: [run, ...current.ruleRuns] }));
    }
  });
  const prepareRefresh = () => void runOperation(pendingKey.refreshPrepare, async () => {
    if (!mailTestPreview) throw new Error('先に AI 抽出を実行してください。');
    setMailTestRefreshPlan(null);
    setMailTestRefreshOutcome(null);
    setMailTestRefreshRequest(await api.prepareMailboxTestRefreshRequest(accountId, mailTestPreview.id, mailTestPreview.confirmationToken));
  });
  const planRefresh = () => void runOperation(pendingKey.refreshPlan, async () => {
    if (!mailTestPreview) throw new Error('先に AI 抽出を実行してください。');
    setMailTestRefreshOutcome(null);
    setMailTestRefreshPlan(await api.planMailboxTestRefresh(accountId, mailTestPreview.id, mailTestPreview.confirmationToken));
  });
  const applyRefresh = (candidateIndexes: number[]) => void runOperation(pendingKey.refreshApply, async () => {
    if (!mailTestRefreshPlan) throw new Error('先に既存予定と照合してください。');
    const outcome = await api.applyMailboxTestRefresh(accountId, mailTestRefreshPlan.confirmationToken, candidateIndexes);
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
  const createRule = async (input: AccountRuleInput): Promise<void> => runOperation(pendingKey.ruleCreate, async () => {
    const rule = await api.createAccountRule(accountId, input);
    setData((current) => ({ ...current, rules: [...current.rules, rule] }));
  });
  const updateRule = async (ruleId: string, input: Partial<Pick<AccountRule, 'name' | 'state' | 'executionMode' | 'selectionPolicy' | 'priority' | 'noticeContactListId' | 'permittedRecipientListIds' | 'permittedLineListIds'>>): Promise<void> => runOperation(pendingKey.ruleUpdate(ruleId), async () => {
    const updated = await api.updateAccountRule(accountId, ruleId, input);
    setData((current) => ({ ...current, rules: current.rules.map((rule) => rule.id === ruleId ? { ...rule, ...updated } : rule) }));
  });
  /**
   * Names who a Rule tells, as Contacts. The set is stored as the Rule's own
   * Contact List, so the platform keeps one named-set concept (ADR 0162).
   */
  const saveNoticeContacts = async (ruleId: string, contactIds: string[]): Promise<void> => runOperation(pendingKey.ruleNoticeContacts(ruleId), async () => {
    const rule = data.rules.find((entry) => entry.id === ruleId);
    if (!contactIds.length) {
      const updated = await api.updateAccountRule(accountId, ruleId, { noticeContactListId: null });
      setData((current) => ({ ...current, rules: current.rules.map((entry) => entry.id === ruleId ? { ...entry, ...updated } : entry) }));
      return;
    }
    const listId = rule?.noticeContactListId ?? crypto.randomUUID();
    await api.saveContactList(accountId, listId, { name: `${rule?.name ?? 'ルール'} の要約送り先`, contactIds });
    const updated = await api.updateAccountRule(accountId, ruleId, { noticeContactListId: listId });
    const contactLists = await api.contactLists(accountId);
    setData((current) => ({
      ...current,
      contactLists,
      rules: current.rules.map((entry) => entry.id === ruleId ? { ...entry, ...updated } : entry),
    }));
  });
  const createPrompt = async (input: { name: string; instructions: string }): Promise<void> => runOperation(pendingKey.promptCreate, async () => {
    const prompt = await api.createAccountPrompt(accountId, input);
    setData((current) => ({ ...current, prompts: [...current.prompts, prompt] }));
  });
  const updatePrompt = async (promptId: string, input: { name?: string; instructions?: string }): Promise<void> => runOperation(pendingKey.promptUpdate(promptId), async () => {
    const updated = await api.updateAccountPrompt(accountId, promptId, input);
    setData((current) => ({ ...current, prompts: current.prompts.map((prompt) => prompt.id === promptId ? { ...prompt, ...updated } : prompt) }));
  });
  const deletePrompt = async (promptId: string): Promise<void> => runOperation(pendingKey.promptDelete(promptId), async () => {
    await api.removeAccountPrompt(accountId, promptId);
    setData((current) => ({ ...current, prompts: current.prompts.filter((prompt) => prompt.id !== promptId) }));
  });
  const createAgentRule = async (input: { name: string; promptId: string; state: 'draft' | 'active'; executionMode?: 'read_only' | 'approval' | 'unattended'; selectionPolicy: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[]; priority?: number }): Promise<void> => runOperation(pendingKey.agentRuleCreate, async () => {
    const rule = await api.createAccountAgentRule(accountId, input);
    setData((current) => ({ ...current, agentRules: [...current.agentRules, rule] }));
  });
  const updateAgentRule = async (agentRuleId: string, input: { state?: 'draft' | 'active' | 'suspended' | 'archived'; executionMode?: 'read_only' | 'approval' | 'unattended'; permittedRecipientListIds?: string[]; permittedLineListIds?: string[] }): Promise<void> => runOperation(pendingKey.agentRuleUpdate(agentRuleId), async () => {
    const updated = await api.updateAccountAgentRule(accountId, agentRuleId, input);
    setData((current) => ({ ...current, agentRules: current.agentRules.map((rule) => rule.id === agentRuleId ? updated : rule) }));
  });
  const loadAgentTranscript = (runId: string) => void runOperation(pendingKey.agentRunTranscript(runId), async () => {
    setAgentTranscript(await api.agentRunTranscript(accountId, runId));
  });
  const decideRuleRun = (runId: string, decision: 'approve' | 'reject') => void runOperation(pendingKey.ruleRunDecision(runId, decision), async () => {
    const decided = await api.decideRuleRun(accountId, runId, decision);
    setData((current) => ({ ...current, ruleRuns: current.ruleRuns.map((run) => run.id === runId ? decided : run) }));
  });
  const updateTask = (taskId: string, input: { completed?: boolean; remarks?: string }) => void runOperation(pendingKey.taskUpdate(taskId), async () => {
    const task = await api.updateAccountTask(accountId, taskId, input);
    setData((current) => ({ ...current, tasks: current.tasks.map((currentTask) => currentTask.id === task.id ? task : currentTask) }));
  });
  const reloadContacts = async (): Promise<void> => {
    const [contacts, lineDestinations] = await Promise.all([
      api.accountContacts(accountId),
      api.accountLineDestinations(accountId),
    ]);
    setData((current) => ({ ...current, contacts, lineDestinations }));
  };
  const createContact = async (input: AccountContactInput): Promise<AccountContact | null> => {
    let created: AccountContact | null = null;
    await runOperation(pendingKey.contactCreate, async () => {
      created = await api.createAccountContact(accountId, input);
      await reloadContacts();
    });
    return created;
  };
  const updateContact = async (
    contactId: string,
    input: Partial<Pick<AccountContact, 'name' | 'email' | 'tags' | 'state'>>,
  ): Promise<void> => runOperation(pendingKey.contactUpdate(contactId), async () => {
    await api.updateAccountContact(accountId, contactId, input);
    await reloadContacts();
  });
  const setLineDestination = async (contactId: string, input: ContactLineDestinationInput): Promise<void> =>
    runOperation(pendingKey.lineDestinationSet(contactId), async () => {
      await api.setContactLineDestination(accountId, contactId, input);
      await reloadContacts();
    });
  const unlinkLineDestination = async (contactId: string, lineDestinationId: string): Promise<void> =>
    runOperation(pendingKey.lineDestinationUnlink(lineDestinationId), async () => {
      await api.removeContactLineDestination(accountId, contactId, lineDestinationId);
      await reloadContacts();
    });
  const registerLineDestination = async (input: ContactLineDestinationInput): Promise<void> =>
    runOperation(pendingKey.lineDestinationRegister, async () => {
      await api.registerLineDestination(accountId, input);
      await reloadContacts();
    });
  const removeLineDestination = async (lineDestinationId: string): Promise<void> =>
    runOperation(pendingKey.lineDestinationRemove(lineDestinationId), async () => {
      await api.removeLineDestination(accountId, lineDestinationId);
      await reloadContacts();
    });
  const refreshContacts = () => void runOperation(pendingKey.contactRefresh, reloadContacts);
  const applyPreset = (presetId: string, conflictPolicy?: 'duplicate') => void runOperation(pendingKey.presetApply(presetId), async () => {
    await api.applyAccountPreset(accountId, presetId, conflictPolicy);
    const [rules, prompts, agentRules, lists] = await Promise.all([
      api.accountRules(accountId),
      api.accountPrompts(accountId),
      api.accountAgentRules(accountId),
      api.accountLists(accountId),
    ]);
    setData((current) => ({ ...current, rules, prompts, agentRules, lists }));
  });
  const logout = () => void runOperation(pendingKey.logout, async () => { await api.logout(); navigate('/', { replace: true }); });
  const reauthenticate = () => void runOperation(pendingKey.reauthenticate, async () => { window.location.assign((await api.reauthorizeAutomationInbox(accountId)).authorizationUrl); });
  const value: AccountContextValue = { ...data, ...operations, summary, setEnabled, runAutomation, saveLineConnection, saveAiConnection, testAi, searchMailbox, prepareMailbox, previewMailbox, previewDraftMailbox, createMailboxTestEvents, startDraftRuleRun, createRule, updateRule, saveNoticeContacts, agentTranscript, createPrompt, updatePrompt, deletePrompt, createAgentRule, updateAgentRule, loadAgentTranscript, decideRuleRun, updateTask, createContact, updateContact, setLineDestination, unlinkLineDestination, registerLineDestination, removeLineDestination, refreshContacts, applyPreset, lineChannelAccessToken, lineChannelSecret, aiApiKey, aiModel, aiBaseUrl, aiTestPrompt, aiTestResult, mailTestSubject, mailTestMatches, mailTestAiRequest, mailTestPreview, draftRulePreview, mailTestCreatedEventIds, mailTestRuleRunIds, mailTestRefreshRequest, mailTestRefreshPlan, mailTestRefreshOutcome, prepareRefresh, planRefresh, applyRefresh, attachmentFolderPath, setAttachmentFolderPath, saveAttachmentFolderPath, responseWindowDays, setResponseWindowDays, saveResponseWindowDays, setLineChannelAccessToken, setLineChannelSecret, setAiApiKey, setAiModel, setAiBaseUrl, setAiTestPrompt, setMailTestSubject, logout, reauthenticate };
  return <AccountContext.Provider value={value}><Outlet /></AccountContext.Provider>;
};

type AccountPage = 'automation' | 'chat' | 'automations' | 'connections' | 'rules' | 'schema-rule' | 'members' | 'mailbox-test' | 'channel-test' | 'rule-runs' | 'event-refresh' | 'tasks' | 'reminders';
export const AccountPage = ({ page }: { page: AccountPage }) => {
  const value = useAccount();
  const navigation = useNavigation();
  const auth: AuthMe = { email: value.state.identity.email, displayName: value.state.identity.displayName, accounts: value.state.accounts };
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
    account={value.account}
    accountId={value.account.accountId}
    accounts={auth.accounts}
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
    draftRulePreview={value.draftRulePreview}
    mailTestCreatedEventIds={value.mailTestCreatedEventIds}
    mailTestRuleRunIds={value.mailTestRuleRunIds}
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
    onPreviewDraftMailbox={value.previewDraftMailbox}
    onCreateMailboxTestEvents={value.createMailboxTestEvents}
    onStartDraftRuleRun={value.startDraftRuleRun}
    accountRules={value.rules}
    accountLists={value.lists}
    onCreateRule={value.createRule}
    onUpdateRule={value.updateRule}
    noticeTargets={value.noticeTargets}
    contactLists={value.contactLists}
    onSaveNoticeContacts={value.saveNoticeContacts}
    prompts={value.prompts}
    agentRules={value.agentRules}
    agentRuns={value.agentRuns}
    agentTranscript={value.agentTranscript}
    ruleRuns={value.ruleRuns}
    onDecideRuleRun={value.decideRuleRun}
    onCreatePrompt={value.createPrompt}
    onUpdatePrompt={value.updatePrompt}
    onDeletePrompt={value.deletePrompt}
    onCreateAgentRule={value.createAgentRule}
    onUpdateAgentRule={value.updateAgentRule}
    onLoadAgentTranscript={value.loadAgentTranscript}
    accountTasks={value.tasks}
    onUpdateTask={value.updateTask}
    taskContacts={value.taskContacts}
    accountContacts={value.contacts}
    lineDestinations={value.lineDestinations}
    onCreateContact={value.createContact}
    onUpdateContact={value.updateContact}
    onSetLineDestination={value.setLineDestination}
    onUnlinkLineDestination={value.unlinkLineDestination}
    onRegisterLineDestination={value.registerLineDestination}
    onRemoveLineDestination={value.removeLineDestination}
    onRefreshContacts={value.refreshContacts}
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
  const message = isRouteErrorResponse(error) ? error.status === 404 ? 'Accountまたはページが見つかりません。' : error.statusText : error instanceof Error ? error.message : '画面を表示できませんでした。';
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

export const accountDefaultName = (state: Extract<AppState, { kind: 'ready' }>): string => defaultAccountName({ email: state.identity.email, displayName: state.identity.displayName, accounts: state.accounts });

/**
 * The single-use link that first brings a Contact into the Contact Portal. It is
 * the only entry: a Contact reaches it through their linked LINE Destination,
 * signs in with the identity-only Google grant, and is bound to that account.
 */
export const ContactPortalJoinRoute = () => {
  const state = useLoaderData() as AppState;
  const parameters = useParams();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accountId = parameters.accountId ?? '';
  const token = parameters.token ?? '';
  const signIn = async () => {
    setBusy(true); setError('');
    try { window.location.assign((await api.beginGoogleEntry('login')).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google 認可を開始できませんでした。'); setBusy(false); }
  };
  const join = async () => {
    setBusy(true); setError('');
    try {
      await api.joinContactPortal(accountId, token);
      navigate('/portal', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'このリンクは使用できませんでした。');
      setBusy(false);
    }
  };
  return <SetupCard>
    <div className="setup-brand"><strong>FlareChat</strong><small>CONTACT PORTAL</small></div>
    <p className="eyebrow">JOIN</p><h1>連絡先ページを開く</h1>
    {error && <p className="setup-error">{error}</p>}
    {state.kind === 'signed_out'
      ? <>
        <p className="setup-copy">Googleでログインすると、このリンクの連絡先としてアカウントが結び付きます。以降はこのアカウントだけで入れます。</p>
        <button className="primary" onClick={() => void signIn()} disabled={busy}>{busy ? 'Googleへ接続中…' : 'Googleでログイン'}</button>
      </>
      : <>
        <p className="setup-copy">{state.identity.email} をこの連絡先に結び付けます。リンクは一度だけ使えます。</p>
        <button className="primary" onClick={() => void join()} disabled={busy}>{busy ? '確認中…' : 'このアカウントで開始する'}</button>
      </>}
  </SetupCard>;
};

const attendanceLabel: Record<ContactAttendanceStatus, string> = {
  unanswered: '未回答',
  attending: '出席',
  not_attending: '欠席',
};

/** The one signed-in page a Contact has: attendance, comments, and their Tasks. */
export interface ContactPortalViewProps {
  portal: ContactPortal;
  running: readonly string[];
  pending: (key: string) => boolean;
  settled: (key: string) => boolean;
  error: string;
  onAttendance: (eventId: string, status: ContactAttendanceStatus, comment: string) => void;
  onComment: (eventId: string, status: ContactAttendanceStatus, comment: string) => void;
  onTaskCompleted: (taskId: string, completed: boolean) => void;
  onTaskRemarks: (taskId: string, remarks: string) => void;
  onLogout: () => void;
}

/** The Contact Portal itself: every control reports the one answer it is sending. */
export const ContactPortalView = ({ portal, running, pending, settled, error, onAttendance, onComment, onTaskCompleted, onTaskRemarks, onLogout }: ContactPortalViewProps) => {
  const leaving = pending(pendingKey.portalLogout);
  return <main className="portal-shell">
    <PendingOverlay running={running} />
    <header className="portal-header">
      <div><p className="eyebrow">{portal.account.name}</p><h1>{portal.contact.name} さんのページ</h1></div>
      <button className="quiet-button" disabled={leaving} onClick={onLogout}>{leaving ? 'ログアウト中…' : 'ログアウト'}</button>
    </header>
    {error && <p className="setup-error">{error}</p>}
    <section className="portal-section">
      <h2>出欠登録</h2>
      {portal.events.length === 0 && <p className="portal-empty">登録が必要な予定はありません。</p>}
      {portal.events.map((event) => {
        const answering = (status: ContactAttendanceStatus): boolean => pending(pendingKey.portalAttendance(event.eventId, status));
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
            <p>{task.assigneeName} ・ 期限 {task.deadline}</p>
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

/** The one signed-in page a Contact has: attendance, comments, and their Tasks. */
export const ContactPortalRoute = () => {
  const [portal, setPortal] = useState<ContactPortal | null>(null);
  const [loadError, setLoadError] = useState('');
  const { running, pending, settled, error, run } = usePendingOperations();
  const reload = async (): Promise<void> => { setPortal(await api.contactPortal()); };
  useEffect(() => {
    void reload().catch((cause: unknown) => setLoadError(cause instanceof Error ? cause.message : '連絡先ページを開けませんでした。'));
  }, []);
  const answer = (key: string, work: () => Promise<unknown>): void => void run(key, async () => { await work(); await reload(); });
  if (!portal) return <SetupCard>{loadError ? <p className="setup-error">{loadError}</p> : <div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div>}</SetupCard>;
  return <ContactPortalView
    portal={portal}
    running={running}
    pending={pending}
    settled={settled}
    error={loadError || error}
    onAttendance={(eventId, status, comment) => answer(pendingKey.portalAttendance(eventId, status), () => api.registerContactAttendance(eventId, { status, comment }))}
    onComment={(eventId, status, comment) => answer(pendingKey.portalComment(eventId), () => api.registerContactAttendance(eventId, { status, comment }))}
    onTaskCompleted={(taskId, completed) => answer(pendingKey.portalTask(taskId), () => api.updateContactTask(taskId, { completed }))}
    onTaskRemarks={(taskId, remarks) => answer(pendingKey.portalRemarks(taskId), () => api.updateContactTask(taskId, { remarks }))}
    onLogout={() => void run(pendingKey.portalLogout, async () => { await api.logout(); window.location.assign('/'); })}
  />;
};

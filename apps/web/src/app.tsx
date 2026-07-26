import { CalendarDays, CheckCircle2, CircleAlert, LogOut, Mail, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { AppState, ProvisioningPhase } from '@mail/domain';

import { api } from './api';
import type { AutomationStatus, AutomationSummary, AuthMe, DeliveryAuditRecord, MailboxTestMatch, MailboxTestPreview, OrganizationConnections, OrganizationDashboard, OrganizationRule, OrganizationRuleInput } from './api';
import { Dashboard } from './dashboard';

const formatted = (value: string | null): string => value
  ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'まだ実行していません';

/** Uses the authenticated Google profile as the only setup-name default; user edits always win. */
export const defaultOrganizationName = (member: AuthMe | null): string => member?.displayName.trim() || '';

export const shouldShowOrganizationLoading = (
  member: AuthMe | null,
  organizationId: string,
  loading: boolean,
): boolean => Boolean(member?.organizations.length && (!organizationId || loading));

export const setupPhaseLabel = (phase: ProvisioningPhase | null): string => {
  if (!phase) return '準備を開始しています';
  return {
    allocating_database: '組織DBを割り当てています',
    applying_schema: '組織DBのスキーマを適用しています',
    storing_credentials: 'Automation Inbox の認証情報を組織DBへ保存しています',
    verifying_binding: '組織DBへの接続を検証しています',
    activating_organization: '組織を有効化しています',
  }[phase];
};

export const SignedOutEntry = ({
  busy,
  error,
  onSelect,
}: {
  busy: boolean;
  error: string;
  onSelect: (intent: 'login' | 'organization_setup') => void;
}) => <main className="setup-shell"><section className="setup-card login-card">
  <div className="setup-brand"><span><Mail size={22} /></span><div><strong>Mail Automation</strong><small>GMAIL TO CALENDAR</small></div></div>
  <p className="eyebrow">GOOGLE IDENTITY</p><h1>Mail Automationを開く</h1>
  <p className="setup-copy">どちらか一方を選んでください。この選択自体はGoogle認証ではなく、選んだ導線でだけOAuthを1回行います。</p>
  {error && <p className="setup-error">{error}</p>}
  <button className="primary" onClick={() => onSelect('organization_setup')} disabled={busy}>{busy ? 'Googleへ接続中…' : '新しいOrganizationを作る'}</button>
  <button className="quiet-button google-login" onClick={() => onSelect('login')} disabled={busy}><ShieldCheck size={18} />既存Organizationへログイン</button>
</section></main>;

export const App = () => {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [organizationName, setOrganizationName] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [connections, setConnections] = useState<OrganizationConnections | null>(null);
  const [organizationDashboard, setOrganizationDashboard] = useState<OrganizationDashboard | null>(null);
  const [organizationRules, setOrganizationRules] = useState<OrganizationRule[]>([]);
  const [deliveryAudit, setDeliveryAudit] = useState<DeliveryAuditRecord[]>([]);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [lineChannelAccessToken, setLineChannelAccessToken] = useState('');
  const [lineChannelSecret, setLineChannelSecret] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [aiProvider, setAiProvider] = useState('Google Gemini API');
  const [aiModel, setAiModel] = useState('gemini-3.5-flash-lite');
  const [geminiTestPrompt, setGeminiTestPrompt] = useState('日本の首都を一文で教えてください。');
  const [geminiTestResult, setGeminiTestResult] = useState('');
  const [geminiTestBusy, setGeminiTestBusy] = useState(false);
  const [mailTestSubject, setMailTestSubject] = useState('田原ローターアクト招待行事のご案内（締切：7月18日）');
  const [mailTestMatches, setMailTestMatches] = useState<MailboxTestMatch[]>([]);
  const [mailTestPreview, setMailTestPreview] = useState<MailboxTestPreview | null>(null);
  const [mailTestBusy, setMailTestBusy] = useState(false);
  const [mailTestCreatedEventId, setMailTestCreatedEventId] = useState('');
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [organizationLoading, setOrganizationLoading] = useState(false);
  const [error, setError] = useState(new URLSearchParams(window.location.search).get('error') ?? '');
  const member: AuthMe | null = appState && appState.kind !== 'signed_out'
    ? {
      email: appState.identity.email,
      displayName: appState.identity.displayName,
      organizations: appState.kind === 'ready' ? appState.organizations : [],
    }
    : null;
  const refresh = async () => {
    try {
      setAppState(await api.bootstrap());
    } catch (cause) {
      if (appState) setError(cause instanceof Error ? cause.message : '状態を取得できませんでした。');
    }
  };
  useEffect(() => { void refresh(); if (window.location.search) window.history.replaceState({}, '', window.location.pathname); }, []);
  useEffect(() => {
    if (appState?.kind !== 'provisioning') return undefined;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [appState?.kind]);
  useEffect(() => {
    const organizations = member?.organizations ?? [];
    if (!organizations.some((organization) => organization.organizationId === organizationId)) {
      setOrganizationId(organizations[0]?.organizationId ?? '');
    }
  }, [member, organizationId]);
  useEffect(() => {
    if (appState?.kind === 'confirming_organization') {
      setOrganizationName(appState.setup.name);
      return;
    }
    if (member) setOrganizationName(defaultOrganizationName(member));
  }, [appState, member?.email]);
  useEffect(() => {
    if (!organizationId) { setOrganizationLoading(false); setAutomation(null); setConnections(null); setOrganizationDashboard(null); setOrganizationRules([]); setDeliveryAudit([]); return undefined; }
    let current = true;
    setOrganizationLoading(true);
    setAutomation(null);
    setConnections(null);
    setOrganizationDashboard(null);
    setOrganizationRules([]);
    setDeliveryAudit([]);
    void Promise.all([api.currentAutomation(organizationId), api.organizationConnections(organizationId), api.organizationDashboard(organizationId), api.organizationRules(organizationId), api.organizationDeliveryAudit(organizationId)]).then(([currentAutomation, value, dashboard, rules, audit]) => {
      if (!current) return;
      setAutomation(currentAutomation);
      setConnections(value); setOrganizationDashboard(dashboard); setOrganizationRules(rules); setDeliveryAudit(audit);
      setAiProvider('Google Gemini API');
      setAiModel(value.ai.model === 'gemini-3.6-flash' ? 'gemini-3.6-flash' : 'gemini-3.5-flash-lite');
      setLineChannelAccessToken('');
      setLineChannelSecret('');
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : '接続設定を取得できませんでした。');
    }).finally(() => {
      if (current) setOrganizationLoading(false);
    });
    return () => { current = false; };
  }, [organizationId]);
  const beginGoogleEntry = async (intent: 'login' | 'organization_setup') => {
    setBusy(true); setError('');
    try { window.location.assign((await api.beginGoogleEntry(intent)).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google 認可を開始できませんでした。'); setBusy(false); }
  };
  const restartOrganizationSetup = async () => {
    setBusy(true); setError('');
    try {
      await api.cancelOnboarding();
      await beginGoogleEntry('organization_setup');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '組織セットアップをやり直せませんでした。'); setBusy(false); }
  };
  const completeOrganizationSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try { await api.confirmOnboarding(organizationName); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '組織の作成を開始できませんでした。'); }
    finally { setBusy(false); }
  };
  const retryOrganizationSetup = async () => {
    setBusy(true); setError('');
    try { await api.retryOnboarding(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '組織DBの作成を再試行できませんでした。'); }
    finally { setBusy(false); }
  };
  const run = async () => {
    if (!organizationId) return;
    setBusy(true); setError('');
    try { setSummary(await api.runAutomation(organizationId)); setAutomation(await api.currentAutomation(organizationId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '自動化を実行できませんでした。'); }
    finally { setBusy(false); }
  };
  const setEnabled = async (enabled: boolean) => {
    if (!organizationId) return;
    setBusy(true); setError('');
    try { await api.setEnabled(organizationId, enabled); setAutomation(await api.currentAutomation(organizationId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '自動化を更新できませんでした。'); }
    finally { setBusy(false); }
  };
  const saveConnections = async () => {
    if (!organizationId) return;
    setSettingsBusy(true); setError('');
    try {
      const saved = await api.saveOrganizationConnections(organizationId, {
        line: { channelAccessToken: lineChannelAccessToken || undefined, channelSecret: lineChannelSecret || undefined },
        ai: {
          provider: aiProvider,
          apiKey: geminiApiKey || undefined,
          model: aiModel,
        },
      });
      setConnections(saved);
      setLineChannelAccessToken(''); setLineChannelSecret(''); setGeminiApiKey('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '接続設定を保存できませんでした。'); }
    finally { setSettingsBusy(false); }
  };
  const testGeminiConnection = async () => {
    if (!organizationId) return;
    setGeminiTestBusy(true); setGeminiTestResult(''); setError('');
    try {
      const result = await api.testGeminiConnection(organizationId, geminiTestPrompt, aiModel);
      setGeminiTestResult(result.text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gemini API の接続テストに失敗しました。');
    } finally { setGeminiTestBusy(false); }
  };
  const searchMailboxForTest = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!organizationId || !mailTestSubject.trim()) return;
    setMailTestBusy(true); setMailTestPreview(null); setMailTestCreatedEventId(''); setError('');
    try {
      const result = await api.searchMailboxForTest(organizationId, mailTestSubject.trim());
      setMailTestMatches(result.messages);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Gmail を検索できませんでした。'); }
    finally { setMailTestBusy(false); }
  };
  const previewMailboxTestEvent = async (messageId: string) => {
    if (!organizationId) return;
    setMailTestBusy(true); setMailTestPreview(null); setMailTestCreatedEventId(''); setError('');
    try { setMailTestPreview(await api.previewMailboxTestEvent(organizationId, messageId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'AI による予定の抽出に失敗しました。'); }
    finally { setMailTestBusy(false); }
  };
  const createMailboxTestCalendarEvent = async () => {
    if (!organizationId || !mailTestPreview) return;
    setMailTestBusy(true); setError('');
    try {
      const result = await api.createMailboxTestCalendarEvent(organizationId, mailTestPreview.confirmationToken);
      setMailTestCreatedEventId(result.eventId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Google Calendar に予定を作成できませんでした。'); }
    finally { setMailTestBusy(false); }
  };
  const createRule = async (input: OrganizationRuleInput): Promise<void> => {
    if (!organizationId || !input.name.trim()) return;
    setRuleBusy(true); setError('');
    try {
      const rule = await api.createOrganizationRule(organizationId, { ...input, name: input.name.trim() });
      setOrganizationRules((current) => [...current, rule]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ルールを作成できませんでした。'); }
    finally { setRuleBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try { await api.logout(); setAutomation(null); setAppState({ kind: 'signed_out' }); setOrganizationId(''); setConnections(null); setOrganizationDashboard(null); setOrganizationRules([]); setDeliveryAudit([]); setSummary(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'ログアウトできませんでした。'); }
    finally { setBusy(false); }
  };
  if (!appState) return <main className="setup-shell"><section className="setup-card login-card"><div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div></section></main>;
  if (appState.kind === 'signed_out') return <SignedOutEntry
    busy={busy}
    error={error}
    onSelect={(intent) => void beginGoogleEntry(intent)}
  />;
  if (appState.kind === 'unassigned') return <main className="setup-shell"><section className="setup-card login-card">
    <div className="setup-brand"><span><Mail size={22} /></span><div><strong>Mail Automation</strong><small>CREATE ORGANIZATION</small></div></div>
    <p className="eyebrow">NO ORGANIZATION</p><h1>Organizationをセットアップ</h1>
    <p className="setup-copy">Automation Inboxを認可すると、このGoogleアカウントを初期OwnerとしてOrganization DBを作成します。</p>
    {error && <p className="setup-error">{error}</p>}
    <button className="primary" onClick={() => void beginGoogleEntry('organization_setup')} disabled={busy}>{busy ? 'Googleへ接続中…' : 'Automation Inboxを認可する'}</button>
    <button className="quiet-button" onClick={() => void logout()} disabled={busy}>ログアウト</button>
  </section></main>;
  if (appState.kind === 'confirming_organization') return <main className="setup-shell"><section className="setup-card login-card">
    <div className="setup-brand"><span><Mail size={22} /></span><div><strong>Mail Automation</strong><small>ORGANIZATION SETUP</small></div></div>
    {error && <p className="setup-error">{error}</p>}
    <form className="setup-form" onSubmit={(event) => void completeOrganizationSetup(event)}>
      <p className="eyebrow">CONFIRM ORGANIZATION</p><h1>組織名を確認</h1>
      <p className="setup-copy">認可したGoogleアカウントをAutomation Inboxと初期Ownerにします。</p>
      <label>組織名<input value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} autoComplete="organization" required /></label>
      <button className="primary" disabled={busy}>{busy ? '組織DBを作成中…' : 'この名前で組織を作成する'}</button>
    </form>
  </section></main>;
  if (appState.kind === 'provisioning') return <main className="setup-shell"><section className="setup-card login-card">
    <p className="eyebrow">PROVISIONING</p><h1>組織を準備しています</h1>
    <p className="setup-copy">{setupPhaseLabel(appState.phase)}</p>
    <div className="loading"><RefreshCw className="spin" size={18} />状態を確認中…</div>
  </section></main>;
  if (appState.kind === 'provisioning_failed') return <main className="setup-shell"><section className="setup-card login-card">
    <p className="eyebrow">FAILED PHASE</p><h1>組織DBを準備できませんでした</h1>
    <p className="setup-copy">{setupPhaseLabel(appState.phase)}</p>
    <p className="setup-error">{appState.error ?? '組織DBの作成に失敗しました。'}</p>
    <button className="primary" onClick={() => void retryOrganizationSetup()} disabled={busy}>{busy ? '再試行中…' : 'この段階から再試行する'}</button>
    <button className="quiet-button" onClick={() => void restartOrganizationSetup()} disabled={busy}>最初からやり直す</button>
  </section></main>;
  if (shouldShowOrganizationLoading(member, organizationId, organizationLoading)) return <main className="setup-shell"><section className="setup-card login-card"><div className="loading"><RefreshCw className="spin" size={18} />組織DBを読み込み中…</div></section></main>;
  const organization = member?.organizations.find((value) => value.organizationId === organizationId) ?? null;
  const canManageRules = organization?.role === 'owner' || organization?.role === 'admin';
  return <Dashboard
    automation={automation}
    summary={summary}
    busy={busy}
    error={error}
    onRun={() => void run()}
    onSetEnabled={(enabled) => void setEnabled(enabled)}
    onLogout={() => void logout()}
    organization={organization}
    canManage={canManageRules}
    connections={connections}
    lineChannelAccessToken={lineChannelAccessToken}
    lineChannelSecret={lineChannelSecret}
    geminiApiKey={geminiApiKey}
    aiModel={aiModel}
    onLineChannelAccessTokenChange={setLineChannelAccessToken}
    onLineChannelSecretChange={setLineChannelSecret}
    onGeminiApiKeyChange={setGeminiApiKey}
    onAiModelChange={setAiModel}
    settingsBusy={settingsBusy}
    onSaveConnections={() => void saveConnections()}
    geminiTestPrompt={geminiTestPrompt}
    geminiTestResult={geminiTestResult}
    geminiTestBusy={geminiTestBusy}
    onGeminiTestPromptChange={setGeminiTestPrompt}
    onTestGemini={() => void testGeminiConnection()}
    mailTestSubject={mailTestSubject}
    mailTestMatches={mailTestMatches}
    mailTestPreview={mailTestPreview}
    mailTestBusy={mailTestBusy}
    mailTestCreatedEventId={mailTestCreatedEventId}
    onMailTestSubjectChange={setMailTestSubject}
    onSearchMailbox={() => void searchMailboxForTest()}
    onPreviewMailbox={(messageId) => void previewMailboxTestEvent(messageId)}
    onCreateCalendarEvent={() => void createMailboxTestCalendarEvent()}
    organizationRules={organizationRules}
    ruleBusy={ruleBusy}
    onCreateRule={createRule}
  />;
};

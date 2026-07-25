import { CalendarDays, CheckCircle2, CircleAlert, Eye, EyeOff, KeyRound, LogOut, Mail, Play, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { OrganizationSetup, PasskeyCreationOptions } from '@mail/domain';

import { api } from './api';
import type { AutomationStatus, AutomationSummary, AuthMe, OrganizationConnections, OrganizationDashboard, OrganizationRule } from './api';

const toBuffer = (value: string): ArrayBuffer => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return bytes.buffer;
};

const toBase64Url = (value: ArrayBuffer): string => {
  const binary = String.fromCharCode(...new Uint8Array(value));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const setupPasskeyOptions = (options: PasskeyCreationOptions): PublicKeyCredentialCreationOptions => ({
  challenge: toBuffer(options.challenge),
  rp: options.rp,
  user: { ...options.user, id: toBuffer(options.user.id) },
  pubKeyCredParams: options.pubKeyCredParams,
  timeout: options.timeout,
  authenticatorSelection: options.authenticatorSelection,
  attestation: options.attestation,
});

const formatted = (value: string | null): string => value
  ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'まだ実行していません';

interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}

const SecretInput = ({ value, onChange, placeholder, label }: SecretInputProps) => {
  const [revealed, setRevealed] = useState(false);
  return <div className="secret-input"><input type="text" className={revealed ? '' : 'secret-input-masked'} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={`${label}（シークレット）`} autoComplete="off" autoCapitalize="none" spellCheck={false} data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" /><button type="button" className="secret-toggle" onClick={() => setRevealed((current) => !current)} aria-label={revealed ? `${label}を隠す` : `${label}を表示`} title={revealed ? '隠す' : '表示'}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>;
};

export const App = () => {
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [member, setMember] = useState<AuthMe | null>(null);
  const [setup, setSetup] = useState<OrganizationSetup | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [organizationName, setOrganizationName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [connections, setConnections] = useState<OrganizationConnections | null>(null);
  const [organizationDashboard, setOrganizationDashboard] = useState<OrganizationDashboard | null>(null);
  const [organizationRules, setOrganizationRules] = useState<OrganizationRule[]>([]);
  const [ruleName, setRuleName] = useState('');
  const [ruleBusy, setRuleBusy] = useState(false);
  const [lineChannelAccessToken, setLineChannelAccessToken] = useState('');
  const [lineChannelSecret, setLineChannelSecret] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [aiProvider, setAiProvider] = useState('Google Gemini API');
  const [aiModel, setAiModel] = useState('gemini-3.5-flash-lite');
  const [geminiTestPrompt, setGeminiTestPrompt] = useState('日本の首都を一文で教えてください。');
  const [geminiTestResult, setGeminiTestResult] = useState('');
  const [geminiTestBusy, setGeminiTestBusy] = useState(false);
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyEmail, setPasskeyEmail] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [error, setError] = useState(new URLSearchParams(window.location.search).get('error') ?? '');
  const refresh = async () => {
    try {
      const [currentAutomation, currentMember, currentSetup] = await Promise.all([api.currentAutomation(), api.currentMember(), api.currentOrganizationSetup()]);
      setAutomation(currentAutomation);
      setMember(currentMember);
      setSetup(currentSetup);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '状態を取得できませんでした。'); }
    finally { setAuthChecked(true); }
  };
  useEffect(() => { void refresh(); if (window.location.search) window.history.replaceState({}, '', window.location.pathname); }, []);
  useEffect(() => {
    if (setup?.status !== 'provisioning') return undefined;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [setup?.status]);
  useEffect(() => {
    const organizations = member?.organizations ?? [];
    if (!organizations.some((organization) => organization.organizationId === organizationId)) {
      setOrganizationId(organizations[0]?.organizationId ?? '');
    }
  }, [member, organizationId]);
  useEffect(() => {
    if (!organizationId) { setConnections(null); setOrganizationDashboard(null); setOrganizationRules([]); return; }
    void Promise.all([api.organizationConnections(organizationId), api.organizationDashboard(organizationId), api.organizationRules(organizationId)]).then(([value, dashboard, rules]) => {
      setConnections(value); setOrganizationDashboard(dashboard); setOrganizationRules(rules);
      setAiProvider('Google Gemini API');
      setAiModel('gemini-3.5-flash-lite');
      setLineChannelAccessToken('');
      setLineChannelSecret('');
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '接続設定を取得できませんでした。'));
  }, [organizationId]);
  const login = async () => {
    setBusy(true); setError('');
    try { window.location.assign((await api.googleLogin()).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google ログインを開始できませんでした。'); setBusy(false); }
  };
  const startOrganizationSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try { window.location.assign((await api.startOrganizationSetup(organizationName)).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '組織セットアップを開始できませんでした。'); setBusy(false); }
  };
  const registerSetupPasskey = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const options = await api.setupPasskeyOptions(ownerEmail);
      const credential = await navigator.credentials.create({ publicKey: setupPasskeyOptions(options) });
      if (!(credential instanceof PublicKeyCredential)) throw new Error('パスキーの登録がキャンセルされました。');
      const response = credential.response as AuthenticatorAttestationResponse;
      setSetup(await api.verifySetupPasskey({
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: toBase64Url(response.clientDataJSON),
          attestationObject: toBase64Url(response.attestationObject),
          transports: response.getTransports?.() ?? [],
        },
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'パスキーを登録できませんでした。'); }
    finally { setBusy(false); }
  };
  const loginWithPasskey = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const options = await api.passkeyOptions(passkeyEmail);
      const credential = await navigator.credentials.get({ publicKey: {
        challenge: toBuffer(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
        allowCredentials: options.allowCredentials.map((value) => ({ type: value.type, id: toBuffer(value.id) })),
      } });
      if (!(credential instanceof PublicKeyCredential)) throw new Error('パスキーの認証がキャンセルされました。');
      const response = credential.response as AuthenticatorAssertionResponse;
      await api.verifyPasskey({
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: toBase64Url(response.clientDataJSON),
          authenticatorData: toBase64Url(response.authenticatorData),
          signature: toBase64Url(response.signature),
        },
      });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'パスキーでログインできませんでした。'); }
    finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true); setError('');
    try { setSummary(await api.runAutomation()); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '自動化を実行できませんでした。'); }
    finally { setBusy(false); }
  };
  const setEnabled = async (enabled: boolean) => {
    setBusy(true); setError('');
    try { await api.setEnabled(enabled); await refresh(); }
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
      const result = await api.testGeminiConnection(organizationId, geminiTestPrompt);
      setGeminiTestResult(result.text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gemini API の接続テストに失敗しました。');
    } finally { setGeminiTestBusy(false); }
  };
  const createRule = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId || !ruleName.trim()) return;
    setRuleBusy(true); setError('');
    try {
      const rule = await api.createOrganizationRule(organizationId, { name: ruleName.trim(), state: 'draft' });
      setOrganizationRules((current) => [...current, rule]);
      setRuleName('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ルールを作成できませんでした。'); }
    finally { setRuleBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try { await api.logout(); setAutomation(null); setMember(null); setOrganizationId(''); setConnections(null); setOrganizationDashboard(null); setOrganizationRules([]); setSummary(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'ログアウトできませんでした。'); }
    finally { setBusy(false); }
  };
  if (!authChecked) return <main className="setup-shell"><section className="setup-card login-card"><div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div></section></main>;
  if (setup || showSetup) return <main className="setup-shell"><section className="setup-card login-card">
    <div className="setup-brand"><span><Mail size={22} /></span><div><strong>Mail Automation</strong><small>ORGANIZATION SETUP</small></div></div>
    {error && <p className="setup-error">{error}</p>}
    {!setup && <form className="passkey-login" onSubmit={(event) => void startOrganizationSetup(event)}><p className="eyebrow">CREATE ORGANIZATION</p><h1>組織をセットアップ</h1><p className="setup-copy">Automation Inbox と管理者のパスキーを順に登録します。</p><label>組織名<input value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} placeholder="例: 地域サークル" required /></label><button className="primary" disabled={busy}>{busy ? 'Googleへ接続中…' : 'Automation Inbox を認可する'}</button><button className="quiet-button" type="button" onClick={() => setShowSetup(false)} disabled={busy}>戻る</button></form>}
    {setup?.status === 'awaiting_google' && <><p className="eyebrow">GOOGLE AUTHORIZATION</p><h1>Automation Inbox を認可中</h1><p className="setup-copy">Google の認可が完了すると、ここで初期 Owner のパスキーを登録できます。</p></>}
    {setup?.status === 'awaiting_passkey' && <form className="passkey-login" onSubmit={(event) => void registerSetupPasskey(event)}><p className="eyebrow">INITIAL OWNER</p><h1>初期 Owner を登録</h1><p className="setup-copy">Automation Inbox（{setup.inboxAddress}）とは別の管理用 Identity を指定してください。</p><label>Owner のメールアドレス<input type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="owner@example.com" autoComplete="username" required /></label><button className="primary" disabled={busy}><KeyRound size={18} />{busy ? 'パスキーを登録中…' : 'パスキーを登録する'}</button></form>}
    {setup?.status === 'provisioning' && <><p className="eyebrow">PROVISIONING</p><h1>組織を準備しています</h1><p className="setup-copy">D1 作成、スキーマ適用、Worker binding、検証を完了してから有効化します。</p><p>期限: {formatted(setup.provisioningExpiresAt)}</p>{setup.error && <p className="setup-error">{setup.error}</p>}<div className="loading"><RefreshCw className="spin" size={18} />状態を確認中…</div></>}
    {setup?.status === 'active' && <><p className="eyebrow">READY</p><h1>組織の準備が完了しました</h1><p className="setup-copy">Automation Inbox は接続済みです。登録した Owner のパスキーでログインしてください。</p><button className="primary" onClick={() => { setSetup(null); setShowSetup(false); }}>ログインへ</button></>}
    {(setup?.status === 'expired' || setup?.status === 'failed') && <><p className="eyebrow">SETUP NEEDS ATTENTION</p><h1>セットアップを完了できませんでした</h1><p className="setup-error">{setup.error ?? '期限が切れました。もう一度開始してください。'}</p><button className="primary" onClick={() => { setSetup(null); setShowSetup(true); }}>もう一度開始する</button></>}
  </section></main>;
  if (!automation && !member?.organizations.length) return <main className="setup-shell"><section className="setup-card login-card">
    <div className="setup-brand"><span><Mail size={22} /></span><div><strong>Mail Automation</strong><small>GMAIL TO CALENDAR</small></div></div>
    <p className="eyebrow">START WITH GOOGLE</p><h1>メールを予定にする</h1>
    <p className="setup-copy">Googleでログインすると、Gmailの新着メールを読み取り、日付と開始・終了時刻が書かれた案内をあなたのGoogleカレンダーへ自動登録します。</p>
    {error && <p className="setup-error">{error}</p>}
    <button className="primary google-login" onClick={() => void login()} disabled={busy}><ShieldCheck size={18} />{busy ? 'Googleへ接続中…' : 'Googleでログインして始める'}</button>
    <div className="login-divider"><span>組織メンバーの方</span></div>
    <form className="passkey-login" onSubmit={(event) => void loginWithPasskey(event)}><label>登録メールアドレス<input type="email" value={passkeyEmail} onChange={(event) => setPasskeyEmail(event.target.value)} placeholder="you@example.com" autoComplete="username" required /></label><button className="secondary" disabled={busy}><KeyRound size={16} />パスキーでログイン</button></form>
    <p className="login-note">Googleログインは個人の簡易自動化用、パスキーログインは組織設定用です。</p><button className="quiet-button" onClick={() => setShowSetup(true)}>新しい組織をセットアップ</button>
  </section></main>;
  const organization = member?.organizations.find((value) => value.organizationId === organizationId) ?? null;
  const canManageRules = organization?.role === 'owner' || organization?.role === 'admin';
  return <main className="setup-shell"><section className="setup-card dashboard-card">
    <div className="dashboard-top"><div className="setup-brand"><span><Mail size={22} /></span><div><strong>Mail Automation</strong><small>GMAIL TO CALENDAR</small></div></div><button className="quiet-button" onClick={() => void logout()} disabled={busy}><LogOut size={15} />ログアウト</button></div>
    {automation && <><p className="eyebrow">GOOGLE AUTOMATION</p><h1>自動化は{automation.enabled ? '有効です' : '停止中です'}</h1>
    <p className="setup-copy"><strong>{automation.displayName}</strong>（{automation.email}）の Gmail と primary Calendar を接続しています。</p></>}
    {error && <p className="setup-error">{error}</p>}{automation?.lastError && <p className="setup-error"><CircleAlert size={16} />{automation.lastError}</p>}
    {automation && <><div className="automation-status"><span className={automation.enabled ? 'status-dot active' : 'status-dot'} /><div><strong>{automation.enabled ? '新着メールを自動確認します' : '自動確認を停止しています'}</strong><small>前回の確認: {formatted(automation.lastSyncedAt)}</small></div><label className="switch"><input type="checkbox" checked={automation.enabled} onChange={(event) => void setEnabled(event.target.checked)} disabled={busy} /><span /></label></div>
    <button className="primary google-login" onClick={() => void run()} disabled={busy || !automation.enabled}>{busy ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}{busy ? '新着メールを確認中…' : '今すぐ新着メールを確認'}</button>
    {summary && <div className="run-result"><CheckCircle2 size={18} /><span>今回: {summary.created}件を予定化、{summary.skipped}件を保留、{summary.exceptions}件でエラー</span></div>}
    <div className="automation-guide"><CalendarDays size={19} /><div><strong>予定として認識する書式</strong><p>メールの件名または本文に <code>2026/08/03 19:00-21:00</code> または <code>2026年8月3日 19:00〜21:00</code> のように、日付と開始・終了時刻を含めてください。</p></div></div>
    <div className="automation-counts"><span><b>{automation.created}</b> 予定を作成</span><span><b>{automation.skipped}</b> 書式不足</span><span><b>{automation.exceptions}</b> エラー</span></div></>}
    {organization && <section className="organization-settings"><div className="settings-heading"><div><p className="eyebrow">ORGANIZATION SETTINGS</p><h2>{organization.name} の接続設定</h2></div>{member && member.organizations.length > 1 && <select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}><option value="">組織を選択</option>{member.organizations.map((value) => <option key={value.organizationId} value={value.organizationId}>{value.name}</option>)}</select>}</div><p className="settings-description">組織ごとに異なる LINE Messaging API と Gemini API を登録します。秘密情報は暗号化して保存され、画面には再表示されません。</p>{organizationDashboard && <div className="automation-counts"><span><b>{organizationDashboard.activeRules}</b> Active Rule</span><span><b>{organizationDashboard.upcomingEvents}</b> Upcoming Event</span><span><b>{organizationDashboard.pendingJobs}</b> Pending Job</span><span><b>{organizationDashboard.exceptions}</b> Exception</span><span>最終同期: {formatted(organizationDashboard.lastSyncedAt)}</span></div>}<div className="settings-section"><div className="settings-section-title"><CalendarDays size={17} /><strong>Automation Rules</strong></div>{organizationRules.length ? <ul>{organizationRules.map((rule) => <li key={rule.id}><strong>{rule.name}</strong> — {rule.state}</li>)}</ul> : <p>ルールはまだありません。</p>}{canManageRules && <form className="passkey-login" onSubmit={(event) => void createRule(event)}><label>新しいルール名<input value={ruleName} onChange={(event) => setRuleName(event.target.value)} required /></label><button className="secondary" disabled={ruleBusy}>{ruleBusy ? '作成中…' : '下書きルールを作成'}</button></form>}</div>{connections && <div className="settings-form"><div className="settings-section"><div className="settings-section-title"><KeyRound size={17} /><strong>LINE Messaging API</strong></div><label>チャネルアクセストークン<SecretInput label="チャネルアクセストークン" value={lineChannelAccessToken} onChange={setLineChannelAccessToken} placeholder={connections.line.channelAccessTokenConfigured ? '登録済み（変更する場合のみ入力）' : 'チャネルアクセストークン'} /></label><label>チャネルシークレット<SecretInput label="チャネルシークレット" value={lineChannelSecret} onChange={setLineChannelSecret} placeholder={connections.line.channelSecretConfigured ? '登録済み（変更する場合のみ入力）' : 'チャネルシークレット'} /></label></div><div className="settings-section"><div className="settings-section-title"><KeyRound size={17} /><strong>Gemini API</strong></div><p className="gemini-note"><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Google AI Studio で Gemini API キーを作成</a>し、ここに貼り付けてください。キーは暗号化して保存され、画面には再表示されません。</p><label>Gemini API キー<SecretInput label="Gemini API キー" value={geminiApiKey} onChange={setGeminiApiKey} placeholder={connections.ai.apiKeyConfigured ? '登録済み（変更する場合のみ入力）' : 'AIza…'} /></label><p className="gemini-status">モデル: gemini-3.5-flash-lite（自動選択）</p>{connections.ai.apiKeyConfigured && <div className="gemini-test"><label>Gemini への質問<textarea value={geminiTestPrompt} onChange={(event) => setGeminiTestPrompt(event.target.value)} maxLength={10000} /></label><button className="secondary" onClick={() => void testGeminiConnection()} disabled={geminiTestBusy}>{geminiTestBusy ? "Gemini に問い合わせ中…" : "質問して接続をテスト"}</button>{geminiTestResult && <pre>{geminiTestResult}</pre>}</div>}</div><button className="primary" onClick={() => void saveConnections()} disabled={settingsBusy || (!geminiApiKey && !connections.ai.apiKeyConfigured)}><Save size={16} />{settingsBusy ? '保存中…' : 'Gemini API キーを保存'}</button></div>}</section>}
  </section></main>;
};

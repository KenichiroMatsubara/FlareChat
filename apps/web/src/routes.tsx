import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isRouteErrorResponse, NavLink, Outlet, useLoaderData, useNavigate, useNavigation, useParams, useRevalidator, useRouteError, useSearchParams } from 'react-router-dom';

import type { AppState, AttendanceStatus, ContactPage, Preset } from '@mail/domain';

import { api } from './api';
import { setupPhaseLabel, SignedOutEntry } from './entry';
import { pendingKey, usePendingOperations } from './pending';
import { PendingOverlay } from './progress';

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
  const state = useLoaderData<AppState>();
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
  presets: Preset[];
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
  const state = useLoaderData<AppState>();
  const navigate = useNavigate();
  const [name, setName] = useState(state.kind === 'confirming_organization' ? state.setup.name : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [presets, setPresets] = useState<Preset[]>([]);
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
  const state = useLoaderData<AppState>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (failed || state.kind !== 'provisioning') return undefined;
    const timer = window.setInterval(() => void revalidator.revalidate(), 5_000);
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
    <button className="primary" type="button" onClick={() => void revalidator.revalidate()} disabled={revalidator.state !== 'idle'}>
      {revalidator.state !== 'idle' ? '再試行中…' : '再試行'}
    </button>
    <button className="quiet-button" type="button" onClick={() => void leave()} disabled={busy}>
      {busy ? 'ログアウト中…' : 'ログアウトして入口へ戻る'}
    </button>
  </SetupCard>;
};

export const LoadingRoute = () => <SetupCard><div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div></SetupCard>;

/**
 * The single-use link that first brings a Contact to its Contact Page. It is
 * the only entry: a Contact reaches it through their linked Channel Handle,
 * signs in with the identity-only Google grant, and is bound to that account.
 */
export const ContactPageJoinRoute = () => {
  const state = useLoaderData<AppState>();
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
      await api.joinContactPage(accountId, token);
      navigate('/portal', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'このリンクは使用できませんでした。');
      setBusy(false);
    }
  };
  return <SetupCard>
    <div className="setup-brand"><strong>FlareChat</strong><small>CONTACT PAGE</small></div>
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

const attendanceLabel: Record<AttendanceStatus, string> = {
  unanswered: '未回答',
  attending: '出席',
  not_attending: '欠席',
};

export interface ContactPageViewProps {
  page: ContactPage;
  running: readonly string[];
  pending: (key: string) => boolean;
  settled: (key: string) => boolean;
  error: string;
  onAttendance: (eventId: string, status: AttendanceStatus, comment: string) => void;
  onComment: (eventId: string, status: AttendanceStatus, comment: string) => void;
  onTaskCompleted: (taskId: string, completed: boolean) => void;
  onTaskRemarks: (taskId: string, remarks: string) => void;
  onLogout: () => void;
}

/** The Contact Page itself: every control reports the one answer it is sending. */
export const ContactPageView = ({ page, running, pending, settled, error, onAttendance, onComment, onTaskCompleted, onTaskRemarks, onLogout }: ContactPageViewProps) => {
  const leaving = pending(pendingKey.portalLogout);
  return <main className="portal-shell">
    <PendingOverlay running={running} />
    <header className="portal-header">
      <div><p className="eyebrow">{page.account.name}</p><h1>{page.contact.name} さんのページ</h1></div>
      <button className="quiet-button" disabled={leaving} onClick={onLogout}>{leaving ? 'ログアウト中…' : 'ログアウト'}</button>
    </header>
    {error && <p className="setup-error">{error}</p>}
    <section className="portal-section">
      <h2>出欠登録</h2>
      {page.events.length === 0 && <p className="portal-empty">登録が必要な予定はありません。</p>}
      {page.events.map((event) => {
        const answering = (status: AttendanceStatus): boolean => pending(pendingKey.portalAttendance(event.eventId, status));
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
      {page.tasks.length === 0 && <p className="portal-empty">タスクはありません。</p>}
      {page.tasks.map((task) => {
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
export const ContactPageRoute = () => {
  const [page, setPage] = useState<ContactPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const { running, pending, settled, error, run } = usePendingOperations();
  const reload = async (): Promise<void> => { setPage(await api.contactPage()); };
  useEffect(() => {
    void reload().catch((cause: unknown) => setLoadError(cause instanceof Error ? cause.message : '連絡先ページを開けませんでした。'));
  }, []);
  const answer = (key: string, work: () => Promise<unknown>): void => void run(key, async () => { await work(); await reload(); });
  if (!page) return <SetupCard>{loadError ? <p className="setup-error">{loadError}</p> : <div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div>}</SetupCard>;
  return <ContactPageView
    page={page}
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

import { CalendarDays, CheckCircle2, CircleAlert, LogOut, Mail, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from './api';
import type { AutomationStatus, AutomationSummary } from './api';

const formatted = (value: string | null): string => value
  ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'まだ実行していません';

export const App = () => {
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(new URLSearchParams(window.location.search).get('error') ?? '');
  const refresh = async () => {
    try { setAutomation(await api.currentAutomation()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '状態を取得できませんでした。'); }
  };
  useEffect(() => { void refresh(); if (window.location.search) window.history.replaceState({}, '', window.location.pathname); }, []);
  const login = async () => {
    setBusy(true); setError('');
    try { window.location.assign((await api.googleLogin()).authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Google ログインを開始できませんでした。'); setBusy(false); }
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
  const logout = async () => {
    setBusy(true);
    try { await api.logout(); setAutomation(null); setSummary(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'ログアウトできませんでした。'); }
    finally { setBusy(false); }
  };
  if (!automation) return <main className="setup-shell"><section className="setup-card login-card">
    <div className="setup-brand"><span><Mail size={22} /></span><div><strong>Mail Automation</strong><small>GMAIL TO CALENDAR</small></div></div>
    <p className="eyebrow">START WITH GOOGLE</p><h1>メールを予定にする</h1>
    <p className="setup-copy">Googleでログインすると、Gmailの新着メールを読み取り、日付と開始・終了時刻が書かれた案内をあなたのGoogleカレンダーへ自動登録します。</p>
    {error && <p className="setup-error">{error}</p>}
    <button className="primary google-login" onClick={() => void login()} disabled={busy}><ShieldCheck size={18} />{busy ? 'Googleへ接続中…' : 'Googleでログインして始める'}</button>
    <p className="login-note">初回のみ、Gmailの読取とGoogle Calendarへの予定作成を許可します。組織名やパスキーの入力は不要です。</p>
  </section></main>;
  return <main className="setup-shell"><section className="setup-card dashboard-card">
    <div className="dashboard-top"><div className="setup-brand"><span><Mail size={22} /></span><div><strong>Mail Automation</strong><small>GMAIL TO CALENDAR</small></div></div><button className="quiet-button" onClick={() => void logout()} disabled={busy}><LogOut size={15} />ログアウト</button></div>
    <p className="eyebrow">GOOGLE AUTOMATION</p><h1>自動化は{automation.enabled ? '有効です' : '停止中です'}</h1>
    <p className="setup-copy"><strong>{automation.displayName}</strong>（{automation.email}）の Gmail と primary Calendar を接続しています。</p>
    {error && <p className="setup-error">{error}</p>}{automation.lastError && <p className="setup-error"><CircleAlert size={16} />{automation.lastError}</p>}
    <div className="automation-status"><span className={automation.enabled ? 'status-dot active' : 'status-dot'} /><div><strong>{automation.enabled ? '新着メールを自動確認します' : '自動確認を停止しています'}</strong><small>前回の確認: {formatted(automation.lastSyncedAt)}</small></div><label className="switch"><input type="checkbox" checked={automation.enabled} onChange={(event) => void setEnabled(event.target.checked)} disabled={busy} /><span /></label></div>
    <button className="primary google-login" onClick={() => void run()} disabled={busy || !automation.enabled}>{busy ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}{busy ? '新着メールを確認中…' : '今すぐ新着メールを確認'}</button>
    {summary && <div className="run-result"><CheckCircle2 size={18} /><span>今回: {summary.created}件を予定化、{summary.skipped}件を保留、{summary.exceptions}件でエラー</span></div>}
    <div className="automation-guide"><CalendarDays size={19} /><div><strong>予定として認識する書式</strong><p>メールの件名または本文に <code>2026/08/03 19:00-21:00</code> または <code>2026年8月3日 19:00〜21:00</code> のように、日付と開始・終了時刻を含めてください。</p></div></div>
    <div className="automation-counts"><span><b>{automation.created}</b> 予定を作成</span><span><b>{automation.skipped}</b> 書式不足</span><span><b>{automation.exceptions}</b> エラー</span></div>
  </section></main>;
};

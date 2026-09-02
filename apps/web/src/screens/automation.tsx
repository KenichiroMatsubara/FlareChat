import { CalendarDays, CheckCircle2, CircleAlert, Mail, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { AutomationStatus, AutomationSummary, GuestRegistrationRoster } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, GoogleReauthenticationAction, useAccount } from '../dashboard';
import { formatted, OperationError } from '../parts';
import { pendingKey, usePendingOperations } from '../pending';
import { PendingOverlay } from '../progress';

export interface AutomationData {
  automation: AutomationStatus | null;
  guestRegistrations: GuestRegistrationRoster[];
}

export const loader = async (args: LoaderFunctionArgs): Promise<AutomationData> => {
  const accountId = accountIdOf(args);
  const [automation, guestRegistrations] = await Promise.all([
    api.currentAutomation(accountId),
    api.guestRegistrations(accountId),
  ]);
  return { automation, guestRegistrations };
};

/**
 * The Guest Registrations returned against a Scheduled Event. Names are shown
 * here and nowhere else: the Calendar description every invited Contact reads
 * carries the counts by Affiliation alone.
 */
const GuestRegistrations = ({ rosters }: { rosters: readonly GuestRegistrationRoster[] }) => {
  if (!rosters.length) return null;
  return <section className="guest-registrations">
    <h2>外部からの参加登録</h2>
    <p>他団体から返送された登録用紙の参加者です。Google Calendar の説明には人数だけを書き、氏名はこの画面にのみ表示します。</p>
    {rosters.map((roster) => <article key={roster.eventId}>
      <h3>{roster.title}<small>{formatted(roster.startsAt)}</small></h3>
      <p className="guest-total">{roster.affiliations.length}団体 {roster.attendingCount}名{roster.affiliations.length ? `（${roster.affiliations.map((entry) => `${entry.affiliation} ${entry.attending}名`).join('、')}）` : ''}</p>
      <ul>{roster.guests.map((guest) => <li key={`${guest.affiliation}-${guest.name}`} className={guest.attending ? '' : 'guest-absent'}>{guest.name}<small>{guest.affiliation || '所属未記載'}</small>{guest.attending ? '' : <span>欠席</span>}</li>)}</ul>
    </article>)}
  </section>;
};

/** The Automation Inbox: whether it runs, a way to run it now, and what it did. */
const AutomationScreen = () => {
  const { automation, guestRegistrations } = useLoaderData<AutomationData>();
  const { account, reauthenticate, reauthenticating } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const accountId = account.accountId;
  const running = operations.pending(pendingKey.automationRun);
  const toggling = operations.pending(pendingKey.automationEnabled);
  const runNow = (): void => void operations.run(pendingKey.automationRun, async () => {
    setSummary(await api.runAutomation(accountId));
    await revalidator.revalidate();
  });
  const setEnabled = (enabled: boolean): void => void operations.run(pendingKey.automationEnabled, async () => {
    await api.setEnabled(accountId, enabled);
    await revalidator.revalidate();
  });
  return <section className="page-layout automation-page">
    <PendingOverlay running={operations.running} />
    <OperationError error={operations.error} />
    <div className="page-title"><p>GMAIL TO CALENDAR</p><h1>自動化</h1><span>{automation ? `${automation.email} の Gmail と primary Calendar を接続中` : 'Googleアカウントを接続してください'}</span></div>
    {automation?.status === 'reauthentication_required' && <div className="dashboard-error"><p><CircleAlert size={17} />Automation Inbox の認証が失効しています。Google に再接続してください。</p><GoogleReauthenticationAction onClick={reauthenticate} busy={reauthenticating} /></div>}
    {automation ? <>
      <section className="hero-status"><div><span className={automation.enabled ? 'status-light on' : 'status-light'} /><p>{automation.enabled ? '自動化は有効です' : '自動化は停止中です'}</p><small>前回の確認: {formatted(automation.lastSyncedAt)}</small></div><div className="hero-switch">{toggling && <small className="field-state saving"><RefreshCw className="spin" size={12} />切替中…</small>}<label className="switch"><input type="checkbox" aria-label="自動化を切り替える" checked={automation.enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={toggling} /><span /></label></div></section>
      <section className="action-panel"><div><h2>メールを今すぐ確認</h2><p>送信済み・プロモーション・カレンダー通知は BYOK AI へ送らず、残りの新着メールだけを AI が判定します。Gmail の状態は変更しません。</p></div><button className="primary" onClick={runNow} disabled={running || toggling || !automation.enabled}>{running ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}{running ? 'メールを確認中…（完了までこのページを開いたままにしてください）' : '今すぐ確認'}</button></section>
      {automation.failingSince && automation.status === 'active' && <p className="dashboard-error"><CircleAlert size={17} />{formatted(automation.failingSince)}から自動処理に失敗しています。復旧すると自動的に再開します。{automation.lastError ? `（${automation.lastError}）` : ''}</p>}
      {summary && <p className="dashboard-success"><CheckCircle2 size={17} />今回: {summary.scanned}件をAI判定、{summary.created}件を予定化、{summary.skipped}件を対象外、{summary.exceptions}件でエラー</p>}
      <section className="metrics-row"><div><b>{automation.created}</b><span>予定を作成</span></div><div><b>{automation.skipped}</b><span>処理対象外</span></div><div><b>{automation.exceptions}</b><span>エラー</span></div></section>
      <section className="info-panel"><CalendarDays size={20} /><div><strong>AI がメール内容を判定します</strong><p>固定の日付書式は不要です。本文や添付ファイルから予定、タスク、お知らせを抽出します。</p></div></section>
      <GuestRegistrations rosters={guestRegistrations} />
    </> : <section className="empty-page"><Mail size={30} /><h2>Googleアカウントを接続してください</h2><p>接続後、このページから自動化を操作できます。</p></section>}
  </section>;
};

export default AutomationScreen;

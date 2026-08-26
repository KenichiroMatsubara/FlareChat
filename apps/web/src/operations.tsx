import { useEffect, useState } from 'react';

import { CircleAlert, CircleCheck, RefreshCw, ShieldAlert, SlidersHorizontal } from 'lucide-react';

import { api, type AutomationWarningRecord, type OperationException, type StuckJobRecord } from './api';
import { DeliveryAudit, MailTestFlow, MailboxRefreshSections } from './dashboard-pages';
import type { DashboardProps } from './dashboard';

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const EXCEPTION_LABELS: Record<string, string> = {
  ai_connection_missing: 'AI 接続が未設定',
  ai_event_details_invalid: 'AI が安全な抽出を返さなかった',
  drive_attachment_publish_failed: '添付ファイルを公開できなかった',
  gmail_attachment_download_failed: '添付ファイルを取得できなかった',
  source_attachment_conversion_failed: '添付ファイルを変換できなかった',
};

const JOB_STATE_LABELS: Record<string, string> = {
  running: '取り残されています（再実行されません）',
  failed: '再試行を使い切りました',
};

/**
 * Everything that went wrong, in one place (ADR 0167).
 *
 * These records all existed behind routes and none of them had a screen, so the
 * only way to learn that an Account had open Exceptions or Jobs nothing would
 * ever retry was to query its database.
 */
export const OperationsPage = (props: DashboardProps) => {
  const accountId = props.accountId ?? '';
  const [exceptions, setExceptions] = useState<OperationException[]>([]);
  const [warnings, setWarnings] = useState<AutomationWarningRecord[]>([]);
  const [jobs, setJobs] = useState<StuckJobRecord[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [suspending, setSuspending] = useState(false);

  const reload = (): void => {
    if (!accountId) return;
    Promise.all([api.operationExceptions(accountId), api.automationWarnings(accountId), api.stuckJobs(accountId)])
      .then(([loadedExceptions, loadedWarnings, loadedJobs]) => {
        setExceptions(loadedExceptions);
        setWarnings(loadedWarnings);
        setJobs(loadedJobs);
      })
      .catch((cause: unknown) => setError(errorText(cause, '運用状況を取得できませんでした。')));
  };

  useEffect(reload, [accountId]);

  const resolve = async (id: string): Promise<void> => {
    setBusy(id);
    setError('');
    try {
      await api.resolveOperationException(accountId, id);
      reload();
    } catch (cause) {
      setError(errorText(cause, '例外を解決済みにできませんでした。'));
    } finally {
      setBusy('');
    }
  };

  const suspend = async (suspended: boolean): Promise<void> => {
    setSuspending(true);
    setError('');
    try {
      await api.setAccountSuspension(accountId, suspended);
    } catch (cause) {
      setError(errorText(cause, 'Account の状態を変更できませんでした。'));
    } finally {
      setSuspending(false);
    }
  };

  const open = exceptions.filter((entry) => entry.state === 'open');
  return <section className="page-layout rules-page">
    <div className="page-title"><p>OPERATIONS</p><h1>運用</h1><span>うまくいかなかったことと、放っておくと止まったままになるものです。</span></div>
    {error && <p className="dashboard-error"><CircleAlert size={17} />{error}</p>}

    <section className="rules-list">
      <div className="rules-list-title"><h2>未解決の例外</h2><span>{open.length}件</span></div>
      {open.length ? open.map((entry) => <article className="rule-row" key={entry.id}>
        <div>
          <strong>{EXCEPTION_LABELS[entry.code] ?? entry.code}</strong>
          <small>{entry.message}</small>
          <small>{entry.createdAt}</small>
        </div>
        <button type="button" className="secondary" disabled={busy === entry.id} onClick={() => void resolve(entry.id)}>
          {busy === entry.id ? <><RefreshCw className="spin" size={13} />処理中…</> : '解決済みにする'}
        </button>
      </article>) : <p className="rules-empty"><CircleCheck size={14} /> 未解決の例外はありません。</p>}
    </section>

    <section className="rules-list">
      <div className="rules-list-title"><h2>取り残された処理</h2><span>{jobs.length}件</span></div>
      {jobs.length ? jobs.map((job) => <article className="rule-row" key={job.id}>
        <div>
          <strong>{job.kind}</strong>
          <small>{JOB_STATE_LABELS[job.state] ?? job.state} ・ 試行 {job.attempts} 回 ・ {job.updatedAt}</small>
          {job.lastError && <small className="rule-row-warning"><CircleAlert size={12} />{job.lastError}</small>}
        </div>
      </article>) : <p className="rules-empty"><CircleCheck size={14} /> 取り残された処理はありません。</p>}
    </section>

    <section className="rules-list">
      <div className="rules-list-title"><h2>抽出時の警告</h2><span>{warnings.length}件</span></div>
      {warnings.length ? warnings.map((warning) => <article className="rule-row" key={warning.id}>
        <div><strong>{warning.code}</strong><small>{warning.message}</small><small>{warning.createdAt}</small></div>
      </article>) : <p className="rules-empty"><CircleCheck size={14} /> 警告はありません。</p>}
    </section>

    <DeliveryAudit audit={props.audit} />

    <section className="settings-card">
      <div className="settings-card-title"><SlidersHorizontal size={19} /><div>
        <h2>予定の再同期</h2>
        <p>Calendar の手動変更を上書きし得るため、通常のルール実行とは分けた管理操作です。</p>
      </div></div>
      <p className="api-guide">対象のメールをここで探し、本番と同じ経路で抽出したうえで、既存の予定との差分を確認します。</p>
    </section>
    <MailTestFlow props={props} />
    {props.mailTestPreview && <MailboxRefreshSections {...props} />}

    <section className="settings-card">
      <div className="settings-card-title"><ShieldAlert size={19} /><div>
        <h2>Account を止める</h2>
        <p>停止するとメールの取り込みもリマインドも行われなくなります。</p>
      </div></div>
      <div className="settings-card-actions">
        <p className="connection-state">{suspending ? <><RefreshCw className="spin" size={13} />変更中…</> : '停止すると次のポーリングから何も処理されません'}</p>
        <button type="button" className="secondary" disabled={suspending} onClick={() => void suspend(true)}>Account を停止する</button>
        <button type="button" className="secondary" disabled={suspending} onClick={() => void suspend(false)}>停止を解除する</button>
      </div>
    </section>
  </section>;
};

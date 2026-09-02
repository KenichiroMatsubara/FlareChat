import { CircleAlert, CircleCheck, RefreshCw, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { AutomationException, AutomationStatus, AutomationWarning, Connections, Contact, DeliveryRecord, StuckJob } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { DeliveryAudit } from '../history';
import { EventRefreshSections, MailTestFlow, useMailboxTest } from '../mailbox';
import { OperationError } from '../parts';
import { pendingKey, usePendingOperations } from '../pending';
import { PendingOverlay } from '../progress';

export interface OperationsData {
  exceptions: AutomationException[];
  warnings: AutomationWarning[];
  jobs: StuckJob[];
  deliveries: DeliveryRecord[];
  automation: AutomationStatus | null;
  connections: Connections;
  contacts: Contact[];
}

export const loader = async (args: LoaderFunctionArgs): Promise<OperationsData> => {
  const accountId = accountIdOf(args);
  const [exceptions, warnings, jobs, deliveries, automation, connections, contacts] = await Promise.all([
    api.exceptions(accountId),
    api.warnings(accountId),
    api.stuckJobs(accountId),
    api.deliveries(accountId),
    api.currentAutomation(accountId),
    api.connections(accountId),
    api.contacts(accountId),
  ]);
  return { exceptions, warnings, jobs, deliveries, automation, connections, contacts };
};

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
 * Everything that went wrong, in one place (ADR 0167): exceptions, warnings,
 * the delivery audit, stuck Jobs, Account suspension, and the Event Refresh,
 * which finds its own message here rather than depending on another screen.
 */
const OperationsScreen = () => {
  const data = useLoaderData<OperationsData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const test = useMailboxTest(accountId, operations);
  const suspending = operations.pending(pendingKey.accountSuspension);
  const open = data.exceptions.filter((entry) => entry.state === 'open');

  const resolve = (id: string): void => void operations.run(pendingKey.exceptionResolve(id), async () => {
    await api.resolveException(accountId, id);
    await revalidator.revalidate();
  });
  const suspend = (suspended: boolean): void => void operations.run(pendingKey.accountSuspension, async () => {
    await api.setSuspension(accountId, suspended);
  });

  return <section className="page-layout rules-page">
    <PendingOverlay running={operations.running} />
    <OperationError error={operations.error} />
    <div className="page-title"><p>OPERATIONS</p><h1>運用</h1><span>うまくいかなかったことと、放っておくと止まったままになるものです。</span></div>

    <section className="rules-list">
      <div className="rules-list-title"><h2>未解決の例外</h2><span>{open.length}件</span></div>
      {open.length ? open.map((entry) => <article className="rule-row" key={entry.id}>
        <div>
          <strong>{EXCEPTION_LABELS[entry.code] ?? entry.code}</strong>
          <small>{entry.message}</small>
          <small>{entry.createdAt}</small>
        </div>
        <button type="button" className="secondary" disabled={operations.pending(pendingKey.exceptionResolve(entry.id))} onClick={() => resolve(entry.id)}>
          {operations.pending(pendingKey.exceptionResolve(entry.id)) ? <><RefreshCw className="spin" size={13} />処理中…</> : '解決済みにする'}
        </button>
      </article>) : <p className="rules-empty"><CircleCheck size={14} /> 未解決の例外はありません。</p>}
    </section>

    <section className="rules-list">
      <div className="rules-list-title"><h2>取り残された処理</h2><span>{data.jobs.length}件</span></div>
      {data.jobs.length ? data.jobs.map((job) => <article className="rule-row" key={job.id}>
        <div>
          <strong>{job.kind}</strong>
          <small>{JOB_STATE_LABELS[job.state] ?? job.state} ・ 試行 {job.attempts} 回 ・ {job.updatedAt}</small>
          {job.lastError && <small className="rule-row-warning"><CircleAlert size={12} />{job.lastError}</small>}
        </div>
      </article>) : <p className="rules-empty"><CircleCheck size={14} /> 取り残された処理はありません。</p>}
    </section>

    <section className="rules-list">
      <div className="rules-list-title"><h2>抽出時の警告</h2><span>{data.warnings.length}件</span></div>
      {data.warnings.length ? data.warnings.map((warning) => <article className="rule-row" key={warning.id}>
        <div><strong>{warning.code}</strong><small>{warning.message}</small><small>{warning.createdAt}</small></div>
      </article>) : <p className="rules-empty"><CircleCheck size={14} /> 警告はありません。</p>}
    </section>

    <DeliveryAudit deliveries={data.deliveries} />

    <section className="settings-card">
      <div className="settings-card-title"><SlidersHorizontal size={19} /><div>
        <h2>予定の再同期</h2>
        <p>Calendar の手動変更を上書きし得るため、通常のルール実行とは分けた管理操作です。</p>
      </div></div>
      <p className="api-guide">対象のメールをここで探し、本番と同じ経路で抽出したうえで、既存の予定との差分を確認します。</p>
    </section>
    <MailTestFlow
      test={test}
      pending={operations.pending}
      connected={Boolean(data.automation)}
      aiConfigured={data.connections.ai.apiKeyConfigured}
      assigneeName={(contactId) => data.contacts.find((contact) => contact.id === contactId)?.name ?? '未割り当て'}
    />
    <EventRefreshSections test={test} pending={operations.pending} />

    <section className="settings-card">
      <div className="settings-card-title"><ShieldAlert size={19} /><div>
        <h2>Account を止める</h2>
        <p>停止するとメールの取り込みもリマインドも行われなくなります。</p>
      </div></div>
      <div className="settings-card-actions">
        <p className="connection-state">{suspending ? <><RefreshCw className="spin" size={13} />変更中…</> : '停止すると次のポーリングから何も処理されません'}</p>
        <button type="button" className="secondary" disabled={suspending} onClick={() => suspend(true)}>Account を停止する</button>
        <button type="button" className="secondary" disabled={suspending} onClick={() => suspend(false)}>停止を解除する</button>
      </div>
    </section>
  </section>;
};

export default OperationsScreen;

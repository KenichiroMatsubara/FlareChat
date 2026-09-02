import type { DeliveryRecord, RuleEffect, RuleRun } from '@mail/domain';

import { formatted } from './parts';
import { pendingKey } from './pending';

const ruleRunStatusLabel = (status: RuleRun['status']): string => ({
  planning: '計画中',
  read_only: '確認のみ',
  pending_approval: '承認待ち',
  applying: '実行中',
  completed: '完了',
  rejected: '却下',
  expired: '期限切れ',
  failed: '失敗',
})[status];

const ruleEffectStatusLabel = (status: RuleEffect['status']): string => ({
  planned: '実行せず記録',
  pending: '承認待ち',
  applying: '実行中',
  succeeded: '成功',
  transient_failed: '再試行待ち',
  permanent_failed: '失敗',
  blocked: '前の処理を待機',
  rejected: '却下',
  expired: '期限切れ',
})[status];

const ruleEffectKindLabel = (kind: string): string => ({
  'schema.record_warnings': '抽出時の注意を記録',
  'schema.deliver_summary': '要約と予定・タスクを配信',
  'schema.create_tasks': '期限タスクを作成',
  'schema.apply_events': '予定を作成・更新',
  'agent.send_line_message': 'LINEメッセージを送信',
  'agent.create_scheduled_event': '予定を作成',
  'agent.send_email_summary': '要約メールを送信',
  'calendar.create': '予定を作成',
  'drive.publish': '添付ファイルをDriveへ保存',
  'task.create': '期限タスクを作成',
})[kind] ?? kind;

const recordValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const textValue = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

const present = (values: Array<string | null>): string[] => values.filter((value): value is string => Boolean(value));

export const ruleEffectDetails = (effect: RuleEffect): string[] => {
  const arguments_ = effect.arguments;
  if (effect.kind === 'agent.send_line_message') {
    return present([
      textValue(arguments_.destination) ? `送信先: ${String(arguments_.destination)}` : null,
      textValue(arguments_.message) ? `内容: ${String(arguments_.message)}` : null,
    ]);
  }
  if (effect.kind === 'agent.send_email_summary') {
    return present([
      textValue(arguments_.destination) ? `送信先: ${String(arguments_.destination)}` : null,
      textValue(arguments_.subject) ? `件名: ${String(arguments_.subject)}` : null,
      textValue(arguments_.body) ? `内容: ${String(arguments_.body)}` : null,
    ]);
  }
  if (effect.kind === 'agent.create_scheduled_event' || effect.kind === 'calendar.create') {
    return present([
      textValue(arguments_.title) ? `予定: ${String(arguments_.title)}` : null,
      textValue(arguments_.startsAt) ? `開始: ${formatted(String(arguments_.startsAt))}` : null,
      textValue(arguments_.destination) ? `追加先: ${String(arguments_.destination)}` : null,
    ]);
  }
  if (effect.kind === 'task.create') return present([textValue(arguments_.title) ? `タスク: ${String(arguments_.title)}` : null]);
  const extraction = recordValue(arguments_.extraction);
  if (!extraction) return [];
  if (effect.kind === 'schema.deliver_summary') {
    const summary = textValue(extraction.summary);
    return summary ? [`要約: ${summary}`] : [];
  }
  if (effect.kind === 'schema.create_tasks' && Array.isArray(extraction.tasks)) {
    return extraction.tasks.flatMap((value) => {
      const task = recordValue(value);
      if (!task) return [];
      const title = textValue(task.title) ?? '名称のないタスク';
      const deadline = textValue(task.deadline);
      return [`タスク: ${title}${deadline ? `（期限 ${deadline}）` : ''}`];
    });
  }
  if (effect.kind === 'schema.apply_events' && Array.isArray(extraction.events)) {
    return extraction.events.flatMap((value) => {
      const event = recordValue(value);
      if (!event) return [];
      const title = textValue(event.title) ?? '名称のない予定';
      const startsAt = textValue(event.startsAt);
      return [`予定: ${title}${startsAt ? `（${formatted(startsAt)}）` : ''}`];
    });
  }
  if (effect.kind === 'schema.record_warnings' && Array.isArray(extraction.warnings)) {
    return extraction.warnings.map((warning) => textValue(warning) ?? JSON.stringify(warning));
  }
  return [];
};

/**
 * What a Rule planned and what became of it, with the approval where the plan
 * is: approving a run belongs on the Rule that planned it (ADR 0167).
 */
export const RuleRunHistory = ({ runs, ruleName, heading, pending, onDecide }: {
  runs: readonly RuleRun[];
  ruleName: (run: RuleRun) => string;
  heading: string;
  pending: (key: string) => boolean;
  onDecide: (runId: string, decision: 'approve' | 'reject') => void;
}) => <section className="rules-list">
  <div className="rules-list-title"><h2>{heading}</h2><span>{runs.length}件</span></div>
  {runs.length ? runs.map((run) => {
    const name = ruleName(run);
    const deciding = pending(pendingKey.ruleRunDecision(run.id, 'approve')) || pending(pendingKey.ruleRunDecision(run.id, 'reject'));
    return <details className="rule-run-detail" key={run.id} aria-busy={deciding}>
      <summary>
        <div className="rule-run-source">
          <strong>{run.sourceMessage.subject || '件名なし'}</strong>
          <small>{run.sourceMessage.sender || '差出人なし'} ・ {formatted(run.sourceMessage.receivedAt)}</small>
          <span>{name} ・ {ruleRunStatusLabel(run.status)}</span>
        </div>
        <span className={`rule-run-status ${run.status}`}>{ruleRunStatusLabel(run.status)}</span>
        <span className="rule-run-disclosure"><span className="when-closed">詳細を見る</span><span className="when-open">詳細を閉じる</span></span>
      </summary>
      <div className="rule-run-body">
        <dl className="rule-run-metadata">
          <div><dt>処理したメール</dt><dd>{run.sourceMessage.subject || '件名なし'}</dd></div>
          <div><dt>差出人</dt><dd>{run.sourceMessage.sender || '差出人なし'}</dd></div>
          <div><dt>受信日時</dt><dd>{formatted(run.sourceMessage.receivedAt)}</dd></div>
          <div><dt>使用したルール</dt><dd>{name}（第{run.rule.revision}版）</dd></div>
          <div><dt>処理方法</dt><dd>{run.intent === 'draft_preview' ? 'Draftルールの確認' : '自動メール処理'} ・ {run.executionMode === 'read_only' ? '確認のみ' : run.executionMode === 'approval' ? '承認後に実行' : '自動実行'}</dd></div>
        </dl>
        <section className="rule-run-effects">
          <h3>実行内容</h3>
          {run.effects.length ? run.effects.map((effect) => {
            const details = ruleEffectDetails(effect);
            return <article key={effect.id}>
              <div><strong>{ruleEffectKindLabel(effect.kind)}</strong><span>{ruleEffectStatusLabel(effect.status)}</span></div>
              {details.map((detail, index) => <p key={`${effect.id}-${index}`}>{detail}</p>)}
              {effect.error && <p className="dashboard-error">エラー: {effect.error}</p>}
            </article>;
          }) : <p>この処理で作成・送信する内容はありませんでした。</p>}
        </section>
        {run.status === 'pending_approval' && <div className="rule-run-actions"><button className="primary" disabled={deciding} onClick={() => onDecide(run.id, 'approve')}>すべて承認して実行</button><button className="secondary" disabled={deciding} onClick={() => onDecide(run.id, 'reject')}>すべて却下</button></div>}
      </div>
    </details>;
  }) : <p className="rules-empty">まだ実行履歴はありません。</p>}
</section>;

const DELIVERY_CHANNEL_LABELS: Record<string, string> = {
  line: 'LINE', discord: 'Discord', email: 'メール', calendar: 'Calendar', drive: 'Drive',
};

const DELIVERY_OUTCOME_LABELS: Record<string, string> = {
  succeeded: '成功', failed: '失敗', pending: '保留',
};

/** What actually left the product, which nothing rendered before ADR 0167. */
export const DeliveryAudit = ({ deliveries }: { deliveries: readonly DeliveryRecord[] }) => <section className="rules-list">
  <div className="rules-list-title"><h2>送信履歴</h2><span>{deliveries.length}件</span></div>
  {deliveries.length ? <div className="audit-table-scroll"><table className="audit-table">
    <thead><tr><th>日時</th><th>チャネル</th><th>宛先</th><th>結果</th></tr></thead>
    <tbody>{deliveries.map((row) => <tr key={row.id}>
      <td>{formatted(row.createdAt)}</td>
      <td>{DELIVERY_CHANNEL_LABELS[row.channel] ?? row.channel}</td>
      <td className="audit-destination">{row.destination}</td>
      <td><span className={`delivery-outcome ${row.outcome}`}>{DELIVERY_OUTCOME_LABELS[row.outcome] ?? row.outcome}</span></td>
    </tr>)}</tbody>
  </table></div> : <p className="rules-empty">まだ送信履歴はありません。</p>}
</section>;

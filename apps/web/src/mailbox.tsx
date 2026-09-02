import { CheckCircle2, Copy, Mail, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { EventRefreshOutcome, EventRefreshPlan, EventRefreshRequest, MailboxTestAiRequest, MailboxTestMatch, MailboxTestPreview, SchemaRule } from '@mail/domain';

import { api } from './api';
import { formatted, useCopied } from './parts';
import { pendingKey, type PendingOperations } from './pending';

export const DEFAULT_MAIL_TEST_SUBJECT = '名古屋名城RAC30周年記念式典のご案内';

/**
 * One Mailbox Test in progress (ADR 0136): a message found by subject, the
 * request built for it, what the AI read back, and what was written from it.
 * A screen holds one of these; the flow below renders it.
 */
export interface MailboxTest {
  subject: string;
  setSubject: (value: string) => void;
  matches: MailboxTestMatch[];
  aiRequest: MailboxTestAiRequest | null;
  preview: MailboxTestPreview | null;
  draftPreview: MailboxTestPreview | null;
  createdEventIds: string[];
  ruleRunIds: string[];
  refreshRequest: EventRefreshRequest | null;
  refreshPlan: EventRefreshPlan | null;
  refreshOutcome: EventRefreshOutcome | null;
  search: () => void;
  prepare: (messageId: string) => void;
  extract: (messageId: string) => void;
  extractDraft: (messageId: string, ruleId: string) => void;
  createEvents: () => void;
  startDraftRuleRun: (ruleId: string) => void;
  prepareRefresh: () => void;
  planRefresh: () => void;
  applyRefresh: (candidateIndexes: number[]) => void;
}

export const useMailboxTest = (accountId: string, operations: PendingOperations, afterRuleRun?: () => Promise<void>): MailboxTest => {
  const [subject, setSubject] = useState(DEFAULT_MAIL_TEST_SUBJECT);
  const [matches, setMatches] = useState<MailboxTestMatch[]>([]);
  const [aiRequest, setAiRequest] = useState<MailboxTestAiRequest | null>(null);
  const [preview, setPreview] = useState<MailboxTestPreview | null>(null);
  const [draftPreview, setDraftPreview] = useState<MailboxTestPreview | null>(null);
  const [createdEventIds, setCreatedEventIds] = useState<string[]>([]);
  const [ruleRunIds, setRuleRunIds] = useState<string[]>([]);
  const [refreshRequest, setRefreshRequest] = useState<EventRefreshRequest | null>(null);
  const [refreshPlan, setRefreshPlan] = useState<EventRefreshPlan | null>(null);
  const [refreshOutcome, setRefreshOutcome] = useState<EventRefreshOutcome | null>(null);
  const { run } = operations;
  const reset = (): void => {
    setAiRequest(null);
    setPreview(null);
    setDraftPreview(null);
    setCreatedEventIds([]);
    setRuleRunIds([]);
  };
  const search = (): void => void run(pendingKey.mailSearch, async () => {
    reset();
    setMatches((await api.searchMailbox(accountId, subject.trim())).messages);
  });
  const prepare = (messageId: string): void => void run(pendingKey.mailPrepare(messageId), async () => {
    reset();
    setAiRequest(await api.prepareMailboxAiRequest(accountId, messageId));
  });
  const extract = (messageId: string): void => void run(pendingKey.mailPreview, async () => {
    if (aiRequest?.id !== messageId) throw new Error('先に AI への送信内容を確認してください。');
    setPreview(await api.previewMailboxEvents(accountId, messageId));
    setCreatedEventIds([]);
  });
  const extractDraft = (messageId: string, ruleId: string): void => void run(pendingKey.mailPreview, async () => {
    if (aiRequest?.id !== messageId) throw new Error('先に AI への送信内容を確認してください。');
    setDraftPreview(await api.previewDraftRule(accountId, messageId, ruleId));
    setRuleRunIds([]);
  });
  const createEvents = (): void => void run(pendingKey.mailCreate, async () => {
    if (!preview) throw new Error('先に AI 抽出を実行してください。');
    setCreatedEventIds((await api.createMailboxEvents(accountId, preview.confirmationToken)).eventIds);
  });
  const startDraftRuleRun = (ruleId: string): void => void run(pendingKey.mailStartRuleRun, async () => {
    if (!draftPreview) throw new Error('先に AI 抽出を実行してください。');
    const ruleRun = await api.startDraftRuleRun(accountId, draftPreview.confirmationToken, ruleId);
    setRuleRunIds([ruleRun.id]);
    await afterRuleRun?.();
  });
  const prepareRefresh = (): void => void run(pendingKey.refreshPrepare, async () => {
    if (!preview) throw new Error('先に AI 抽出を実行してください。');
    setRefreshPlan(null);
    setRefreshOutcome(null);
    setRefreshRequest(await api.prepareEventRefresh(accountId, preview.id, preview.confirmationToken));
  });
  const planRefresh = (): void => void run(pendingKey.refreshPlan, async () => {
    if (!preview) throw new Error('先に AI 抽出を実行してください。');
    setRefreshOutcome(null);
    setRefreshPlan(await api.planEventRefresh(accountId, preview.id, preview.confirmationToken));
  });
  const applyRefresh = (candidateIndexes: number[]): void => void run(pendingKey.refreshApply, async () => {
    if (!refreshPlan) throw new Error('先に既存予定と照合してください。');
    const outcome = await api.applyEventRefresh(accountId, refreshPlan.confirmationToken, candidateIndexes);
    setRefreshOutcome(outcome);
    if (!outcome.confirmationToken) return;
    // A conflict leaves a newer plan behind: the same candidates against what
    // Calendar holds now, under the token that may overwrite it next time.
    setRefreshPlan({
      ...refreshPlan,
      confirmationToken: outcome.confirmationToken,
      ...(outcome.expiresAt ? { expiresAt: outcome.expiresAt } : {}),
      entries: outcome.conflicts.map((conflict) => ({
        candidateIndex: conflict.candidateIndex,
        candidate: conflict.candidate,
        target: conflict.current,
        changedFields: conflict.changedFields,
        desired: refreshPlan.entries.find((entry) => entry.candidateIndex === conflict.candidateIndex)?.desired ?? null,
      })),
    });
  });
  return { subject, setSubject, matches, aiRequest, preview, draftPreview, createdEventIds, ruleRunIds, refreshRequest, refreshPlan, refreshOutcome, search, prepare, extract, extractDraft, createEvents, startDraftRuleRun, prepareRefresh, planRefresh, applyRefresh };
};

/**
 * Finding a message and running the production extraction on it (ADR 0136, ADR 0167).
 *
 * The Rule under test is the Rule whose screen this is on. A Draft Rule saves a
 * read-only Rule Run; any other Rule offers the Calendar write, which is the only
 * step here with an effect. Without a Rule the flow serves the Event Refresh.
 */
export const MailTestFlow = ({ test, pending, connected, aiConfigured, assigneeName, rule }: {
  test: MailboxTest;
  pending: (key: string) => boolean;
  /** Whether the Automation Inbox is connected at all, without which nothing here can search. */
  connected: boolean;
  aiConfigured: boolean;
  assigneeName: (contactId: string) => string;
  rule?: SchemaRule;
}) => {
  const draft = rule?.state === 'draft';
  const searching = pending(pendingKey.mailSearch);
  const extracting = pending(pendingKey.mailPreview);
  const creating = pending(pendingKey.mailCreate);
  const startingRuleRun = pending(pendingKey.mailStartRuleRun);
  const { copied, copy } = useCopied();
  const preview = draft ? test.draftPreview : test.preview;
  const extract = (): void => {
    if (!test.aiRequest) return;
    if (draft && rule) test.extractDraft(test.aiRequest.id, rule.id);
    else test.extract(test.aiRequest.id);
  };
  if (!connected) {
    return <section className="empty-page"><Mail size={30} /><h2>動作確認を開始できません</h2><p>Automation Inbox の Google 接続を完了してください。</p></section>;
  }
  return <>
    <section className="test-card">
      <div><p>1. FIND MAIL</p><h2>件名からメールを探す</h2><span>検索とプレビューではメールを処理済みにせず、Calendar や Drive にも書き込みません。</span></div>
      <label>メール件名<input value={test.subject} onChange={(event) => test.setSubject(event.target.value)} maxLength={300} /></label>
      <button className="primary" onClick={test.search} disabled={searching}>{searching ? <><RefreshCw className="spin" size={14} />検索中…</> : 'Gmailを検索'}</button>
    </section>
    {test.matches.length > 0 && <section className="test-card">
      <div><p>2. PREPARE AI REQUEST</p><h2>AI への送信内容を確認</h2><span>対象メールを選ぶと、本番と同じ本文・添付からリクエスト本文を生成します。この時点では AI に送信しません。</span></div>
      <div className="mail-matches">{test.matches.map((message) => <button key={message.id} className="mail-match" onClick={() => test.prepare(message.id)} disabled={pending(pendingKey.mailPrepare(message.id))}><strong>{message.subject}</strong><small>{message.sender || '差出人なし'}</small>{pending(pendingKey.mailPrepare(message.id)) && <small className="field-state saving"><RefreshCw className="spin" size={12} />本文と添付を読み込み中…</small>}</button>)}</div>
    </section>}
    {test.aiRequest && <section className="test-card event-preview">
      <div className="ai-request-heading">
        <div><p>3. REVIEW OPENAI-COMPATIBLE REQUEST</p><h2>OpenAI 互換リクエスト本文</h2><span>API キーは含まれません。送信先の model を指定すれば、任意の OpenAI 互換 API で利用できます。</span></div>
        <button className={`secondary copy-request-button${copied ? ' copied' : ''}`} onClick={() => copy(JSON.stringify(test.aiRequest?.request, null, 2))} aria-live="polite">{copied ? <CheckCircle2 size={16} /> : <Copy size={16} />}{copied ? <span className="copy-feedback">コピーしました</span> : 'リクエスト全文をコピー'}</button>
      </div>
      <pre className="ai-request">{JSON.stringify(test.aiRequest.request, null, 2)}</pre>
      <div className="mail-test-actions">{aiConfigured
        ? <button className="primary" onClick={extract} disabled={extracting}>{extracting ? <><RefreshCw className="spin" size={14} />API に送信中…</> : '設定済みの API で予定を抽出'}</button>
        : <p className="dashboard-warning api-configuration-prompt"><span>OpenAI 互換 API が設定されていません</span><Link to="../connections">APIを設定する</Link></p>}</div>
    </section>}
    {preview && <section className="test-card event-preview">
      <div>
        <p>4. {draft ? 'START DRAFT RULE RUN' : 'CONFIRM CALENDAR WRITE'}</p>
        <h2>要約・予定・タスク候補を確認</h2>
        <span>{draft
          ? 'Draft Rule の Selection Policy を検証し、副作用なしの read-only Rule Run として保存します。'
          : '下の確定操作だけが Calendar と添付用 Drive に書き込みます。'}</span>
      </div>
      <h3>メールの要約</h3><p className="mail-summary">{preview.summary}</p>
      <h3>予定（{preview.events.length}件）</h3>
      {preview.events.map((event, index) => <dl key={`${event.title}-${event.startsAt}`}>
        <dt>予定 {index + 1}</dt><dd>{event.title}</dd>
        <dt>日時</dt><dd>{formatted(event.startsAt)} 〜 {formatted(event.endsAt)}</dd>
        <dt>場所</dt><dd>{event.location || '指定なし'}</dd>
        <dt>説明</dt><dd>{event.description || '指定なし'}</dd>
        <dt>要約</dt><dd>{event.summary || '指定なし'}</dd>
      </dl>)}
      <h3>期限タスク候補（{preview.tasks.length}件）</h3>
      {preview.tasks.length
        ? preview.tasks.map((task) => <dl key={`${task.assigneeContactId}-${task.deadline}-${task.title}`}>
          <dt>{assigneeName(task.assigneeContactId)}</dt><dd>{task.title}</dd>
          <dt>期限</dt><dd>{task.deadline}</dd>
          <dt>内容</dt><dd>{task.description}</dd>
        </dl>)
        : <p>明示された登録・振込期限はありません。</p>}
      {draft
        ? <>
          <button className="primary" onClick={() => rule && test.startDraftRuleRun(rule.id)} disabled={startingRuleRun || Boolean(test.ruleRunIds.length)}>{startingRuleRun ? <RefreshCw className="spin" size={14} /> : null}{test.ruleRunIds.length ? 'Draft Rule Run 作成済み' : startingRuleRun ? 'Rule Run を作成中…' : 'Draft Rule Run を開始'}</button>
          {test.ruleRunIds.length > 0 && <p className="dashboard-success"><CheckCircle2 size={17} />副作用なしの Rule Run を保存しました。</p>}
        </>
        : <>
          <button className="primary" onClick={test.createEvents} disabled={creating || !preview.events.length || Boolean(test.createdEventIds.length)}>{creating ? <RefreshCw className="spin" size={14} /> : null}{test.createdEventIds.length ? 'Calendar に作成済み' : creating ? 'Calendar に作成中…' : '確認した予定を Calendar に作成'}</button>
          {test.createdEventIds.length > 0 && <p className="dashboard-success"><CheckCircle2 size={17} />{test.createdEventIds.length}件の予定を作成しました。</p>}
        </>}
    </section>}
  </>;
};

const FIELD_LABELS: Record<string, string> = {
  title: 'タイトル',
  description: '説明',
  location: '場所',
  startsAt: '開始',
  endsAt: '終了',
  timeZone: 'タイムゾーン',
};

const ScheduledEventSummary = ({ event }: { event: { title: string; startsAt: string; endsAt: string; location: string } }) =>
  <span>{event.title}（{formatted(event.startsAt)} 〜 {formatted(event.endsAt)}{event.location ? `・${event.location}` : ''}）</span>;

/**
 * The Event Refresh exit: the Account sees, one Scheduled Event at a time,
 * exactly what the rewrite replaces before approving it.
 */
export const EventRefreshSections = ({ test, pending }: { test: MailboxTest; pending: (key: string) => boolean }) => {
  const matching = pending(pendingKey.refreshPrepare);
  const planning = pending(pendingKey.refreshPlan);
  const applying = pending(pendingKey.refreshApply);
  const plan = test.refreshPlan;
  const [selected, setSelected] = useState<number[]>([]);
  const token = plan?.confirmationToken ?? '';
  useEffect(() => {
    if (!plan) return;
    setSelected(plan.entries.filter((entry) => entry.target && entry.changedFields.length).map((entry) => entry.candidateIndex));
  }, [token]);
  if (!test.preview) return null;
  const request = test.refreshRequest;
  const outcome = test.refreshOutcome;
  const toggle = (candidateIndex: number, checked: boolean): void =>
    setSelected((current) => checked ? [...new Set([...current, candidateIndex])] : current.filter((value) => value !== candidateIndex));
  return <>
    <section className="test-card event-preview">
      <div><p>5. MATCH EXISTING EVENTS</p><h2>このメールから作られた既存予定を照合</h2><span>同じメールの出典が書かれた予定だけを探します。日時が7日以上離れている予定は更新対象になりません。</span></div>
      <button className="secondary" onClick={test.prepareRefresh} disabled={matching}>{matching ? <><RefreshCw className="spin" size={14} />Calendarを照合中…</> : '既存予定をCalendarから探す'}</button>
      {request && <>
        <p className="mail-summary">更新対象の候補 {request.existing.length}件{request.outOfWindow.length ? ` ・ 対象外（7日以上離れている）${request.outOfWindow.length}件` : ''}</p>
        {request.outOfWindow.length > 0 && <ul className="refresh-out-of-window">{request.outOfWindow.map((event) => <li key={event.id}><ScheduledEventSummary event={event} />：日時が離れているため触りません</li>)}</ul>}
        {request.request
          ? <><pre className="ai-request">{JSON.stringify(request.request, null, 2)}</pre><div className="mail-test-actions"><button className="primary" onClick={test.planRefresh} disabled={planning}>{planning ? <><RefreshCw className="spin" size={14} />API に送信中…</> : '設定済みの API で対応付けを判定'}</button></div></>
          : <p>更新できる既存予定はありません。新規作成のみ可能です。</p>}
      </>}
    </section>
    {plan && <section className="test-card event-preview">
      <div><p>6. REVIEW DIFF AND UPDATE</p><h2>差分を確認して更新</h2><span>選択した予定は参加者以外の全項目が書き換わります。手動で編集した内容も上書きされます。</span></div>
      {plan.pendingAttachments.length > 0 && <p className="dashboard-warning">添付 {plan.pendingAttachments.length}件（{plan.pendingAttachments.join('、')}）はフォルダに未配置のため、更新時に公開します。</p>}
      {plan.entries.map((entry) => <article key={entry.candidateIndex} className="refresh-entry">
        <label>
          <input type="checkbox" checked={selected.includes(entry.candidateIndex)} onChange={(event) => toggle(entry.candidateIndex, event.target.checked)} />
          <strong>{entry.candidate.title}</strong>
          <small>{entry.target ? (entry.changedFields.length ? `更新：${entry.changedFields.map((field) => FIELD_LABELS[field] ?? field).join('、')}` : '変更なし') : '新規作成'}</small>
        </label>
        {entry.target && <dl>
          <dt>現在</dt><dd><ScheduledEventSummary event={entry.target} /></dd>
          <dt>更新後</dt><dd>{entry.desired ? <ScheduledEventSummary event={entry.desired} /> : '—'}</dd>
          <dt>現在の説明</dt><dd className="refresh-description">{entry.target.description || '（なし）'}</dd>
          <dt>更新後の説明</dt><dd className="refresh-description">{entry.desired?.description || '（なし）'}</dd>
        </dl>}
      </article>)}
      {plan.unmatched.length > 0 && <><h3>対応付かなかった既存予定（{plan.unmatched.length}件）</h3><ul className="refresh-out-of-window">{plan.unmatched.map((event) => <li key={event.id}><ScheduledEventSummary event={event} />：削除も更新もしません</li>)}</ul></>}
      <button className="primary" onClick={() => test.applyRefresh(selected)} disabled={applying || !selected.length}>{applying ? <RefreshCw className="spin" size={14} /> : null}{applying ? `${selected.length}件を更新中…` : `選択した ${selected.length}件を更新`}</button>
    </section>}
    {outcome && <section className="test-card event-preview">
      <div><p>RESULT</p><h2>更新結果</h2><span>成功した予定は取り消されません。</span></div>
      {outcome.updated.length > 0 && <p className="dashboard-success"><CheckCircle2 size={17} />{outcome.updated.length}件を更新しました。</p>}
      {outcome.created.length > 0 && <p className="dashboard-success"><CheckCircle2 size={17} />{outcome.created.length}件を新規作成しました。</p>}
      {outcome.conflicts.length > 0 && <><p className="dashboard-warning">{outcome.conflicts.length}件は照合後に Calendar 側が変更されたため更新していません。上の差分は最新の内容に更新されました。もう一度押すと、その内容を上書きします。</p><ul className="refresh-out-of-window">{outcome.conflicts.map((conflict) => <li key={conflict.googleEventId}><ScheduledEventSummary event={conflict.current} /></li>)}</ul></>}
      {outcome.failures.length > 0 && <ul className="refresh-out-of-window">{outcome.failures.map((failedEntry) => <li key={`${failedEntry.googleEventId ?? 'new'}-${failedEntry.title}`}>{failedEntry.title}：{failedEntry.message}</li>)}</ul>}
    </section>}
  </>;
};

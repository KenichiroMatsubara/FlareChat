import { CalendarDays, CheckCircle2, Copy, Eye, EyeOff, Mail, Play, RefreshCw, Save, Settings, SlidersHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';

import type { DashboardProps } from './dashboard';

const formatted = (value: string | null): string => value
  ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'まだ実行していません';

const SecretInput = ({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder: string }) => {
  const [revealed, setRevealed] = useState(false);
  return <div className="dashboard-secret"><input type="text" className={revealed ? '' : 'dashboard-secret-masked'} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} autoComplete="off" autoCapitalize="none" spellCheck={false} data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" /><button type="button" onClick={() => setRevealed((current) => !current)} aria-label={revealed ? `${label}を隠す` : `${label}を表示`}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>;
};

export const AutomationPage = (props: DashboardProps) => <section className="page-layout automation-page">
  <div className="page-title"><p>GMAIL TO CALENDAR</p><h1>自動化</h1><span>{props.automation ? `${props.automation.email} の Gmail と primary Calendar を接続中` : 'Googleアカウントを接続してください'}</span></div>
  {props.automation ? <>
    <section className="hero-status"><div><span className={props.automation.enabled ? 'status-light on' : 'status-light'} /><p>{props.automation.enabled ? '自動化は有効です' : '自動化は停止中です'}</p><small>前回の確認: {formatted(props.automation.lastSyncedAt)}</small></div><label className="switch"><input type="checkbox" checked={props.automation.enabled} onChange={(event) => props.onSetEnabled(event.target.checked)} disabled={props.busy} /><span /></label></section>
    <section className="action-panel"><div><h2>メールを今すぐ確認</h2><p>新着メールだけを確認し、予定として認識できる内容を Calendar に登録します。</p></div><button className="primary" onClick={props.onRun} disabled={props.busy || !props.automation.enabled}>{props.busy ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}{props.busy ? '確認中…' : '今すぐ確認'}</button></section>
    {props.summary && <p className="dashboard-success"><CheckCircle2 size={17} />今回: {props.summary.created}件を予定化、{props.summary.skipped}件を保留、{props.summary.exceptions}件でエラー</p>}
    <section className="metrics-row"><div><b>{props.automation.created}</b><span>予定を作成</span></div><div><b>{props.automation.skipped}</b><span>書式不足</span></div><div><b>{props.automation.exceptions}</b><span>エラー</span></div></section>
    <section className="info-panel"><CalendarDays size={20} /><div><strong>予定として認識する書式</strong><p>件名または本文に <code>2026/08/03 19:00-21:00</code> のような日付と開始・終了時刻を含めてください。</p></div></section>
  </> : <section className="empty-page"><Mail size={30} /><h2>Googleアカウントを接続してください</h2><p>接続後、このページから自動化を操作できます。</p></section>}
</section>;

export const TasksPage = (props: DashboardProps) => {
  const [assignee, setAssignee] = useState('');
  const [event, setEvent] = useState('');
  const assignees = [...new Map(props.organizationTasks.map((task) => [task.assigneeIdentityId ?? task.assigneeName, task.assigneeName])).entries()];
  const events = [...new Set(props.organizationTasks.map((task) => task.sourceMessageSubject))];
  const visible = props.organizationTasks.filter((task) => (!assignee || (task.assigneeIdentityId ?? task.assigneeName) === assignee) && (!event || task.sourceMessageSubject === event));
  const today = new Date().toISOString().slice(0, 10);
  const near = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  return <section className="page-layout tasks-page">
    <div className="page-title"><p>ORGANIZATION TASKS</p><h1>タスク</h1><span>Source Message から抽出された期限タスクを、担当者ごとに管理します。</span></div>
    {props.canManage && <section className="task-role-assignments"><strong>タスク担当の割り当て</strong>{(['organizer', 'treasurer'] as const).map((role) => <label key={role}>{role === 'organizer' ? '幹事' : '会計'}<select value={props.taskRoleAssignments.find((assignment) => assignment.role === role)?.identityId ?? ''} onChange={(event) => { if (event.target.value) props.onAssignTaskRole(role, event.target.value); }}><option value="">未割り当て</option>{props.taskMembers.map((member) => <option key={member.identityId} value={member.identityId}>{member.displayName}</option>)}</select></label>)}</section>}
    <section className="task-filters"><label>担当者<select value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">すべて</option>{assignees.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>イベント<select value={event} onChange={(event) => setEvent(event.target.value)}><option value="">すべて</option>{events.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><button className="secondary" onClick={() => { setAssignee(''); setEvent(''); }}>フィルターをリセット</button></section>
    <section className="tasks-table-wrap"><table className="tasks-table"><thead><tr><th>完了</th><th>期限</th><th>担当者</th><th>イベント名</th><th>内容</th><th>備考</th></tr></thead><tbody>{visible.map((task) => <tr key={task.id} className={task.completed ? 'completed' : task.deadline < today ? 'overdue' : task.deadline <= near ? 'near-deadline' : ''}><td><input aria-label={`${task.title}を完了`} type="checkbox" checked={task.completed} disabled={props.busy} onChange={(event) => props.onUpdateTask(task.id, { completed: event.target.checked })} /></td><td>{task.deadline}</td><td>{task.assigneeName}</td><td>{task.sourceMessageSubject}</td><td><strong>{task.title}</strong><small>{task.description}</small></td><td><textarea aria-label={`${task.title}の備考`} defaultValue={task.remarks} onBlur={(event) => props.onUpdateTask(task.id, { remarks: event.target.value })} maxLength={10_000} /></td></tr>)}</tbody></table>{visible.length === 0 && <p className="rules-empty">表示するタスクはありません。</p>}</section>
  </section>;
};

export const ConnectionsPage = (props: DashboardProps) => {
  const settingsReady = Boolean(props.organization && props.canManage);
  const hasGemini = Boolean(props.connections?.ai.apiKeyConfigured);
  return <section className="page-layout settings-page">
    <div className="page-title"><p>CONNECTIONS</p><h1>接続設定</h1><span>Gemini と LINE の資格情報はここで管理します。</span></div>
    {!settingsReady ? <section className="empty-page"><Settings size={30} /><h2>設定を読み込めません</h2><p>Googleでログインし直した後、このページを再読み込みしてください。</p></section> : <>
      <div className="settings-grid">
        <section className="settings-card"><div className="settings-card-title"><Settings size={19} /><div><h2>Gemini API</h2><p>メールの予定抽出に使うAIです。</p></div></div><p className="api-guide">キーをまだ作成していない場合は、<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Google AI Studio で Gemini API キーを作成</a>してから、この画面に戻って貼り付けてください。</p><label>使用するモデル<select value={props.aiModel} onChange={(event) => props.onAiModelChange(event.target.value)}><option value="gemini-3.5-flash-lite">gemini-3.5-flash-lite</option><option value="gemini-3.6-flash">gemini-3.6-flash</option></select></label><label>Gemini API キー<SecretInput label="Gemini API キー" value={props.geminiApiKey} onChange={props.onGeminiApiKeyChange} placeholder={hasGemini ? '登録済み（変更時のみ入力）' : 'AIza…'} /></label><p className="connection-state">{hasGemini ? '接続設定済み' : '未設定'}</p></section>
        <section className="settings-card"><div className="settings-card-title"><Mail size={19} /><div><h2>LINE Messaging API</h2><p>LINE通知を使う場合だけ設定します。</p></div></div><label>チャネルアクセストークン<SecretInput label="LINEチャネルアクセストークン" value={props.lineChannelAccessToken} onChange={props.onLineChannelAccessTokenChange} placeholder={props.connections?.line.channelAccessTokenConfigured ? '登録済み（変更時のみ入力）' : 'チャネルアクセストークン'} /></label><label>チャネルシークレット<SecretInput label="LINEチャネルシークレット" value={props.lineChannelSecret} onChange={props.onLineChannelSecretChange} placeholder={props.connections?.line.channelSecretConfigured ? '登録済み（変更時のみ入力）' : 'チャネルシークレット'} /></label></section>
      </div>
      <div className="settings-actions"><button className="primary" onClick={props.onSaveConnections} disabled={props.settingsBusy || (!props.geminiApiKey && !hasGemini)}><Save size={17} />{props.settingsBusy ? '保存中…' : '接続設定を保存'}</button></div>
      <section className="test-card"><div><p>GEMINI CONNECTION TEST</p><h2>Gemini API をテスト</h2><span>選択中の {props.aiModel} で、保存済みのキーに任意の質問を送信します。</span></div><textarea value={props.geminiTestPrompt} onChange={(event) => props.onGeminiTestPromptChange(event.target.value)} maxLength={10_000} aria-label="Geminiへの質問" /><button className="secondary" onClick={props.onTestGemini} disabled={props.geminiTestBusy || !hasGemini}>{props.geminiTestBusy ? '問い合わせ中…' : 'Gemini に質問する'}</button>{props.geminiTestResult && <pre>{props.geminiTestResult}</pre>}</section>
    </>}
  </section>;
};

export const MailboxTestPage = (props: DashboardProps) => {
  const settingsReady = Boolean(props.organization && props.canManage);
  const hasConfiguredGemini = Boolean(props.connections?.ai.apiKeyConfigured);
  const [geminiRequestCopied, setGeminiRequestCopied] = useState(false);
  const [copyFeedbackId, setCopyFeedbackId] = useState(0);
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendPreparedGeminiRequest = (): void => {
    if (props.mailTestGeminiRequest) props.onPreviewMailbox(props.mailTestGeminiRequest.id);
  };
  const copyPreparedGeminiRequest = (): void => {
    if (!props.mailTestGeminiRequest) return;
    void navigator.clipboard.writeText(JSON.stringify(props.mailTestGeminiRequest.request, null, 2)).then(() => {
      setGeminiRequestCopied(true);
      setCopyFeedbackId((current) => current + 1);
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = setTimeout(() => setGeminiRequestCopied(false), 1_800);
    });
  };
  return <section className="page-layout mail-test-page">
    <div className="page-title"><p>SAFE MANUAL TEST</p><h1>メールテスト</h1><span>{props.automation ? `${props.automation.email} の Gmail と Calendar だけを使用します。` : 'Googleでログインしてください。'}</span></div>
    {!settingsReady || !props.automation ? <section className="empty-page"><SlidersHorizontal size={30} /><h2>メールテストを開始できません</h2><p>Automation Inbox の Google 接続を完了してください。</p></section> : <>
      <section className="test-card"><div><p>1. FIND MAIL</p><h2>件名からメールを探す</h2><span>完全一致する件名を入力してください。AI の API キーは不要です。</span></div><label>メール件名<input value={props.mailTestSubject} onChange={(event) => props.onMailTestSubjectChange(event.target.value)} maxLength={300} /></label><button className="primary" onClick={props.onSearchMailbox} disabled={props.mailTestBusy}>{props.mailTestBusy ? '検索中…' : 'Gmailを検索'}</button></section>
      {props.mailTestMatches.length > 0 && <section className="test-card"><div><p>2. PREPARE AI REQUEST</p><h2>AI への送信内容を確認</h2><span>対象メールを選ぶと、OpenAI 互換形式のリクエスト本文を生成します。この時点では AI に送信しません。</span></div><div className="mail-matches">{props.mailTestMatches.map((message) => <button key={message.id} className="mail-match" onClick={() => props.onPrepareMailbox(message.id)} disabled={props.mailTestBusy}><strong>{message.subject}</strong><small>{message.sender || '差出人なし'}</small></button>)}</div></section>}
      {props.mailTestGeminiRequest && <section className="test-card event-preview"><div className="gemini-request-heading"><div><p>3. REVIEW OPENAI-COMPATIBLE REQUEST</p><h2>OpenAI 互換リクエスト本文</h2><span>API キーは含まれません。送信先の model を指定すれば、任意の OpenAI 互換 API で利用できます。</span></div><button className={`secondary copy-request-button${geminiRequestCopied ? ' copied' : ''}`} onClick={copyPreparedGeminiRequest} aria-live="polite">{geminiRequestCopied ? <CheckCircle2 size={16} /> : <Copy size={16} />}{geminiRequestCopied ? <span key={copyFeedbackId} className="copy-feedback">コピーしました</span> : 'リクエスト全文をコピー'}</button></div><pre className="gemini-request">{JSON.stringify(props.mailTestGeminiRequest.request, null, 2)}</pre><div className="mail-test-actions">{!hasConfiguredGemini && <p className="dashboard-warning">この画面から Gemini に送信する場合だけ、「接続設定」で Gemini API キーを保存してください。コピーしたリクエストは、送信先に合わせて model を追加して利用できます。</p>}<button className="primary" onClick={sendPreparedGeminiRequest} disabled={props.mailTestBusy || !hasConfiguredGemini}>{props.mailTestBusy ? 'Gemini に送信中…' : '設定済みの Gemini で予定を抽出'}</button></div></section>}
      {props.mailTestPreview && <section className="test-card event-preview"><div><p>4. REVIEW AND CREATE</p><h2>予定とタスク候補を確認</h2><span>予定は確認後にだけ Google Calendar へ作成します。タスク候補はメール全体に対して一度だけ抽出されます。</span></div><h3>予定（{props.mailTestPreview.events.length}件）</h3>{props.mailTestPreview.events.map((event, index) => <dl key={`${event.title}-${event.startsAt}`}><dt>予定 {index + 1}</dt><dd>{event.title}</dd><dt>日時</dt><dd>{formatted(event.startsAt)} 〜 {formatted(event.endsAt)}</dd><dt>場所</dt><dd>{event.location || '指定なし'}</dd><dt>説明</dt><dd>{event.description || '指定なし'}</dd></dl>)}<h3>期限タスク候補（{props.mailTestPreview.tasks.length}件）</h3>{props.mailTestPreview.tasks.length ? props.mailTestPreview.tasks.map((task) => <dl key={`${task.assigneeRole}-${task.deadline}-${task.title}`}><dt>{task.assigneeRole === 'organizer' ? '幹事' : '会計'}</dt><dd>{task.title}</dd><dt>期限</dt><dd>{task.deadline}</dd><dt>内容</dt><dd>{task.description}</dd></dl>) : <p>明示された登録・振込期限はありません。</p>}<button className="primary" onClick={props.onCreateCalendarEvent} disabled={props.mailTestBusy || Boolean(props.mailTestCreatedEventIds.length)}>{props.mailTestCreatedEventIds.length ? 'Calendarに作成済み' : props.mailTestBusy ? '作成中…' : `${props.mailTestPreview.events.length}件を Calendar に追加`}</button>{props.mailTestCreatedEventIds.length > 0 && <p className="dashboard-success"><CheckCircle2 size={17} />テスト予定 {props.mailTestCreatedEventIds.length}件を作成しました。</p>}</section>}
    </>}
  </section>;
};

export const RulesPage = (props: DashboardProps) => {
  const settingsReady = Boolean(props.organization && props.canManage);
  const [ruleName, setRuleName] = useState('');
  const [ruleSender, setRuleSender] = useState('');
  const [ruleDomain, setRuleDomain] = useState('');
  const [ruleKeyword, setRuleKeyword] = useState('');
  const [ruleLabel, setRuleLabel] = useState('');
  const [rulePriority, setRulePriority] = useState('0');
  const [ruleState, setRuleState] = useState<'draft' | 'active'>('draft');
  const createRule = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const selectionPolicy = Object.fromEntries(Object.entries({ sender: ruleSender.trim(), domain: ruleDomain.trim(), keyword: ruleKeyword.trim(), label: ruleLabel.trim() }).filter(([, value]) => value));
    await props.onCreateRule({ name: ruleName, state: ruleState, selectionPolicy, routingPolicy: {}, priority: Number.parseInt(rulePriority, 10) || 0 });
    setRuleName(''); setRuleSender(''); setRuleDomain(''); setRuleKeyword(''); setRuleLabel(''); setRulePriority('0'); setRuleState('draft');
  };
  return <section className="page-layout rules-page">
    <div className="page-title"><p>AUTOMATION RULES</p><h1>ルールセット</h1><span>どのメールを予定化するかを、送信者・ドメイン・キーワード・Gmailラベルで指定します。</span></div>
    {!settingsReady ? <section className="empty-page"><SlidersHorizontal size={30} /><h2>ルールを読み込めません</h2><p>Googleでログインし直した後、このページを再読み込みしてください。</p></section> : <>
      <form className="rule-builder" onSubmit={(event) => void createRule(event)}><div><p>NEW RULE</p><h2>ルールを作成</h2><span>下書きで作成してから有効化できます。</span></div><label>ルール名<input value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder="例: ローターアクト行事" required /></label><div className="rule-grid"><label>送信者（完全一致）<input value={ruleSender} onChange={(event) => setRuleSender(event.target.value)} placeholder="sender@example.com" /></label><label>送信元ドメイン<input value={ruleDomain} onChange={(event) => setRuleDomain(event.target.value)} placeholder="example.com" /></label><label>本文・件名のキーワード<input value={ruleKeyword} onChange={(event) => setRuleKeyword(event.target.value)} placeholder="例: 招待行事" /></label><label>Gmailラベル<input value={ruleLabel} onChange={(event) => setRuleLabel(event.target.value)} placeholder="例: Announcements" /></label><label>優先度<input type="number" value={rulePriority} onChange={(event) => setRulePriority(event.target.value)} /></label><label>作成時の状態<select value={ruleState} onChange={(event) => setRuleState(event.target.value as 'draft' | 'active')}><option value="draft">下書き</option><option value="active">有効</option></select></label></div><button className="primary" disabled={props.ruleBusy}>{props.ruleBusy ? '作成中…' : 'ルールを作成'}</button></form>
      <section className="rules-list"><div className="rules-list-title"><h2>登録済みルール</h2><span>{props.organizationRules.length}件</span></div>{props.organizationRules.length ? props.organizationRules.map((rule) => <article key={rule.id} className="rule-row"><div><strong>{rule.name}</strong><small>優先度 {rule.priority} ・ {Object.entries(rule.selectionPolicy).map(([key, value]) => `${key}: ${String(value)}`).join(' / ') || '条件なし'}</small></div><span className={`rule-state ${rule.state}`}>{rule.state}</span></article>) : <p className="rules-empty">まだルールはありません。</p>}</section>
    </>}
  </section>;
};

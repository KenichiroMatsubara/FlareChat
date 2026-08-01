import { CalendarDays, CheckCircle2, Copy, Eye, EyeOff, Mail, MessageCircle, Pencil, Play, RefreshCw, Save, Search, Settings, SlidersHorizontal, UserPlus, UsersRound, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

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

const normalizeSearch = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/gu, '');
const destinationKindLabel = (kind: 'user' | 'group' | 'room'): string =>
  kind === 'user' ? '個人' : kind === 'group' ? 'グループ' : 'ルーム';

export const MembersPage = (props: DashboardProps) => {
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [selectedLineDestinationId, setSelectedLineDestinationId] = useState('');
  const [poolDestinationId, setPoolDestinationId] = useState('');
  const [poolKind, setPoolKind] = useState<'user' | 'group' | 'room'>('user');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [tags, setTags] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editState, setEditState] = useState<'active' | 'inactive'>('active');
  const [editManualDestinationId, setEditManualDestinationId] = useState('');
  const [editManualKind, setEditManualKind] = useState<'user' | 'group' | 'room'>('user');
  const unassignedDestinations = props.lineDestinations.filter((destination) =>
    destination.status === 'discovered' && !destination.recipientProfileId);
  const searchToken = normalizeSearch(query);
  const visibleRecipients = props.organizationRecipients.filter((recipient) => {
    if (stateFilter !== 'all' && recipient.state !== stateFilter) return false;
    if (!searchToken) return true;
    return normalizeSearch([
      recipient.name,
      recipient.email,
      ...recipient.tags,
      ...recipient.lineDestinations.flatMap((destination) => [destination.displayName, destination.destinationId]),
    ].join(' ')).includes(searchToken);
  });
  const withEmail = props.organizationRecipients.filter((recipient) => recipient.email && recipient.email !== '***').length;
  const linkedToLine = props.organizationRecipients.filter((recipient) => recipient.lineDestinations.length > 0).length;
  const lineConfigured = Boolean(
    props.connections?.line.channelAccessTokenConfigured && props.connections.line.channelSecretConfigured,
  );

  const selectLineDestination = (id: string): void => {
    setSelectedLineDestinationId(id);
    const destination = unassignedDestinations.find((value) => value.id === id);
    if (destination?.displayName) setName(destination.displayName);
  };
  const promoteDestination = (id: string): void => {
    selectLineDestination(id);
    nameInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    nameInputRef.current?.focus();
  };
  const registerPending = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!poolDestinationId.trim()) return;
    await props.onRegisterLineDestination({ destinationId: poolDestinationId.trim(), kind: poolKind });
    setPoolDestinationId('');
    setPoolKind('user');
  };
  const createRecipient = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    await props.onCreateRecipient({
      name: name.trim(),
      email: email.trim(),
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      ...(selectedLineDestinationId ? { lineDestinationId: selectedLineDestinationId } : {}),
    });
    setSelectedLineDestinationId('');
    setName('');
    setEmail('');
    setTags('');
  };
  const beginEdit = (recipient: DashboardProps['organizationRecipients'][number]): void => {
    setEditingId(recipient.id);
    setEditName(recipient.name);
    setEditEmail(recipient.email === '***' ? '' : recipient.email);
    setEditTags(recipient.tags.join(', '));
    setEditState(recipient.state);
    const manual = recipient.lineDestinations.find((destination) => destination.source === 'manual');
    setEditManualDestinationId(manual?.destinationId ?? '');
    setEditManualKind(manual?.kind ?? 'user');
  };
  const saveManualLineDestination = async (recipientId: string): Promise<void> => {
    if (!editManualDestinationId.trim()) return;
    await props.onSetLineDestination(recipientId, { destinationId: editManualDestinationId.trim(), kind: editManualKind });
  };
  const unlinkLineDestination = async (recipientId: string, lineDestinationId: string): Promise<void> => {
    await props.onUnlinkLineDestination(recipientId, lineDestinationId);
  };
  const saveEdit = async (recipientId: string): Promise<void> => {
    await props.onUpdateRecipient(recipientId, {
      name: editName.trim(),
      email: editEmail.trim(),
      tags: editTags.split(',').map((tag) => tag.trim()).filter(Boolean),
      state: editState,
    });
    setEditingId('');
  };

  return <section className="page-layout members-page">
    <div className="page-title"><p>MEMBER ROSTER</p><h1>メンバー管理</h1><span>LINEで見つけた表示名・ユーザーIDに、氏名、メールアドレス、分類を紐付けます。</span></div>
    <section className="member-metrics">
      <div><span className="member-metric-icon green"><UsersRound size={18} /></span><p><b>{props.organizationRecipients.length}</b><small>登録メンバー</small></p></div>
      <div><span className="member-metric-icon blue"><MessageCircle size={18} /></span><p><b>{linkedToLine}</b><small>LINE紐付け済み</small></p></div>
      <div><span className="member-metric-icon amber"><Mail size={18} /></span><p><b>{withEmail}</b><small>メール設定済み</small></p></div>
      <div><span className="member-metric-icon violet"><UserPlus size={18} /></span><p><b>{unassignedDestinations.length}</b><small>未登録のLINE</small></p></div>
    </section>

    {props.canManage && <section className="member-onboarding">
      <div className="member-onboarding-copy">
        <span className="line-mark">LINE</span>
        <div><p>LINEからメンバーを追加</p><h2>{unassignedDestinations.length ? `${unassignedDestinations.length}件のLINEアカウントが登録待ちです` : 'LINEアカウントの受信を待っています'}</h2><span>公式アカウントにメッセージが届くと、表示名とIDを自動取得します。手動でも登録できます。</span></div>
        <button type="button" className="secondary member-refresh" onClick={props.onRefreshRecipients} disabled={props.memberBusy}><RefreshCw className={props.memberBusy ? 'spin' : ''} size={16} />更新</button>
      </div>
      {!lineConfigured && <p className="dashboard-warning member-connection-warning">LINE Messaging APIが未設定です。<Link to="../connections">接続設定を開く</Link></p>}

      <div className="pending-line-pool">
        <p>保留中のLINE連絡先</p>
        {unassignedDestinations.length > 0 ? <div className="pending-line-list">
          {unassignedDestinations.map((destination) => <div key={destination.id}>
            <span className="line-badge"><MessageCircle size={13} />{destinationKindLabel(destination.kind)}{destination.source === 'manual' ? '・手動登録' : '・Webhook検出'}</span>
            <strong>{destination.displayName || '表示名未取得'}</strong>
            <code>{destination.destinationId}</code>
            <button type="button" className="secondary" onClick={() => promoteDestination(destination.id)}><UserPlus size={13} />本メンバーに登録</button>
            <button type="button" className="member-line-unlink" onClick={() => void props.onRemoveLineDestination(destination.id)} disabled={props.memberBusy}><X size={13} />削除</button>
          </div>)}
        </div> : <p className="pending-line-empty">Webhookでの受信、または下のフォームからの手動登録を待っています。</p>}
        <form className="pending-line-form" onSubmit={(event) => void registerPending(event)}>
          <label>LINE IDを手動で登録<input value={poolDestinationId} onChange={(event) => setPoolDestinationId(event.target.value)} placeholder="例: U4af498062xxxxxxxxxxxxxxxxxxxxxx" /></label>
          <label>種別<select value={poolKind} onChange={(event) => setPoolKind(event.target.value as 'user' | 'group' | 'room')}><option value="user">個人</option><option value="group">グループ</option><option value="room">ルーム</option></select></label>
          <button type="submit" className="secondary" disabled={props.memberBusy || !poolDestinationId.trim()}>追加</button>
        </form>
        <small>友だち追加前やWebhook未設定でも、既知のLINE IDを先に登録しておけます。氏名やメールは下のフォームで後から設定してください。</small>
      </div>

      <form className="member-create-form" onSubmit={(event) => void createRecipient(event)}>
        <label className="member-line-select">LINEアカウント<select value={selectedLineDestinationId} onChange={(event) => selectLineDestination(event.target.value)}><option value="">LINEなしで登録</option>{unassignedDestinations.map((destination) => <option key={destination.id} value={destination.id}>{destination.displayName || '表示名未取得'} · {destinationKindLabel(destination.kind)} · {destination.destinationId}</option>)}</select></label>
        <label>氏名<input ref={nameInputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="例: 山田 太郎" required /></label>
        <label>メールアドレス<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="member@example.com" required /></label>
        <label>分類タグ<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例: 会員, 2026年度" /></label>
        <button className="primary" disabled={props.memberBusy}><UserPlus size={16} />{props.memberBusy ? '登録中…' : 'メンバーに追加'}</button>
      </form>
    </section>}

    <section className="member-directory">
      <div className="member-directory-heading"><div><p>MEMBER DIRECTORY</p><h2>メンバー名簿</h2></div><span>{visibleRecipients.length} / {props.organizationRecipients.length}件</span></div>
      <div className="member-filters">
        <label className="member-search"><Search size={16} /><input aria-label="メンバーを検索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前・メール・LINE IDで検索" /></label>
        <select aria-label="状態で絞り込み" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}><option value="all">すべての状態</option><option value="active">有効</option><option value="inactive">無効</option></select>
      </div>
      <div className="member-list">
        {visibleRecipients.map((recipient) => <article key={recipient.id} className={`member-card ${recipient.state}`}>
          <div className="member-avatar" aria-hidden="true">{recipient.name.trim().slice(0, 1) || '?'}</div>
          {editingId === recipient.id ? <div className="member-edit-form">
            <div className="member-edit-grid">
              <label>氏名<input value={editName} onChange={(event) => setEditName(event.target.value)} /></label>
              <label>メールアドレス<input type="email" value={editEmail} onChange={(event) => setEditEmail(event.target.value)} /></label>
              <label>分類タグ<input value={editTags} onChange={(event) => setEditTags(event.target.value)} /></label>
              <label>状態<select value={editState} onChange={(event) => setEditState(event.target.value as 'active' | 'inactive')}><option value="active">有効</option><option value="inactive">無効</option></select></label>
            </div>
            <div className="member-edit-line">
              <p>LINE連携</p>
              {recipient.lineDestinations.length > 0 && <div className="member-edit-line-list">
                {recipient.lineDestinations.map((destination) => <div key={destination.id}>
                  <span className="line-badge"><MessageCircle size={13} />{destinationKindLabel(destination.kind)}{destination.source === 'manual' ? '・手動登録' : ''}</span>
                  <code>{destination.destinationId}</code>
                  <button type="button" className="member-line-unlink" onClick={() => void unlinkLineDestination(recipient.id, destination.id)} disabled={props.memberBusy}><X size={13} />解除</button>
                </div>)}
              </div>}
              <div className="member-edit-line-manual">
                <label>LINE IDを手動で設定<input value={editManualDestinationId} onChange={(event) => setEditManualDestinationId(event.target.value)} placeholder="例: U4af498062xxxxxxxxxxxxxxxxxxxxxx" /></label>
                <label>種別<select value={editManualKind} onChange={(event) => setEditManualKind(event.target.value as 'user' | 'group' | 'room')}><option value="user">個人</option><option value="group">グループ</option><option value="room">ルーム</option></select></label>
                <button type="button" className="secondary" onClick={() => void saveManualLineDestination(recipient.id)} disabled={props.memberBusy || !editManualDestinationId.trim()}>設定</button>
              </div>
            </div>
            <div className="member-edit-actions"><button className="primary" onClick={() => void saveEdit(recipient.id)} disabled={props.memberBusy}><Save size={15} />保存</button><button className="secondary" onClick={() => setEditingId('')}><X size={15} />キャンセル</button></div>
          </div> : <>
            <div className="member-identity">
              <div><h3>{recipient.name}</h3><span className={`member-state ${recipient.state}`}>{recipient.state === 'active' ? '有効' : '無効'}</span></div>
              <p><Mail size={14} />{recipient.email || 'メール未設定'}</p>
              <div className="member-tags">{recipient.tags.length ? recipient.tags.map((tag) => <span key={tag}>{tag}</span>) : <small>タグなし</small>}</div>
            </div>
            <div className="member-line-details">
              {recipient.lineDestinations.length ? recipient.lineDestinations.map((destination) => <div key={destination.id}><span className="line-badge"><MessageCircle size={13} />LINE {destinationKindLabel(destination.kind)}{destination.source === 'manual' ? '・手動' : ''}</span><strong>{destination.displayName || recipient.name}</strong><code>{destination.destinationId}</code><button type="button" className="member-copy" aria-label={`${destination.destinationId}をコピー`} onClick={() => void navigator.clipboard.writeText(destination.destinationId)}><Copy size={14} /></button></div>) : <div className="member-line-empty"><MessageCircle size={15} /><span>LINE未連携</span></div>}
            </div>
            {props.canManage && <button type="button" className="member-edit-button" onClick={() => beginEdit(recipient)}><Pencil size={15} />編集</button>}
          </>}
        </article>)}
        {visibleRecipients.length === 0 && <div className="member-empty"><UsersRound size={28} /><h3>{props.organizationRecipients.length ? '条件に一致するメンバーがいません' : 'メンバーはまだ登録されていません'}</h3><p>{props.organizationRecipients.length ? '検索条件を変更してください。' : 'LINEアカウントを選ぶか、氏名とメールアドレスを直接入力して追加できます。'}</p></div>}
      </div>
    </section>
  </section>;
};

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
  const hasAiApi = Boolean(props.connections?.ai.apiKeyConfigured);
  return <section className="page-layout settings-page">
    <div className="page-title"><p>CONNECTIONS</p><h1>接続設定</h1><span>OpenAI 互換 API と LINE の資格情報はここで管理します。</span></div>
    {!settingsReady ? <section className="empty-page"><Settings size={30} /><h2>設定を読み込めません</h2><p>Googleでログインし直した後、このページを再読み込みしてください。</p></section> : <>
      <div className="settings-grid">
        <section className="settings-card"><div className="settings-card-title"><Settings size={19} /><div><h2>OpenAI 互換 API</h2><p>メールの予定抽出に使う AI です。</p></div></div><p className="api-guide">利用するサービスの OpenAI 互換 API の Base URL、model、API キーを入力してください。</p><label>Base URL<input value={props.aiBaseUrl} onChange={(event) => props.onAiBaseUrlChange(event.target.value)} placeholder="https://api.openai.com/v1" autoCapitalize="none" spellCheck={false} /></label><label>model<input value={props.aiModel} onChange={(event) => props.onAiModelChange(event.target.value)} placeholder="例: gpt-4.1-mini" autoCapitalize="none" spellCheck={false} /></label><label>API キー<SecretInput label="OpenAI 互換 API キー" value={props.aiApiKey} onChange={props.onAiApiKeyChange} placeholder={hasAiApi ? '登録済み（変更時のみ入力）' : 'API キー'} /></label><p className="connection-state">{hasAiApi ? '接続設定済み' : '未設定'}</p></section>
        <section className="settings-card"><div className="settings-card-title"><Mail size={19} /><div><h2>LINE Messaging API</h2><p>LINE通知を使う場合だけ設定します。</p></div></div><label>チャネルアクセストークン<SecretInput label="LINEチャネルアクセストークン" value={props.lineChannelAccessToken} onChange={props.onLineChannelAccessTokenChange} placeholder={props.connections?.line.channelAccessTokenConfigured ? '登録済み（変更時のみ入力）' : 'チャネルアクセストークン'} /></label><label>チャネルシークレット<SecretInput label="LINEチャネルシークレット" value={props.lineChannelSecret} onChange={props.onLineChannelSecretChange} placeholder={props.connections?.line.channelSecretConfigured ? '登録済み（変更時のみ入力）' : 'チャネルシークレット'} /></label></section>
      </div>
      <div className="settings-actions"><button className="primary" onClick={props.onSaveConnections} disabled={props.settingsBusy || !props.aiBaseUrl.trim() || !props.aiModel.trim() || (!props.aiApiKey && !hasAiApi)}><Save size={17} />{props.settingsBusy ? '保存中…' : '接続設定を保存'}</button></div>
      <section className="test-card"><div><p>AI CONNECTION TEST</p><h2>OpenAI 互換 API をテスト</h2><span>保存済みの接続設定を使って、任意の質問を送信します。</span></div><textarea value={props.aiTestPrompt} onChange={(event) => props.onAiTestPromptChange(event.target.value)} maxLength={10_000} aria-label="APIへの質問" /><button className="secondary" onClick={props.onTestAi} disabled={props.aiTestBusy || !hasAiApi}>{props.aiTestBusy ? '問い合わせ中…' : 'API に質問する'}</button>{props.aiTestResult && <pre>{props.aiTestResult}</pre>}</section>
    </>}
  </section>;
};

export const MailboxTestPage = (props: DashboardProps) => {
  const settingsReady = Boolean(props.organization && props.canManage);
  const hasConfiguredAiApi = Boolean(props.connections?.ai.apiKeyConfigured);
  const [aiRequestCopied, setAiRequestCopied] = useState(false);
  const [copyFeedbackId, setCopyFeedbackId] = useState(0);
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendPreparedAiRequest = (): void => {
    if (props.mailTestAiRequest) props.onPreviewMailbox(props.mailTestAiRequest.id);
  };
  const copyPreparedAiRequest = (): void => {
    if (!props.mailTestAiRequest) return;
    void navigator.clipboard.writeText(JSON.stringify(props.mailTestAiRequest.request, null, 2)).then(() => {
      setAiRequestCopied(true);
      setCopyFeedbackId((current) => current + 1);
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = setTimeout(() => setAiRequestCopied(false), 1_800);
    });
  };
  return <section className="page-layout mail-test-page">
    <div className="page-title"><p>SAFE MANUAL TEST</p><h1>メールテスト</h1><span>{props.automation ? `${props.automation.email} の Gmail と Calendar だけを使用します。` : 'Googleでログインしてください。'}</span></div>
    {!settingsReady || !props.automation ? <section className="empty-page"><SlidersHorizontal size={30} /><h2>メールテストを開始できません</h2><p>Automation Inbox の Google 接続を完了してください。</p></section> : <>
      <section className="test-card"><div><p>1. FIND MAIL</p><h2>件名からメールを探す</h2><span>完全一致する件名を入力してください。AI の API キーは不要です。</span></div><label>メール件名<input value={props.mailTestSubject} onChange={(event) => props.onMailTestSubjectChange(event.target.value)} maxLength={300} /></label><button className="primary" onClick={props.onSearchMailbox} disabled={props.mailTestBusy}>{props.mailTestBusy ? '検索中…' : 'Gmailを検索'}</button></section>
      {props.mailTestMatches.length > 0 && <section className="test-card"><div><p>2. PREPARE AI REQUEST</p><h2>AI への送信内容を確認</h2><span>対象メールを選ぶと、OpenAI 互換形式のリクエスト本文を生成します。この時点では AI に送信しません。</span></div><div className="mail-matches">{props.mailTestMatches.map((message) => <button key={message.id} className="mail-match" onClick={() => props.onPrepareMailbox(message.id)} disabled={props.mailTestBusy}><strong>{message.subject}</strong><small>{message.sender || '差出人なし'}</small></button>)}</div></section>}
      {props.mailTestAiRequest && <section className="test-card event-preview"><div className="ai-request-heading"><div><p>3. REVIEW OPENAI-COMPATIBLE REQUEST</p><h2>OpenAI 互換リクエスト本文</h2><span>API キーは含まれません。送信先の model を指定すれば、任意の OpenAI 互換 API で利用できます。</span></div><button className={`secondary copy-request-button${aiRequestCopied ? ' copied' : ''}`} onClick={copyPreparedAiRequest} aria-live="polite">{aiRequestCopied ? <CheckCircle2 size={16} /> : <Copy size={16} />}{aiRequestCopied ? <span key={copyFeedbackId} className="copy-feedback">コピーしました</span> : 'リクエスト全文をコピー'}</button></div><pre className="ai-request">{JSON.stringify(props.mailTestAiRequest.request, null, 2)}</pre><div className="mail-test-actions">{hasConfiguredAiApi ? <button className="primary" onClick={sendPreparedAiRequest} disabled={props.mailTestBusy}>{props.mailTestBusy ? 'API に送信中…' : '設定済みの API で予定を抽出'}</button> : <p className="dashboard-warning api-configuration-prompt"><span>OpenAI 互換 API が設定されていません</span><Link to={props.organizationId ? `/organizations/${encodeURIComponent(props.organizationId)}/connections` : '../connections'}>APIを設定する</Link></p>}</div></section>}
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

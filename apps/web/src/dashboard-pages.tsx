import { CalendarDays, CheckCircle2, CircleAlert, Copy, Eye, EyeOff, Mail, MessageCircle, Pencil, Play, RefreshCw, Save, Search, Settings, SlidersHorizontal, UserPlus, UsersRound, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { DashboardProps } from './dashboard';
import type { GuestRegistrationRoster } from './api';
import { pendingKey } from './pending';

/**
 * The progress an onBlur save needs: it has no button of its own to relabel, so
 * the field states that it is saving and that it saved.
 */
const FieldSaveState = ({ saving, saved }: { saving: boolean; saved: boolean }) => saving
  ? <small className="field-state saving"><RefreshCw className="spin" size={12} />保存中…</small>
  : saved ? <small className="field-state saved"><CheckCircle2 size={12} />保存しました</small> : null;

/** How long a copy action keeps saying it copied before returning to its resting label. */
export const COPY_NOTICE_MS = 1_800;

const formatted = (value: string | null): string => value
  ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'まだ実行していません';

const SecretInput = ({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder: string }) => {
  const [revealed, setRevealed] = useState(false);
  return <div className="dashboard-secret"><input type="text" className={revealed ? '' : 'dashboard-secret-masked'} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} autoComplete="off" autoCapitalize="none" spellCheck={false} data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" /><button type="button" onClick={() => setRevealed((current) => !current)} aria-label={revealed ? `${label}を隠す` : `${label}を表示`}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>;
};

/**
 * The Guest Registrations returned against a Scheduled Event. Names are shown
 * here and nowhere else: the Calendar description every invited Member reads
 * carries the counts by Affiliation alone.
 */
const GuestRegistrations = (props: { rosters: GuestRegistrationRoster[] }) => {
  if (!props.rosters.length) return null;
  return <section className="guest-registrations">
    <h2>外部からの参加登録</h2>
    <p>他団体から返送された登録用紙の参加者です。Google Calendar の説明には人数だけを書き、氏名はこの画面にのみ表示します。</p>
    {props.rosters.map((roster) => <article key={roster.eventId}>
      <h3>{roster.title}<small>{formatted(roster.startsAt)}</small></h3>
      <p className="guest-total">{roster.affiliations.length}団体 {roster.attendingCount}名{roster.affiliations.length ? `（${roster.affiliations.map((entry) => `${entry.affiliation} ${entry.attending}名`).join('、')}）` : ''}</p>
      <ul>{roster.guests.map((guest) => <li key={`${guest.affiliation}-${guest.name}`} className={guest.attending ? '' : 'guest-absent'}>{guest.name}<small>{guest.affiliation || '所属未記載'}</small>{guest.attending ? '' : <span>欠席</span>}</li>)}</ul>
    </article>)}
  </section>;
};

export const AutomationPage = (props: DashboardProps) => {
  const running = props.isPending(pendingKey.automationRun);
  const toggling = props.isPending(pendingKey.automationEnabled);
  return <section className="page-layout automation-page">
    <div className="page-title"><p>GMAIL TO CALENDAR</p><h1>自動化</h1><span>{props.automation ? `${props.automation.email} の Gmail と primary Calendar を接続中` : 'Googleアカウントを接続してください'}</span></div>
    {props.automation ? <>
      <section className="hero-status"><div><span className={props.automation.enabled ? 'status-light on' : 'status-light'} /><p>{props.automation.enabled ? '自動化は有効です' : '自動化は停止中です'}</p><small>前回の確認: {formatted(props.automation.lastSyncedAt)}</small></div><div className="hero-switch">{toggling && <small className="field-state saving"><RefreshCw className="spin" size={12} />切替中…</small>}<label className="switch"><input type="checkbox" checked={props.automation.enabled} onChange={(event) => props.onSetEnabled(event.target.checked)} disabled={toggling} /><span /></label></div></section>
      <section className="action-panel"><div><h2>メールを今すぐ確認</h2><p>すべての新着メールを確認し、AI が予定・タスク・お知らせを判定します。</p></div><button className="primary" onClick={props.onRun} disabled={running || toggling || !props.automation.enabled}>{running ? <RefreshCw className="spin" size={18} /> : <Play size={18} />}{running ? 'メールを確認中…（完了までこのページを開いたままにしてください）' : '今すぐ確認'}</button></section>
      {props.automation.failingSince && props.automation.status === 'active' && <p className="dashboard-error"><CircleAlert size={17} />{formatted(props.automation.failingSince)}から自動処理に失敗しています。復旧すると自動的に再開します。{props.automation.lastError ? `（${props.automation.lastError}）` : ''}</p>}
      {props.summary && <p className="dashboard-success"><CheckCircle2 size={17} />今回: {props.summary.scanned}件をAI判定、{props.summary.created}件を予定化、{props.summary.skipped}件を対象外、{props.summary.exceptions}件でエラー</p>}
      <section className="metrics-row"><div><b>{props.automation.created}</b><span>予定を作成</span></div><div><b>{props.automation.skipped}</b><span>処理対象外</span></div><div><b>{props.automation.exceptions}</b><span>エラー</span></div></section>
      <section className="info-panel"><CalendarDays size={20} /><div><strong>AI がメール内容を判定します</strong><p>固定の日付書式は不要です。本文や添付ファイルから予定、タスク、お知らせを抽出します。</p></div></section>
      <GuestRegistrations rosters={props.guestRegistrations} />
    </> : <section className="empty-page"><Mail size={30} /><h2>Googleアカウントを接続してください</h2><p>接続後、このページから自動化を操作できます。</p></section>}
  </section>;
};

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
  const refreshing = props.isPending(pendingKey.memberRefresh);
  const creatingMember = props.isPending(pendingKey.memberCreate);
  const registeringDestination = props.isPending(pendingKey.lineDestinationRegister);
  const unassignedDestinations = props.lineDestinations.filter((destination) =>
    destination.status === 'discovered' && !destination.memberId);
  const searchToken = normalizeSearch(query);
  const visibleMembers = props.organizationMembers.filter((member) => {
    if (stateFilter !== 'all' && member.state !== stateFilter) return false;
    if (!searchToken) return true;
    return normalizeSearch([
      member.name,
      member.email,
      ...member.tags,
      ...member.lineDestinations.flatMap((destination) => [destination.displayName, destination.destinationId]),
    ].join(' ')).includes(searchToken);
  });
  const withEmail = props.organizationMembers.filter((member) => member.email && member.email !== '***').length;
  const linkedToLine = props.organizationMembers.filter((member) => member.lineDestinations.length > 0).length;
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
  const createMember = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    await props.onCreateMember({
      name: name.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      ...(selectedLineDestinationId ? { lineDestinationId: selectedLineDestinationId } : {}),
    });
    setSelectedLineDestinationId('');
    setName('');
    setEmail('');
    setTags('');
  };
  const beginEdit = (member: DashboardProps['organizationMembers'][number]): void => {
    setEditingId(member.id);
    setEditName(member.name);
    setEditEmail(member.email === '***' ? '' : member.email);
    setEditTags(member.tags.join(', '));
    setEditState(member.state);
    const manual = member.lineDestinations.find((destination) => destination.source === 'manual');
    setEditManualDestinationId('');
    setEditManualKind(manual?.kind ?? 'user');
  };
  const saveManualLineDestination = async (memberId: string): Promise<void> => {
    if (!editManualDestinationId.trim()) return;
    await props.onSetLineDestination(memberId, { destinationId: editManualDestinationId.trim(), kind: editManualKind });
  };
  const unlinkLineDestination = async (memberId: string, lineDestinationId: string): Promise<void> => {
    await props.onUnlinkLineDestination(memberId, lineDestinationId);
  };
  const saveEdit = async (memberId: string): Promise<void> => {
    await props.onUpdateMember(memberId, {
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
      <div><span className="member-metric-icon green"><UsersRound size={18} /></span><p><b>{props.organizationMembers.length}</b><small>登録メンバー</small></p></div>
      <div><span className="member-metric-icon blue"><MessageCircle size={18} /></span><p><b>{linkedToLine}</b><small>LINE紐付け済み</small></p></div>
      <div><span className="member-metric-icon amber"><Mail size={18} /></span><p><b>{withEmail}</b><small>メール設定済み</small></p></div>
      <div><span className="member-metric-icon violet"><UserPlus size={18} /></span><p><b>{unassignedDestinations.length}</b><small>未登録のLINE</small></p></div>
    </section>

    {<section className="member-onboarding">
      <div className="member-onboarding-copy">
        <span className="line-mark">LINE</span>
        <div><p>LINEからメンバーを追加</p><h2>{unassignedDestinations.length ? `${unassignedDestinations.length}件のLINEアカウントが登録待ちです` : 'LINEアカウントの受信を待っています'}</h2><span>公式アカウントにメッセージが届くと、表示名とIDを自動取得します。手動でも登録できます。</span></div>
        <button type="button" className="secondary member-refresh" onClick={props.onRefreshMembers} disabled={refreshing}><RefreshCw className={refreshing ? 'spin' : ''} size={16} />{refreshing ? '更新中…' : '更新'}</button>
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
            <button type="button" className="member-line-unlink" onClick={() => void props.onRemoveLineDestination(destination.id)} disabled={props.isPending(pendingKey.lineDestinationRemove(destination.id))}>{props.isPending(pendingKey.lineDestinationRemove(destination.id)) ? <><RefreshCw className="spin" size={13} />削除中…</> : <><X size={13} />削除</>}</button>
          </div>)}
        </div> : <p className="pending-line-empty">Webhookでの受信、または下のフォームからの手動登録を待っています。</p>}
        <form className="pending-line-form" onSubmit={(event) => void registerPending(event)}>
          <label>LINE IDを手動で登録<input value={poolDestinationId} onChange={(event) => setPoolDestinationId(event.target.value)} placeholder="例: U4af498062xxxxxxxxxxxxxxxxxxxxxx" /></label>
          <label>種別<select value={poolKind} onChange={(event) => setPoolKind(event.target.value as 'user' | 'group' | 'room')}><option value="user">個人</option><option value="group">グループ</option><option value="room">ルーム</option></select></label>
          <button type="submit" className="secondary" disabled={registeringDestination || !poolDestinationId.trim()}>{registeringDestination ? <><RefreshCw className="spin" size={13} />追加中…</> : '追加'}</button>
        </form>
        <small>友だち追加前やWebhook未設定でも、既知のLINE IDを先に登録しておけます。氏名やメールは下のフォームで後から設定してください。</small>
      </div>

      <form className="member-create-form" onSubmit={(event) => void createMember(event)}>
        <label className="member-line-select">LINEアカウント<select value={selectedLineDestinationId} onChange={(event) => selectLineDestination(event.target.value)}><option value="">LINEなしで登録</option>{unassignedDestinations.map((destination) => <option key={destination.id} value={destination.id}>{destination.displayName || '表示名未取得'} · {destinationKindLabel(destination.kind)} · {destination.destinationId}</option>)}</select></label>
        <label>氏名<input ref={nameInputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="例: 山田 太郎" required /></label>
        <label>メールアドレス（任意）<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="後から設定できます" /></label>
        <label>分類タグ<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例: 会員, 2026年度" /></label>
        <button className="primary" disabled={creatingMember}>{creatingMember ? <RefreshCw className="spin" size={16} /> : <UserPlus size={16} />}{creatingMember ? '登録中…' : 'メンバーに追加'}</button>
      </form>
    </section>}

    <section className="member-directory">
      <div className="member-directory-heading"><div><p>MEMBER DIRECTORY</p><h2>メンバー名簿</h2></div><span>{visibleMembers.length} / {props.organizationMembers.length}件</span></div>
      <div className="member-filters">
        <label className="member-search"><Search size={16} /><input aria-label="メンバーを検索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前・メール・LINE IDで検索" /></label>
        <select aria-label="状態で絞り込み" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}><option value="all">すべての状態</option><option value="active">有効</option><option value="inactive">無効</option></select>
      </div>
      <div className="member-list">
        {visibleMembers.map((member) => <article key={member.id} className={`member-card ${member.state}`}>
          <div className="member-avatar" aria-hidden="true">{member.name.trim().slice(0, 1) || '?'}</div>
          {editingId === member.id ? <div className="member-edit-form">
            <div className="member-edit-grid">
              <label>氏名<input value={editName} onChange={(event) => setEditName(event.target.value)} /></label>
              <label>メールアドレス<input type="email" value={editEmail} onChange={(event) => setEditEmail(event.target.value)} /></label>
              <label>分類タグ<input value={editTags} onChange={(event) => setEditTags(event.target.value)} /></label>
              <label>状態<select value={editState} onChange={(event) => setEditState(event.target.value as 'active' | 'inactive')}><option value="active">有効</option><option value="inactive">無効</option></select></label>
            </div>
            <div className="member-edit-line">
              <p>LINE連携</p>
              {member.lineDestinations.length > 0 && <div className="member-edit-line-list">
                {member.lineDestinations.map((destination) => <div key={destination.id}>
                  <span className="line-badge"><MessageCircle size={13} />{destinationKindLabel(destination.kind)}{destination.source === 'manual' ? '・手動登録' : ''}</span>
                  <code>{destination.destinationId}</code>
                  <button type="button" className="member-line-unlink" onClick={() => void unlinkLineDestination(member.id, destination.id)} disabled={props.isPending(pendingKey.lineDestinationUnlink(destination.id))}>{props.isPending(pendingKey.lineDestinationUnlink(destination.id)) ? <><RefreshCw className="spin" size={13} />解除中…</> : <><X size={13} />解除</>}</button>
                </div>)}
              </div>}
              <div className="member-edit-line-manual">
                <label>LINE IDを変更<input value={editManualDestinationId} onChange={(event) => setEditManualDestinationId(event.target.value)} placeholder="変更時のみ完全なIDを入力" /></label>
                <label>種別<select value={editManualKind} onChange={(event) => setEditManualKind(event.target.value as 'user' | 'group' | 'room')}><option value="user">個人</option><option value="group">グループ</option><option value="room">ルーム</option></select></label>
                <button type="button" className="secondary" onClick={() => void saveManualLineDestination(member.id)} disabled={props.isPending(pendingKey.lineDestinationSet(member.id)) || !editManualDestinationId.trim()}>{props.isPending(pendingKey.lineDestinationSet(member.id)) ? <><RefreshCw className="spin" size={13} />設定中…</> : '設定'}</button>
              </div>
            </div>
            <div className="member-edit-actions"><button className="primary" onClick={() => void saveEdit(member.id)} disabled={props.isPending(pendingKey.memberUpdate(member.id))}>{props.isPending(pendingKey.memberUpdate(member.id)) ? <RefreshCw className="spin" size={15} /> : <Save size={15} />}{props.isPending(pendingKey.memberUpdate(member.id)) ? '保存中…' : '保存'}</button><button className="secondary" onClick={() => setEditingId('')} disabled={props.isPending(pendingKey.memberUpdate(member.id))}><X size={15} />キャンセル</button></div>
          </div> : <>
            <div className="member-identity">
              <div><h3>{member.name}</h3><span className={`member-state ${member.state}`}>{member.state === 'active' ? '有効' : '無効'}</span></div>
              <p><Mail size={14} />{member.email || 'メール未設定'}</p>
              <div className="member-tags">{member.tags.length ? member.tags.map((tag) => <span key={tag}>{tag}</span>) : <small>タグなし</small>}</div>
            </div>
            <div className="member-line-details">
              {member.lineDestinations.length ? member.lineDestinations.map((destination) => <div key={destination.id}><span className="line-badge"><MessageCircle size={13} />LINE {destinationKindLabel(destination.kind)}{destination.source === 'manual' ? '・手動' : ''}</span><strong>{destination.displayName || member.name}</strong><code title="LINE IDは先頭5文字のみ表示しています">{destination.destinationId}</code></div>) : <div className="member-line-empty"><MessageCircle size={15} /><span>LINE未連携</span></div>}
            </div>
            {<button type="button" className="member-edit-button" onClick={() => beginEdit(member)}><Pencil size={15} />編集</button>}
          </>}
        </article>)}
        {visibleMembers.length === 0 && <div className="member-empty"><UsersRound size={28} /><h3>{props.organizationMembers.length ? '条件に一致するメンバーがいません' : 'メンバーはまだ登録されていません'}</h3><p>{props.organizationMembers.length ? '検索条件を変更してください。' : 'LINEアカウントと氏名だけで追加できます。メールアドレスやタグは後から編集できます。'}</p></div>}
      </div>
    </section>
  </section>;
};

/** Lets an Admin accept or reject the role the AI proposed for each open Task. */
const TaskReassignmentReview = (props: DashboardProps) => {
  const proposals = props.taskReassignmentProposals;
  const [reviewed, setReviewed] = useState(proposals);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  if (reviewed !== proposals) {
    setReviewed(proposals);
    setDecisions({});
  }
  /** A Task the AI would move is accepted until the Admin says otherwise. */
  const accepted = proposals.filter((proposal) => decisions[proposal.taskId] ?? proposal.changed).map((proposal) => proposal.taskId);
  const changed = proposals.filter((proposal) => proposal.changed);
  const openTasks = props.taskReassignment.openTasks;
  const suggesting = props.isPending(pendingKey.reassignmentSuggest);
  const applying = props.isPending(pendingKey.reassignmentApply);
  const applied = props.isSettled(pendingKey.reassignmentApply);
  const skipped = props.taskReassignmentSkipped;
  const explanation = props.taskReassignment.pending
    ? `roleが変更されています。未完了タスク${openTasks}件の割り当て案をAIに出させられます。`
    : 'roleを追加・変更・削除すると、未完了タスクの割り当て案をAIに出させられます。';
  const toggle = (taskId: string, on: boolean): void =>
    setDecisions((current) => ({ ...current, [taskId]: on }));
  const apply = (): void => props.onApplyTaskReassignments(
    proposals.filter((proposal) => accepted.includes(proposal.taskId))
      .map((proposal) => ({ taskId: proposal.taskId, roleId: proposal.proposedRoleId })),
  );
  const skippedTitle = (taskId: string): string =>
    props.organizationTasks.find((task) => task.id === taskId)?.title ?? taskId;
  return <section className="task-reassignment" aria-busy={suggesting || applying}>
    <div className="task-reassignment-action">
      <div><strong>AIでタスクを再割り当て</strong><p>{explanation}</p></div>
      <button
        type="button"
        className="primary"
        onClick={props.onSuggestTaskReassignments}
        disabled={!props.taskReassignment.pending || openTasks === 0 || suggesting || applying}
      >{suggesting ? <RefreshCw className="spin" size={16} /> : null}{suggesting ? `未完了タスク${openTasks}件をAIが判定中…` : 'AIに割り当て案を出させる'}</button>
    </div>
    {suggesting && <p className="task-reassignment-progress" role="status"><RefreshCw className="spin" size={14} />AIの応答を待っています。タスク件数によっては1分ほどかかります。</p>}
    {applied && !proposals.length && <p className="dashboard-success"><CheckCircle2 size={17} />再割り当てを適用し、レビューを閉じました。</p>}
    {skipped.length > 0 && <p className="dashboard-warning"><CircleAlert size={17} />{skipped.length}件は適用できませんでした（完了済み、roleが削除済み、または同じrole・期限・タイトルのタスクと重複）：{skipped.map(skippedTitle).join('、')}</p>}
    {proposals.length > 0 && <div className="task-reassignment-proposals">
      <p className="task-reassignment-summary">{changed.length ? `${proposals.length}件のうち${changed.length}件のroleを変更する案です。適用するものを選んでください。` : `${proposals.length}件すべて現在のroleのままで良いという判定です。`}</p>
      {proposals.map((proposal) => <label key={proposal.taskId} className={proposal.changed ? 'task-reassignment-proposal changed' : 'task-reassignment-proposal'}>
        <input
          type="checkbox"
          checked={accepted.includes(proposal.taskId)}
          disabled={applying}
          aria-label={`${proposal.title}を${proposal.proposedRoleName}に割り当てる`}
          onChange={(change) => toggle(proposal.taskId, change.target.checked)}
        />
        <div>
          <strong>{proposal.title}</strong>
          <small>{proposal.sourceMessageSubject} ・ 期限 {proposal.deadline}</small>
          <p>{proposal.currentRoleName} → <strong>{proposal.proposedRoleName}</strong>{proposal.changed ? '' : '（変更なし）'}</p>
          <small>{proposal.reason}</small>
        </div>
      </label>)}
      <div className="task-reassignment-decisions">
        <button type="button" className="primary" onClick={apply} disabled={applying}>{applying ? <RefreshCw className="spin" size={16} /> : null}{applying ? `${accepted.length}件を適用中…` : `選んだ${accepted.length}件を適用`}</button>
        <button type="button" className="secondary" onClick={props.onDiscardTaskReassignments} disabled={applying}>この案を破棄</button>
      </div>
    </div>}
  </section>;
};

/** One Operational Task Role: its editable text, its holder, and its removal. */
const TaskRoleCard = ({ role, props }: { role: DashboardProps['taskRoles'][number]; props: DashboardProps }) => {
  const saving = props.isPending(pendingKey.taskRoleUpdate(role.id));
  const saved = props.isSettled(pendingKey.taskRoleUpdate(role.id));
  const assigning = props.isPending(pendingKey.taskRoleAssign(role.id));
  const assigned = props.isSettled(pendingKey.taskRoleAssign(role.id));
  const removing = props.isPending(pendingKey.taskRoleDelete(role.id));
  return <article aria-busy={saving || assigning || removing}>
    <strong>{role.displayName}</strong>
    <p>{role.description}</p>
    <details>
      <summary>名前と説明を編集<FieldSaveState saving={saving} saved={saved} /></summary>
      <label>名前<input defaultValue={role.displayName} disabled={saving} onBlur={(change) => { const displayName = change.target.value.trim(); if (displayName && displayName !== role.displayName) void props.onUpdateTaskRole(role.id, { displayName }); }} /></label>
      <label>説明<textarea defaultValue={role.description} disabled={saving} onBlur={(change) => { const description = change.target.value.trim(); if (description && description !== role.description) void props.onUpdateTaskRole(role.id, { description }); }} /></label>
    </details>
    <label>現在の担当者<select
      value={props.taskRoleAssignments.find((assignment) => assignment.roleId === role.id)?.memberId ?? ''}
      disabled={assigning}
      onChange={(change) => { if (change.target.value) props.onAssignTaskRole(role.id, change.target.value); }}
    ><option value="">未割り当て</option>{props.taskMembers.map((member) => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}</select><FieldSaveState saving={assigning} saved={assigned} /></label>
    <button type="button" className="secondary" onClick={() => void props.onDeleteTaskRole(role.id)} disabled={removing}>{removing ? <><RefreshCw className="spin" size={13} />削除中…</> : 'roleを削除'}</button>
  </article>;
};

/** One row of the Task table: its completion and its remarks each report their own save. */
const TaskRow = ({ task, props, today, near }: {
  task: DashboardProps['organizationTasks'][number];
  props: DashboardProps;
  today: string;
  near: string;
}) => {
  const saving = props.isPending(pendingKey.taskUpdate(task.id));
  const saved = props.isSettled(pendingKey.taskUpdate(task.id));
  return <tr className={task.completed ? 'completed' : task.deadline < today ? 'overdue' : task.deadline <= near ? 'near-deadline' : ''} aria-busy={saving}>
    <td><input aria-label={`${task.title}を完了`} type="checkbox" checked={task.completed} disabled={saving} onChange={(change) => props.onUpdateTask(task.id, { completed: change.target.checked })} />{saving && <RefreshCw className="spin" size={12} />}</td>
    <td>{task.deadline}</td>
    <td>{task.assigneeRoleName}</td>
    <td>{task.assigneeName}</td>
    <td>{task.sourceMessageSubject}</td>
    <td><strong>{task.title}</strong><small>{task.description}</small></td>
    <td><textarea aria-label={`${task.title}の備考`} defaultValue={task.remarks} disabled={saving} onBlur={(change) => { if (change.target.value !== task.remarks) props.onUpdateTask(task.id, { remarks: change.target.value }); }} maxLength={10_000} /><FieldSaveState saving={saving} saved={saved} /></td>
  </tr>;
};

export const TasksPage = (props: DashboardProps) => {
  const [assignee, setAssignee] = useState('');
  const [event, setEvent] = useState('');
  const [roleName, setRoleName] = useState('');
  const [roleDescription, setRoleDescription] = useState('');
  const creatingRole = props.isPending(pendingKey.taskRoleCreate);
  const assignees = [...new Map(props.organizationTasks.flatMap((task) => task.assigneeMemberId ? [[task.assigneeMemberId, task.assigneeName] as const] : [])).entries()];
  const events = [...new Set(props.organizationTasks.map((task) => task.sourceMessageSubject))];
  const visible = props.organizationTasks.filter((task) => (
    !assignee
    || (assignee === 'unassigned' ? task.assigneeRoleId === 'unassigned' : task.assigneeMemberId === assignee)
  ) && (!event || task.sourceMessageSubject === event));
  const today = new Date().toISOString().slice(0, 10);
  const near = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const createRole = async (submit: React.FormEvent): Promise<void> => {
    submit.preventDefault();
    await props.onCreateTaskRole({ displayName: roleName.trim(), description: roleDescription.trim() });
    setRoleName('');
    setRoleDescription('');
  };
  return <section className="page-layout tasks-page">
    <div className="page-title"><p>ORGANIZATION TASKS</p><h1>タスク</h1><span>Source Message から抽出された期限タスクを、担当者ごとに管理します。</span></div>
    {<section className="task-role-management">
      <form onSubmit={(submit) => void createRole(submit)}><strong>Operational Task Roleを追加</strong><label>名前<input value={roleName} onChange={(change) => setRoleName(change.target.value)} maxLength={100} required disabled={creatingRole} /></label><label>説明<textarea value={roleDescription} onChange={(change) => setRoleDescription(change.target.value)} maxLength={500} required disabled={creatingRole} /></label><button className="primary" disabled={creatingRole}>{creatingRole ? <><RefreshCw className="spin" size={14} />追加中…</> : 'roleを追加'}</button></form>
      <div className="task-role-list">{props.taskRoles.map((role) => <TaskRoleCard key={role.id} role={role} props={props} />)}</div>
    </section>}
    <TaskReassignmentReview {...props} />
    <section className="task-filters"><label>担当者<select value={assignee} onChange={(change) => setAssignee(change.target.value)}><option value="">すべて</option><option value="unassigned">未割り当て</option>{assignees.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>イベント<select value={event} onChange={(change) => setEvent(change.target.value)}><option value="">すべて</option>{events.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><button className="secondary" onClick={() => { setAssignee(''); setEvent(''); }}>フィルターをリセット</button></section>
    <section className="tasks-table-wrap"><table className="tasks-table"><thead><tr><th>完了</th><th>期限</th><th>Role</th><th>担当者</th><th>イベント名</th><th>内容</th><th>備考</th></tr></thead><tbody>{visible.map((task) => <TaskRow key={task.id} task={task} props={props} today={today} near={near} />)}</tbody></table>{visible.length === 0 && <p className="rules-empty">表示するタスクはありません。</p>}</section>
  </section>;
};

export const ConnectionsPage = (props: DashboardProps) => {
  const [webhookCopied, setWebhookCopied] = useState(false);
  const webhookCopyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savingAi = props.isPending(pendingKey.aiConnection);
  const savedAi = props.isSettled(pendingKey.aiConnection);
  const savingLine = props.isPending(pendingKey.lineConnection);
  const savedLine = props.isSettled(pendingKey.lineConnection);
  const savingFolder = props.isPending(pendingKey.attachmentFolder);
  const savedFolder = props.isSettled(pendingKey.attachmentFolder);
  const testingAi = props.isPending(pendingKey.aiTest);
  useEffect(() => () => { if (webhookCopyTimer.current) clearTimeout(webhookCopyTimer.current); }, []);
  const settingsReady = Boolean(props.organization);
  const hasAiApi = Boolean(props.connections?.ai.apiKeyConfigured);
  const hasLineAccessToken = Boolean(props.connections?.line.channelAccessTokenConfigured);
  const hasLineSecret = Boolean(props.connections?.line.channelSecretConfigured);
  const lineChanged = Boolean(props.lineChannelAccessToken || props.lineChannelSecret);
  const lineReady = Boolean(
    (props.lineChannelAccessToken || hasLineAccessToken)
    && (props.lineChannelSecret || hasLineSecret),
  );
  const aiChanged = Boolean(
    props.aiApiKey
    || props.aiModel !== (props.connections?.ai.model ?? '')
    || props.aiBaseUrl !== (props.connections?.ai.baseUrl ?? ''),
  );
  const aiReady = Boolean(props.aiBaseUrl.trim() && props.aiModel.trim() && (props.aiApiKey || hasAiApi));
  const webhookUrl = props.connections?.line.webhookUrl ?? '';
  const hasConfiguration = Boolean(
    props.organizationLists.length
    || props.organizationRules.length
    || props.taskRoles.length
    || props.prompts.length
    || props.agentRules.length,
  );
  const copyWebhookUrl = (): void => {
    if (!webhookUrl) return;
    void navigator.clipboard.writeText(webhookUrl).then(() => {
      setWebhookCopied(true);
      if (webhookCopyTimer.current) clearTimeout(webhookCopyTimer.current);
      webhookCopyTimer.current = setTimeout(() => setWebhookCopied(false), COPY_NOTICE_MS);
    });
  };
  return <section className="page-layout settings-page">
    <div className="page-title"><p>CONNECTIONS</p><h1>接続設定</h1><span>OpenAI 互換 API と LINE の資格情報はここで管理します。</span></div>
    {!settingsReady ? <section className="empty-page"><Settings size={30} /><h2>設定を読み込めません</h2><p>Googleでログインし直した後、このページを再読み込みしてください。</p></section> : <>
      <div className="settings-grid">
        <section className="settings-card"><div className="settings-card-title"><Settings size={19} /><div><h2>OpenAI 互換 API</h2><p>メールの予定抽出に使う AI です。</p></div></div><p className="api-guide">利用するサービスの OpenAI 互換 API の Base URL、model、API キーを入力してください。</p><label>Base URL<input value={props.aiBaseUrl} onChange={(event) => props.onAiBaseUrlChange(event.target.value)} placeholder="https://api.openai.com/v1" autoCapitalize="none" spellCheck={false} /></label><label>model<input value={props.aiModel} onChange={(event) => props.onAiModelChange(event.target.value)} placeholder="例: gpt-4.1-mini" autoCapitalize="none" spellCheck={false} /></label><label>API キー<SecretInput label="OpenAI 互換 API キー" value={props.aiApiKey} onChange={props.onAiApiKeyChange} placeholder={hasAiApi ? '登録済み（変更時のみ入力）' : 'API キー'} /></label><div className="settings-card-actions"><p className="connection-state">{savingAi ? <><RefreshCw className="spin" size={13} />保存中…</> : savedAi ? <><CheckCircle2 size={13} />保存しました</> : hasAiApi ? '接続設定済み' : '未設定'}</p><button className="primary" onClick={props.onSaveAiConnection} disabled={savingAi || !aiChanged || !aiReady}>{savingAi ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{savingAi ? '保存中…' : 'AI設定を保存'}</button></div></section>
        <section className="settings-card">
          <div className="settings-card-title"><Mail size={19} /><div><h2>LINE Messaging API</h2><p>LINE通知とWebhookによる宛先検出に使います。</p></div></div>
          <label>チャネルアクセストークン<SecretInput label="LINEチャネルアクセストークン" value={props.lineChannelAccessToken} onChange={props.onLineChannelAccessTokenChange} placeholder={hasLineAccessToken ? '登録済み（変更時のみ入力）' : 'チャネルアクセストークン'} /></label>
          <label>チャネルシークレット<SecretInput label="LINEチャネルシークレット" value={props.lineChannelSecret} onChange={props.onLineChannelSecretChange} placeholder={hasLineSecret ? '登録済み（変更時のみ入力）' : 'チャネルシークレット'} /></label>
          <div className="line-webhook-settings">
            <label>Webhook URL<div className="line-webhook-url"><input value={webhookUrl} readOnly aria-label="LINE Webhook URL" /><button type="button" className="secondary" onClick={copyWebhookUrl} disabled={!webhookUrl} aria-label="Webhook URLをコピー">{webhookCopied ? <CheckCircle2 size={15} /> : <Copy size={15} />}{webhookCopied ? 'コピーしました' : 'コピー'}</button></div></label>
            <ol>
              <li><a href="https://developers.line.biz/console/" target="_blank" rel="noreferrer">LINE Developers</a>で対象チャネルの「Messaging API設定」を開く</li>
              <li>上のURLを「Webhook URL」に貼り付けて検証する</li>
              <li>「Webhookの利用をオン」にする</li>
            </ol>
            <p className="line-webhook-result">受信したLINE IDは<Link to="../members">メンバー画面</Link>の「保留中のLINE連絡先」に表示されます。</p>
            {webhookUrl && !webhookUrl.startsWith('https://') && <p className="dashboard-warning">localhostはLINEから受信できません。本番の公開HTTPS URLを設定してください。</p>}
          </div>
          <div className="settings-card-actions"><p className="connection-state">{savingLine ? <><RefreshCw className="spin" size={13} />保存中…</> : savedLine ? <><CheckCircle2 size={13} />保存しました</> : hasLineAccessToken && hasLineSecret ? '接続設定済み' : '未設定'}</p><button className="primary" onClick={props.onSaveLineConnection} disabled={savingLine || !lineChanged || !lineReady}>{savingLine ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{savingLine ? '保存中…' : 'LINE設定を保存'}</button></div>
        </section>
      </div>
      <section className="settings-card"><div className="settings-card-title"><Settings size={19} /><div><h2>添付ファイルの保存先</h2><p>Google Driveのどこに添付ファイルを置くかを決めます。</p></div></div><p className="api-guide">「/」で階層を区切ります。ここで指定したフォルダの下に、メール1通ごとのフォルダを受信日と件名で作成します。Mail Automationが作成したフォルダだけを扱うため、手作業で作った同名フォルダとは別に作成されます。</p><label>保存先<input value={props.attachmentFolderPath} onChange={(event) => props.onAttachmentFolderPathChange(event.target.value)} placeholder="Mail Automation/添付ファイル" autoCapitalize="none" spellCheck={false} /></label><div className="settings-card-actions"><p className="connection-state">{savingFolder ? <><RefreshCw className="spin" size={13} />保存中…</> : savedFolder ? <><CheckCircle2 size={13} />保存しました</> : `現在: ${props.savedAttachmentFolderPath}`}</p><button className="primary" onClick={props.onSaveAttachmentFolderPath} disabled={savingFolder || !props.attachmentFolderPath.trim() || props.attachmentFolderPath === props.savedAttachmentFolderPath}>{savingFolder ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{savingFolder ? '保存中…' : '保存先を保存'}</button></div></section>
      <section className="test-card"><div><p>AI CONNECTION TEST</p><h2>OpenAI 互換 API をテスト</h2><span>保存済みの接続設定を使って、任意の質問を送信します。</span></div><textarea value={props.aiTestPrompt} onChange={(event) => props.onAiTestPromptChange(event.target.value)} maxLength={10_000} aria-label="APIへの質問" /><button className="secondary" onClick={props.onTestAi} disabled={testingAi || !hasAiApi}>{testingAi ? <><RefreshCw className="spin" size={14} />問い合わせ中…</> : 'API に質問する'}</button>{testingAi && <p className="field-state saving"><RefreshCw className="spin" size={12} />APIの応答を待っています…</p>}{props.aiTestResult && <pre>{props.aiTestResult}</pre>}</section>
      <PresetSettings
        presets={props.presets}
        hasConfiguration={hasConfiguration}
        isPending={props.isPending}
        onApply={props.onApplyPreset}
      />
    </>}
  </section>;
};

export const PresetSettings = ({ presets, hasConfiguration, isPending, onApply }: {
  presets: DashboardProps['presets'];
  hasConfiguration: boolean;
  isPending: DashboardProps['isPending'];
  onApply: DashboardProps['onApplyPreset'];
}) => {
  const [confirmed, setConfirmed] = useState(false);
  return <section className="test-card preset-settings">
    <div><p>PRESET</p><h2>Presetをコピー</h2><span>コピー後の構成は製品更新とリンクされず、このOrganizationだけで編集できます。</span></div>
    {presets.map((preset) => <article key={preset.id}>
      <strong>{preset.name}</strong><p>{preset.description}</p>
      {hasConfiguration && <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />既存の構成に別のコピーを追加する</label>}
      <button type="button" className="secondary" disabled={isPending(pendingKey.presetApply(preset.id)) || (hasConfiguration && !confirmed)} onClick={() => onApply(preset.id, hasConfiguration ? 'duplicate' : undefined)}>{isPending(pendingKey.presetApply(preset.id)) ? <><RefreshCw className="spin" size={14} />適用中…</> : 'Presetを適用'}</button>
      {isPending(pendingKey.presetApply(preset.id)) && <p className="field-state saving"><RefreshCw className="spin" size={12} />構成をコピーし、ルール・Prompt・Roleを読み直しています…</p>}
    </article>)}
  </section>;
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
 * The Event Refresh exit: an Admin sees, one Scheduled Event at a time, exactly
 * what the rewrite replaces before approving it.
 */
export const MailboxRefreshSections = (props: DashboardProps) => {
  const matching = props.isPending(pendingKey.refreshPrepare);
  const planning = props.isPending(pendingKey.refreshPlan);
  const applyingRefresh = props.isPending(pendingKey.refreshApply);
  const plan = props.mailTestRefreshPlan;
  const [selected, setSelected] = useState<number[]>([]);
  const token = plan?.confirmationToken ?? '';
  useEffect(() => {
    if (!plan) return;
    setSelected(plan.entries.filter((entry) => entry.target && entry.changedFields.length).map((entry) => entry.candidateIndex));
  }, [token]);
  if (!props.mailTestPreview) return null;
  const request = props.mailTestRefreshRequest;
  const outcome = props.mailTestRefreshOutcome;
  const toggle = (candidateIndex: number, checked: boolean): void =>
    setSelected((current) => checked ? [...new Set([...current, candidateIndex])] : current.filter((value) => value !== candidateIndex));
  return <>
    <section className="test-card event-preview">
      <div><p>5. MATCH EXISTING EVENTS</p><h2>このメールから作られた既存予定を照合</h2><span>同じメールの出典が書かれた予定だけを探します。日時が7日以上離れている予定は更新対象になりません。</span></div>
      <button className="secondary" onClick={props.onPrepareRefresh} disabled={matching}>{matching ? <><RefreshCw className="spin" size={14} />Calendarを照合中…</> : '既存予定をCalendarから探す'}</button>
      {request && <>
        <p className="mail-summary">更新対象の候補 {request.existing.length}件{request.outOfWindow.length ? ` ・ 対象外（7日以上離れている）${request.outOfWindow.length}件` : ''}</p>
        {request.outOfWindow.length > 0 && <ul className="refresh-out-of-window">{request.outOfWindow.map((event) => <li key={event.id}><ScheduledEventSummary event={event} />：日時が離れているため触りません</li>)}</ul>}
        {request.request
          ? <><pre className="ai-request">{JSON.stringify(request.request, null, 2)}</pre><div className="mail-test-actions"><button className="primary" onClick={props.onPlanRefresh} disabled={planning}>{planning ? <><RefreshCw className="spin" size={14} />API に送信中…</> : '設定済みの API で対応付けを判定'}</button></div></>
          : <p>更新できる既存予定はありません。新規作成のみ可能です。</p>}
      </>}
    </section>
    {plan && <section className="test-card event-preview">
      <div><p>6. REVIEW DIFF AND UPDATE</p><h2>差分を確認して更新</h2><span>選択した予定は参加者以外の全項目が書き換わります。手動で編集した内容も上書きされます。</span></div>
      {plan.pendingAttachments.length > 0 && <p className="dashboard-warning">添付 {plan.pendingAttachments.length}件（{plan.pendingAttachments.join('、')}）はフォルダに未配置のため、更新時に公開します。</p>}
      {plan.entries.map((entry) => <article key={entry.candidateIndex} className="refresh-entry">
        <label>
          <input
            type="checkbox"
            checked={selected.includes(entry.candidateIndex)}
            onChange={(event) => toggle(entry.candidateIndex, event.target.checked)}
          />
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
      <button className="primary" onClick={() => props.onApplyRefresh(selected)} disabled={applyingRefresh || !selected.length}>{applyingRefresh ? <RefreshCw className="spin" size={14} /> : null}{applyingRefresh ? `${selected.length}件を更新中…` : `選択した ${selected.length}件を更新`}</button>
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

export const MailboxTestPage = (props: DashboardProps) => {
  const settingsReady = Boolean(props.organization);
  const searching = props.isPending(pendingKey.mailSearch);
  const extracting = props.isPending(pendingKey.mailPreview);
  const creatingEvents = props.isPending(pendingKey.mailCreateEvents);
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
      copyFeedbackTimer.current = setTimeout(() => setAiRequestCopied(false), COPY_NOTICE_MS);
    });
  };
  return <section className="page-layout mail-test-page">
    <div className="page-title"><p>SAFE MANUAL TEST</p><h1>メールテスト</h1><span>{props.automation ? `${props.automation.email} の Gmail と Calendar だけを使用します。` : 'Googleでログインしてください。'}</span></div>
    {!settingsReady || !props.automation ? <section className="empty-page"><SlidersHorizontal size={30} /><h2>メールテストを開始できません</h2><p>Automation Inbox の Google 接続を完了してください。</p></section> : <>
      <section className="test-card"><div><p>1. FIND MAIL</p><h2>件名からメールを探す</h2><span>件名を入力してください。前後の空白や全角・半角の違いは無視されます。AI の API キーは不要です。</span></div><label>メール件名<input value={props.mailTestSubject} onChange={(event) => props.onMailTestSubjectChange(event.target.value)} maxLength={300} /></label><button className="primary" onClick={props.onSearchMailbox} disabled={searching}>{searching ? <><RefreshCw className="spin" size={14} />検索中…</> : 'Gmailを検索'}</button></section>
      {props.mailTestMatches.length > 0 && <section className="test-card"><div><p>2. PREPARE AI REQUEST</p><h2>AI への送信内容を確認</h2><span>対象メールを選ぶと、OpenAI 互換形式のリクエスト本文を生成します。この時点では AI に送信しません。</span></div><div className="mail-matches">{props.mailTestMatches.map((message) => <button key={message.id} className="mail-match" onClick={() => props.onPrepareMailbox(message.id)} disabled={props.isPending(pendingKey.mailPrepare(message.id))}><strong>{message.subject}</strong><small>{message.sender || '差出人なし'}</small>{props.isPending(pendingKey.mailPrepare(message.id)) && <small className="field-state saving"><RefreshCw className="spin" size={12} />本文と添付を読み込み中…</small>}</button>)}</div></section>}
      {props.mailTestAiRequest && <section className="test-card event-preview"><div className="ai-request-heading"><div><p>3. REVIEW OPENAI-COMPATIBLE REQUEST</p><h2>OpenAI 互換リクエスト本文</h2><span>API キーは含まれません。送信先の model を指定すれば、任意の OpenAI 互換 API で利用できます。</span></div><button className={`secondary copy-request-button${aiRequestCopied ? ' copied' : ''}`} onClick={copyPreparedAiRequest} aria-live="polite">{aiRequestCopied ? <CheckCircle2 size={16} /> : <Copy size={16} />}{aiRequestCopied ? <span key={copyFeedbackId} className="copy-feedback">コピーしました</span> : 'リクエスト全文をコピー'}</button></div><pre className="ai-request">{JSON.stringify(props.mailTestAiRequest.request, null, 2)}</pre><div className="mail-test-actions">{hasConfiguredAiApi ? <button className="primary" onClick={sendPreparedAiRequest} disabled={extracting}>{extracting ? <><RefreshCw className="spin" size={14} />API に送信中…</> : '設定済みの API で予定を抽出'}</button> : <p className="dashboard-warning api-configuration-prompt"><span>OpenAI 互換 API が設定されていません</span><Link to={props.organizationId ? `/organizations/${encodeURIComponent(props.organizationId)}/connections` : '../connections'}>APIを設定する</Link></p>}</div></section>}
      {props.mailTestPreview && <section className="test-card event-preview"><div><p>4. REVIEW AND CREATE</p><h2>要約・予定・タスク候補を確認</h2><span>予定は確認後にだけ Google Calendar へ作成します。要約とタスク候補はメール全体に対して一度だけ抽出されます。</span></div><h3>メールの要約</h3><p className="mail-summary">{props.mailTestPreview.summary}</p><h3>予定（{props.mailTestPreview.events.length}件）</h3>{props.mailTestPreview.events.map((event, index) => <dl key={`${event.title}-${event.startsAt}`}><dt>予定 {index + 1}</dt><dd>{event.title}</dd><dt>日時</dt><dd>{formatted(event.startsAt)} 〜 {formatted(event.endsAt)}</dd><dt>場所</dt><dd>{event.location || '指定なし'}</dd><dt>説明</dt><dd>{event.description || '指定なし'}</dd><dt>要約</dt><dd>{event.summary || '指定なし'}</dd></dl>)}<h3>期限タスク候補（{props.mailTestPreview.tasks.length}件）</h3>{props.mailTestPreview.tasks.length ? props.mailTestPreview.tasks.map((task) => <dl key={`${task.assigneeRoleId}-${task.deadline}-${task.title}`}><dt>{props.taskRoles.find((role) => role.id === task.assigneeRoleId)?.displayName ?? '未割り当て'}</dt><dd>{task.title}</dd><dt>期限</dt><dd>{task.deadline}</dd><dt>内容</dt><dd>{task.description}</dd></dl>) : <p>明示された登録・振込期限はありません。</p>}<button className="primary" onClick={props.onCreateCalendarEvent} disabled={creatingEvents || Boolean(props.mailTestCreatedEventIds.length)}>{creatingEvents ? <RefreshCw className="spin" size={14} /> : null}{props.mailTestCreatedEventIds.length ? 'Calendarに作成済み' : creatingEvents ? 'Calendar に作成中…' : `${props.mailTestPreview.events.length}件を Calendar に追加`}</button>{props.mailTestCreatedEventIds.length > 0 && <p className="dashboard-success"><CheckCircle2 size={17} />テスト予定 {props.mailTestCreatedEventIds.length}件を作成しました。</p>}</section>}
      {props.mailTestPreview && <MailboxRefreshSections {...props} />}
    </>}
  </section>;
};

const toggledIds = (current: string[], id: string, checked: boolean): string[] =>
  checked ? [...new Set([...current, id])] : current.filter((value) => value !== id);

const DestinationListChoices = ({
  legend,
  lists,
  selectedIds,
  onChange,
}: {
  legend: string;
  lists: DashboardProps['organizationLists'];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) => <fieldset>
  <legend>{legend}</legend>
  {lists.length
    ? lists.map((list) => <label key={list.id}><input type="checkbox" checked={selectedIds.includes(list.id)} onChange={(change) => onChange(toggledIds(selectedIds, list.id, change.target.checked))} />{list.name}<small>{list.description}</small></label>)
    : <small>利用できるリストはありません。</small>}
</fieldset>;

const RuleDestinationEditor = ({ rule, props }: {
  rule: DashboardProps['organizationRules'][number];
  props: DashboardProps;
}) => {
  const recipientLists = props.organizationLists.filter((list) => list.kind === 'recipient');
  const lineLists = props.organizationLists.filter((list) => list.kind === 'line');
  const [permittedRecipientListIds, setPermittedRecipientListIds] = useState(rule.permittedRecipientListIds);
  const [permittedLineListIds, setPermittedLineListIds] = useState(rule.permittedLineListIds);
  const saving = props.isPending(pendingKey.ruleUpdate(rule.id));
  const recipientNames = recipientLists.filter((list) => rule.permittedRecipientListIds.includes(list.id)).map((list) => list.name);
  const lineNames = lineLists.filter((list) => rule.permittedLineListIds.includes(list.id)).map((list) => list.name);
  return <>
    <small>選択中: {recipientNames.join('、') || 'Calendar Recipient Listなし'}</small>
    <small>選択中: {lineNames.join('、') || 'LINE Destination Listなし'}</small>
    <details className="rule-destination-editor">
      <summary>許可リストを編集</summary>
      <DestinationListChoices legend="許可されたCalendar Recipient Lists" lists={recipientLists} selectedIds={permittedRecipientListIds} onChange={setPermittedRecipientListIds} />
      <DestinationListChoices legend="許可されたLINE Destination Lists" lists={lineLists} selectedIds={permittedLineListIds} onChange={setPermittedLineListIds} />
      <button type="button" className="secondary" disabled={saving} onClick={() => void props.onUpdateRule(rule.id, { permittedRecipientListIds, permittedLineListIds })}>{saving ? <><RefreshCw className="spin" size={13} />保存中…</> : '許可リストを保存'}</button>
      <FieldSaveState saving={saving} saved={props.isSettled(pendingKey.ruleUpdate(rule.id))} />
    </details>
  </>;
};

const PromptEditor = ({ prompt, props }: { prompt: DashboardProps['prompts'][number]; props: DashboardProps }) => {
  const [name, setName] = useState(prompt.name);
  const [instructions, setInstructions] = useState(prompt.instructions);
  const saving = props.isPending(pendingKey.promptUpdate(prompt.id));
  const saved = props.isSettled(pendingKey.promptUpdate(prompt.id));
  const removing = props.isPending(pendingKey.promptDelete(prompt.id));
  return <article className="rule-row" aria-busy={saving || removing}>
    <div>
      <strong>{prompt.name}</strong><small>revision {prompt.revision}</small><p>{prompt.instructions}</p>
      <details>
        <summary>Promptを編集<FieldSaveState saving={saving} saved={saved} /></summary>
        <label>Prompt名<input value={name} onChange={(event) => setName(event.target.value)} disabled={saving} /></label>
        <label>Instructions<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} disabled={saving} /></label>
        <button type="button" className="secondary" disabled={saving} onClick={() => void props.onUpdatePrompt(prompt.id, { name, instructions })}>{saving ? <><RefreshCw className="spin" size={13} />保存中…</> : 'Promptを保存'}</button>
      </details>
    </div>
    <button type="button" className="secondary" disabled={removing} onClick={() => void props.onDeletePrompt(prompt.id)}>{removing ? <><RefreshCw className="spin" size={13} />削除中…</> : 'Promptを削除'}</button>
  </article>;
};

const AgentRuleEditor = ({ rule, props }: { rule: DashboardProps['agentRules'][number]; props: DashboardProps }) => {
  const recipientLists = props.organizationLists.filter((list) => list.kind === 'recipient');
  const lineLists = props.organizationLists.filter((list) => list.kind === 'line');
  const [recipientIds, setRecipientIds] = useState(rule.permittedRecipientListIds);
  const [lineIds, setLineIds] = useState(rule.permittedLineListIds);
  const saving = props.isPending(pendingKey.agentRuleUpdate(rule.id));
  const saved = props.isSettled(pendingKey.agentRuleUpdate(rule.id));
  return <details className="rule-destination-editor">
    <summary>Execution Mode・許可リストを編集<FieldSaveState saving={saving} saved={saved} /></summary>
    <label>Execution Mode<select value={rule.executionMode} disabled={saving} onChange={(event) => void props.onUpdateAgentRule(rule.id, { executionMode: event.target.value as 'read_only' | 'approval' | 'unattended' })}><option value="read_only">Read only</option><option value="approval">Approval</option><option value="unattended">Unattended</option></select></label>
    <DestinationListChoices legend="許可されたCalendar Recipient Lists" lists={recipientLists} selectedIds={recipientIds} onChange={setRecipientIds} />
    <DestinationListChoices legend="許可されたLINE Destination Lists" lists={lineLists} selectedIds={lineIds} onChange={setLineIds} />
    <button type="button" className="secondary" disabled={saving} onClick={() => void props.onUpdateAgentRule(rule.id, { permittedRecipientListIds: recipientIds, permittedLineListIds: lineIds })}>{saving ? <><RefreshCw className="spin" size={13} />保存中…</> : '許可リストを保存'}</button>
  </details>;
};

const AgentRunHistory = (props: DashboardProps) => {
  const runId = props.agentTranscript?.runId;
  const pending = props.proposedActions.filter((action) => action.status === 'pending');
  const deciding = (actionId: string, decision: 'approve' | 'reject'): boolean => props.isPending(pendingKey.actionDecision(actionId, decision));
  const decidingAction = (actionId: string): boolean => deciding(actionId, 'approve') || deciding(actionId, 'reject');
  const decidingBatch = (decision: 'approve' | 'reject'): boolean => Boolean(runId) && props.isPending(pendingKey.actionBatch(runId ?? '', decision));
  const decidingEitherBatch = decidingBatch('approve') || decidingBatch('reject');
  return <section className="rules-list">
    <div className="rules-list-title"><h2>Run Transcripts</h2><span>{props.agentRuns.length}件</span></div>
    {props.agentRuns.map((run) => <article className="rule-row" key={run.id}>
      <div><strong>{props.agentRules.find((rule) => rule.id === run.agentRuleId)?.name ?? run.agentRuleId}</strong><small>{run.outcome} ・ {run.model} ・ tools {run.toolCallCount} ・ tokens {run.tokens}</small></div>
      <button type="button" className="secondary" disabled={props.isPending(pendingKey.agentRunTranscript(run.id))} onClick={() => props.onLoadAgentTranscript(run.id)}>{props.isPending(pendingKey.agentRunTranscript(run.id)) ? <><RefreshCw className="spin" size={13} />読込中…</> : 'Run Transcriptを読む'}</button>
    </article>)}
    {props.agentTranscript && <article className="test-card">
      <div><p>RUN TRANSCRIPT</p><h2>{props.agentTranscript.source.subject}</h2></div>
      <pre>{props.agentTranscript.source.body}</pre>
      {props.agentTranscript.source.attachments.map((attachment) => <pre key={attachment.filename}>{attachment.filename}{'\n'}{attachment.text}</pre>)}
      <pre>{props.agentTranscript.finalOutput || props.agentTranscript.error}</pre>
      {props.proposedActions.length > 0 && <section aria-busy={decidingEitherBatch}>
        <h3>Proposed Actions</h3>
        {pending.length > 1 && runId && <div>
          <button type="button" className="primary" disabled={decidingEitherBatch} onClick={() => props.onDecideProposedActionBatch(runId, 'approve')}>{decidingBatch('approve') ? <><RefreshCw className="spin" size={14} />すべて承認中…</> : 'すべて承認'}</button>
          <button type="button" className="secondary" disabled={decidingEitherBatch} onClick={() => props.onDecideProposedActionBatch(runId, 'reject')}>{decidingBatch('reject') ? <><RefreshCw className="spin" size={14} />すべて却下中…</> : 'すべて却下'}</button>
        </div>}
        {props.proposedActions.map((action) => <article key={action.id} aria-busy={decidingAction(action.id)}>
          <strong>{action.tool}</strong><small>{action.status} ・ expires {action.expiresAt}</small>
          <pre>{JSON.stringify(action.arguments, null, 2)}</pre>
          {action.status === 'pending' && <div>
            <button type="button" className="primary" disabled={decidingAction(action.id) || decidingEitherBatch} onClick={() => props.onDecideProposedAction(action.id, 'approve')}>{deciding(action.id, 'approve') ? <><RefreshCw className="spin" size={14} />承認中…</> : '承認'}</button>
            <button type="button" className="secondary" disabled={decidingAction(action.id) || decidingEitherBatch} onClick={() => props.onDecideProposedAction(action.id, 'reject')}>{deciding(action.id, 'reject') ? <><RefreshCw className="spin" size={14} />却下中…</> : '却下'}</button>
          </div>}
        </article>)}
      </section>}
    </article>}
  </section>;
};

export const RulesPage = (props: DashboardProps) => {
  const settingsReady = Boolean(props.organization);
  const creatingRule = props.isPending(pendingKey.ruleCreate);
  const creatingPrompt = props.isPending(pendingKey.promptCreate);
  const creatingAgentRule = props.isPending(pendingKey.agentRuleCreate);
  const [ruleName, setRuleName] = useState('');
  const [ruleSender, setRuleSender] = useState('');
  const [ruleDomain, setRuleDomain] = useState('');
  const [ruleKeyword, setRuleKeyword] = useState('');
  const [ruleLabel, setRuleLabel] = useState('');
  const [rulePriority, setRulePriority] = useState('0');
  const [ruleState, setRuleState] = useState<'draft' | 'active'>('draft');
  const [taskRoleIds, setTaskRoleIds] = useState<string[]>(props.taskRoles.map((role) => role.id));
  const [permittedRecipientListIds, setPermittedRecipientListIds] = useState<string[]>([]);
  const [permittedLineListIds, setPermittedLineListIds] = useState<string[]>([]);
  const [promptName, setPromptName] = useState('');
  const [promptInstructions, setPromptInstructions] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentPromptId, setAgentPromptId] = useState(props.prompts[0]?.id ?? '');
  const [agentDomain, setAgentDomain] = useState('');
  const [agentState, setAgentState] = useState<'active' | 'suspended'>('active');
  const [agentExecutionMode, setAgentExecutionMode] = useState<'read_only' | 'approval' | 'unattended'>('approval');
  const [agentRecipientListIds, setAgentRecipientListIds] = useState<string[]>([]);
  const [agentLineListIds, setAgentLineListIds] = useState<string[]>([]);
  const recipientLists = props.organizationLists.filter((list) => list.kind === 'recipient');
  const lineLists = props.organizationLists.filter((list) => list.kind === 'line');
  const createRule = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const selectionPolicy = Object.fromEntries(Object.entries({ sender: ruleSender.trim(), domain: ruleDomain.trim(), keyword: ruleKeyword.trim(), label: ruleLabel.trim() }).filter(([, value]) => value));
    await props.onCreateRule({ name: ruleName, state: ruleState, selectionPolicy, routingPolicy: {}, taskRoleIds, permittedRecipientListIds, permittedLineListIds, priority: Number.parseInt(rulePriority, 10) || 0 });
    setRuleName(''); setRuleSender(''); setRuleDomain(''); setRuleKeyword(''); setRuleLabel(''); setRulePriority('0'); setRuleState('draft'); setPermittedRecipientListIds([]); setPermittedLineListIds([]);
  };
  const createPrompt = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    await props.onCreatePrompt({ name: promptName, instructions: promptInstructions });
    setPromptName(''); setPromptInstructions('');
  };
  const createAgentRule = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    await props.onCreateAgentRule({ name: agentName, promptId: agentPromptId, state: agentState, executionMode: agentExecutionMode, selectionPolicy: agentDomain.trim() ? { domain: agentDomain.trim() } : {}, permittedRecipientListIds: agentRecipientListIds, permittedLineListIds: agentLineListIds });
    setAgentName(''); setAgentDomain(''); setAgentRecipientListIds([]); setAgentLineListIds([]);
  };
  return <section className="page-layout rules-page">
    <div className="page-title"><p>AUTOMATION RULES</p><h1>ルールセット</h1><span>どのメールを予定化するかを、送信者・ドメイン・キーワード・Gmailラベルで指定します。</span></div>
    {!settingsReady ? <section className="empty-page"><SlidersHorizontal size={30} /><h2>ルールを読み込めません</h2><p>Googleでログインし直した後、このページを再読み込みしてください。</p></section> : <>
      <form className="rule-builder" onSubmit={(event) => void createRule(event)}><div><p>NEW RULE</p><h2>ルールを作成</h2><span>下書きで作成してから有効化できます。</span></div><label>ルール名<input value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder="例: ローターアクト行事" required /></label><div className="rule-grid"><label>送信者（完全一致）<input value={ruleSender} onChange={(event) => setRuleSender(event.target.value)} placeholder="sender@example.com" /></label><label>送信元ドメイン<input value={ruleDomain} onChange={(event) => setRuleDomain(event.target.value)} placeholder="example.com" /></label><label>本文・件名のキーワード<input value={ruleKeyword} onChange={(event) => setRuleKeyword(event.target.value)} placeholder="例: 招待行事" /></label><label>Gmailラベル<input value={ruleLabel} onChange={(event) => setRuleLabel(event.target.value)} placeholder="例: Announcements" /></label><label>優先度<input type="number" value={rulePriority} onChange={(event) => setRulePriority(event.target.value)} /></label><label>作成時の状態<select value={ruleState} onChange={(event) => setRuleState(event.target.value as 'draft' | 'active')}><option value="draft">下書き</option><option value="active">有効</option></select></label></div><DestinationListChoices legend="許可されたCalendar Recipient Lists" lists={recipientLists} selectedIds={permittedRecipientListIds} onChange={setPermittedRecipientListIds} /><DestinationListChoices legend="許可されたLINE Destination Lists" lists={lineLists} selectedIds={permittedLineListIds} onChange={setPermittedLineListIds} /><fieldset><legend>割り当て可能なOperational Task Roles</legend>{props.taskRoles.map((role) => <label key={role.id}><input type="checkbox" checked={taskRoleIds.includes(role.id)} onChange={(change) => setTaskRoleIds((current) => toggledIds(current, role.id, change.target.checked))} />{role.displayName}<small>{role.description}</small></label>)}</fieldset><button className="primary" disabled={creatingRule}>{creatingRule ? <><RefreshCw className="spin" size={14} />作成中…</> : 'ルールを作成'}</button></form>
      <section className="rules-list"><div className="rules-list-title"><h2>登録済みルール</h2><span>{props.organizationRules.length}件</span></div>{props.organizationRules.length ? props.organizationRules.map((rule) => <article key={rule.id} className="rule-row"><div><strong>{rule.name}</strong><small>優先度 {rule.priority} ・ {Object.entries(rule.selectionPolicy).map(([key, value]) => `${key}: ${String(value)}`).join(' / ') || '条件なし'}</small><small>選択Role: {props.taskRoles.filter((role) => rule.taskRoleIds.includes(role.id)).map((role) => role.displayName).join('、') || '未割り当てのみ'}</small><RuleDestinationEditor rule={rule} props={props} /></div><span className={`rule-state ${rule.state}`}>{rule.state}</span></article>) : <p className="rules-empty">まだルールはありません。</p>}</section>
      <form className="rule-builder" onSubmit={(event) => void createPrompt(event)}><div><p>PROMPTS</p><h2>Promptを作成</h2><span>Agent Ruleが実行直前に読むOrganization固有の指示です。</span></div><label>Prompt名<input required value={promptName} onChange={(event) => setPromptName(event.target.value)} /></label><label>Instructions<textarea required value={promptInstructions} onChange={(event) => setPromptInstructions(event.target.value)} /></label><button className="primary" disabled={creatingPrompt}>{creatingPrompt ? <><RefreshCw className="spin" size={14} />作成中…</> : 'Promptを作成'}</button></form>
      <section className="rules-list"><div className="rules-list-title"><h2>Prompts</h2><span>{props.prompts.length}件</span></div>{props.prompts.map((prompt) => <PromptEditor key={prompt.id} prompt={prompt} props={props} />)}</section>
      <form className="rule-builder" onSubmit={(event) => void createAgentRule(event)}><div><p>AGENT RULE</p><h2>Agent Ruleを作成</h2><span>既定は、外部効果の前に内容を確認できるApprovalです。</span></div><label>Agent Rule名<input required value={agentName} onChange={(event) => setAgentName(event.target.value)} /></label><label>Prompt<select required value={agentPromptId} onChange={(event) => setAgentPromptId(event.target.value)}><option value="">選択してください</option>{props.prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}</select></label><label>送信元ドメイン<input value={agentDomain} onChange={(event) => setAgentDomain(event.target.value)} placeholder="example.com" /></label><label>Execution Mode<select value={agentExecutionMode} onChange={(event) => setAgentExecutionMode(event.target.value as 'read_only' | 'approval' | 'unattended')}><option value="read_only">Read only</option><option value="approval">Approval</option><option value="unattended">Unattended</option></select></label><label>状態<select value={agentState} onChange={(event) => setAgentState(event.target.value as 'active' | 'suspended')}><option value="active">Active</option><option value="suspended">Suspended</option></select></label><DestinationListChoices legend="許可されたCalendar Recipient Lists" lists={recipientLists} selectedIds={agentRecipientListIds} onChange={setAgentRecipientListIds} /><DestinationListChoices legend="許可されたLINE Destination Lists" lists={lineLists} selectedIds={agentLineListIds} onChange={setAgentLineListIds} /><button className="primary" disabled={creatingAgentRule || !agentPromptId}>{creatingAgentRule ? <><RefreshCw className="spin" size={14} />作成中…</> : 'Agent Ruleを作成'}</button></form>
      <section className="rules-list"><div className="rules-list-title"><h2>Agent Rules</h2><span>{props.agentRules.length}件</span></div>{props.agentRules.map((rule) => <article className="rule-row" key={rule.id}><div><strong>{rule.name}</strong><small>Prompt: {props.prompts.find((prompt) => prompt.id === rule.promptId)?.name ?? rule.promptId} ・ {rule.executionMode} ・ revision {rule.revision}</small><AgentRuleEditor rule={rule} props={props} /></div><div className="rule-state-control"><select aria-label={`${rule.name}の状態`} value={rule.state} disabled={props.isPending(pendingKey.agentRuleUpdate(rule.id))} onChange={(event) => void props.onUpdateAgentRule(rule.id, { state: event.target.value as 'active' | 'suspended' | 'archived' })}><option value="active">Active</option><option value="suspended">Suspended</option><option value="archived">Archived</option></select><FieldSaveState saving={props.isPending(pendingKey.agentRuleUpdate(rule.id))} saved={props.isSettled(pendingKey.agentRuleUpdate(rule.id))} /></div></article>)}</section>
      <AgentRunHistory {...props} />
    </>}
  </section>;
};

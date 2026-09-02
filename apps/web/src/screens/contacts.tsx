import { CircleAlert, Mail, MessageCircle, Pencil, RefreshCw, Save, Search, SlidersHorizontal, Trash2, UserPlus, UsersRound, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { ChannelTestTarget, Connections, Contact, ContactInput, ContactUpdate, LineHandleInput, LineHandleKind, LineHandleRecord, ListKind, TypedList } from '@mail/domain';

import { api } from '../api';
import { ContactChannelTest } from '../channel';
import { accountIdOf, useAccount } from '../dashboard';
import { OperationError } from '../parts';
import { pendingKey, usePendingOperations, type PendingOperations } from '../pending';
import { PendingOverlay } from '../progress';

export interface ContactsData {
  contacts: Contact[];
  lineHandles: LineHandleRecord[];
  connections: Connections;
  lists: TypedList[];
  channelTargets: ChannelTestTarget[];
}

export const loader = async (args: LoaderFunctionArgs): Promise<ContactsData> => {
  const accountId = accountIdOf(args);
  const [contacts, lineHandles, connections, lists, channelTargets] = await Promise.all([
    api.contacts(accountId),
    api.lineHandles(accountId),
    api.connections(accountId),
    api.lists(accountId),
    api.channelTestTargets(accountId),
  ]);
  return { contacts, lineHandles, connections, lists, channelTargets };
};

const normalizeSearch = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/gu, '');
const handleKindLabel = (kind: LineHandleKind): string =>
  kind === 'user' ? '個人' : kind === 'group' ? 'グループ' : 'ルーム';

/**
 * Typed Lists, which the GUI could offer as choices but never create (ADR 0167).
 * They are on the way out with ADR 0147; until then an Account that is asked to
 * pick one needs somewhere to make one.
 */
const TypedListManager = ({ lists, operations, onCreate }: { lists: readonly TypedList[]; operations: PendingOperations; onCreate: (kind: ListKind, name: string) => void }) => {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ListKind>('recipient');
  const saving = operations.pending(pendingKey.listCreate);
  return <section className="settings-card">
    <div className="settings-card-title"><SlidersHorizontal size={19} /><div>
      <h2>Typed List</h2><p>ルールの許可リストに使う、宛先の集合です。</p>
    </div></div>
    <label>種類<select value={kind} disabled={saving} onChange={(event) => setKind(event.target.value as ListKind)}>
      <option value="recipient">Calendar Recipient List</option>
      <option value="line">LINE Destination List</option>
      <option value="source">Source List</option>
    </select></label>
    <label>リスト名<input value={name} disabled={saving} onChange={(event) => setName(event.target.value)} /></label>
    <div className="settings-card-actions">
      <p className="connection-state">{lists.length}件</p>
      <button type="button" className="secondary" disabled={saving || !name.trim()} onClick={() => { onCreate(kind, name.trim()); setName(''); }}>{saving ? <><RefreshCw className="spin" size={13} />作成中…</> : 'リストを作成'}</button>
    </div>
    {lists.map((list) => <p key={list.id} className="connection-state">{list.name}（{list.kind}）</p>)}
  </section>;
};

/** Taking the roster in and out as CSV, which the Worker served and nothing offered. */
const ContactCsv = ({ accountId, operations, onImported }: { accountId: string; operations: PendingOperations; onImported: () => Promise<void> }) => {
  const [csv, setCsv] = useState('');
  const [outcome, setOutcome] = useState('');
  const busy = operations.pending(pendingKey.contactImport);
  const run = (mode: 'preview' | 'import'): void => void operations.run(pendingKey.contactImport, async () => {
    setOutcome('');
    const result = mode === 'preview'
      ? await api.contactImportPreview(accountId, csv)
      : await api.importContacts(accountId, csv);
    setOutcome(JSON.stringify(result, null, 2));
    if (mode === 'import') await onImported();
  });
  return <section className="settings-card">
    <div className="settings-card-title"><UsersRound size={19} /><div>
      <h2>CSV で入出力</h2><p>取り込む前に、受け入れられる行と弾かれる行を確認できます。</p>
    </div></div>
    <label>CSV<textarea value={csv} rows={4} disabled={busy} onChange={(event) => setCsv(event.target.value)} placeholder="name,email,description" /></label>
    <div className="settings-card-actions">
      <button type="button" className="secondary" disabled={busy || !csv.trim()} onClick={() => run('preview')}>取り込み結果を確認</button>
      <button type="button" className="primary" disabled={busy || !csv.trim()} onClick={() => run('import')}>{busy ? <RefreshCw className="spin" size={15} /> : null}取り込む</button>
      <a className="secondary" href={api.contactExportUrl(accountId)}>CSV を書き出す</a>
    </div>
    {outcome && <pre>{outcome}</pre>}
  </section>;
};

/** One Contact being edited in place: its fields, and the LINE handle it holds. */
const ContactEditor = ({ contact, operations, onSave, onSetHandle, onUnlinkHandle, onCancel }: {
  contact: Contact;
  operations: PendingOperations;
  onSave: (contactId: string, input: ContactUpdate) => void;
  onSetHandle: (contactId: string, input: LineHandleInput) => void;
  onUnlinkHandle: (contactId: string, lineDestinationId: string) => void;
  onCancel: () => void;
}) => {
  const [name, setName] = useState(contact.name);
  const [email, setEmail] = useState(contact.email === '***' ? '' : contact.email);
  const [description, setDescription] = useState(contact.description);
  const [tags, setTags] = useState(contact.tags.join(', '));
  const [state, setState] = useState<'active' | 'inactive'>(contact.state);
  const [handleId, setHandleId] = useState('');
  const [handleKind, setHandleKind] = useState<LineHandleKind>(contact.lineDestinations.find((handle) => handle.source === 'manual')?.kind ?? 'user');
  const saving = operations.pending(pendingKey.contactUpdate(contact.id));
  const settingHandle = operations.pending(pendingKey.lineDestinationSet(contact.id));
  return <div className="member-edit-form">
    <div className="member-edit-grid">
      <label>名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>メールアドレス<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>説明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="どういう連絡先かを書きます" /></label>
      <label>分類タグ<input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
      <label>状態<select value={state} onChange={(event) => setState(event.target.value as 'active' | 'inactive')}><option value="active">有効</option><option value="inactive">無効</option></select></label>
    </div>
    <div className="member-edit-line">
      <p>LINE連携</p>
      {contact.lineDestinations.length > 0 && <div className="member-edit-line-list">
        {contact.lineDestinations.map((handle) => <div key={handle.id}>
          <span className="line-badge"><MessageCircle size={13} />{handleKindLabel(handle.kind)}{handle.source === 'manual' ? '・手動登録' : ''}</span>
          <code>{handle.destinationId}</code>
          <button type="button" className="member-line-unlink" onClick={() => onUnlinkHandle(contact.id, handle.id)} disabled={operations.pending(pendingKey.lineDestinationUnlink(handle.id))}>{operations.pending(pendingKey.lineDestinationUnlink(handle.id)) ? <><RefreshCw className="spin" size={13} />解除中…</> : <><X size={13} />解除</>}</button>
        </div>)}
      </div>}
      <div className="member-edit-line-manual">
        <label>LINE IDを変更<input value={handleId} onChange={(event) => setHandleId(event.target.value)} placeholder="変更時のみ完全なIDを入力" /></label>
        <label>種別<select value={handleKind} onChange={(event) => setHandleKind(event.target.value as LineHandleKind)}><option value="user">個人</option><option value="group">グループ</option><option value="room">ルーム</option></select></label>
        <button type="button" className="secondary" onClick={() => onSetHandle(contact.id, { destinationId: handleId.trim(), kind: handleKind })} disabled={settingHandle || !handleId.trim()}>{settingHandle ? <><RefreshCw className="spin" size={13} />設定中…</> : '設定'}</button>
      </div>
    </div>
    <div className="member-edit-actions"><button className="primary" onClick={() => onSave(contact.id, { name: name.trim(), email: email.trim(), description: description.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), state })} disabled={saving}>{saving ? <RefreshCw className="spin" size={15} /> : <Save size={15} />}{saving ? '保存中…' : '保存'}</button><button className="secondary" onClick={onCancel} disabled={saving}><X size={15} />キャンセル</button></div>
  </div>;
};

/** The roster, Channel handles, Typed Lists, and CSV: everything about who the product can reach (ADR 0167). */
const ContactsScreen = () => {
  const data = useLoaderData<ContactsData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const reload = (): Promise<void> => revalidator.revalidate();
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [selectedHandleId, setSelectedHandleId] = useState('');
  const [poolHandleId, setPoolHandleId] = useState('');
  const [poolKind, setPoolKind] = useState<LineHandleKind>('user');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [editingId, setEditingId] = useState('');
  const [removingId, setRemovingId] = useState('');
  const refreshing = operations.pending(pendingKey.contactRefresh);
  const creatingContact = operations.pending(pendingKey.contactCreate);
  const registeringHandle = operations.pending(pendingKey.lineDestinationRegister);
  const unassigned = data.lineHandles.filter((handle) => handle.status === 'discovered' && !handle.contactId);
  const searchToken = normalizeSearch(query);
  const visible = data.contacts.filter((contact) => {
    if (stateFilter !== 'all' && contact.state !== stateFilter) return false;
    if (!searchToken) return true;
    return normalizeSearch([
      contact.name,
      contact.email,
      ...contact.tags,
      ...contact.lineDestinations.flatMap((handle) => [handle.displayName, handle.destinationId]),
    ].join(' ')).includes(searchToken);
  });
  const withEmail = data.contacts.filter((contact) => contact.email && contact.email !== '***').length;
  const linkedToLine = data.contacts.filter((contact) => contact.lineDestinations.length > 0).length;
  // A Contact the product cannot reach is not an error anywhere, so it has to be
  // stated here or it is never stated at all (ADR 0167).
  const unreachable = data.contacts.filter((contact) =>
    contact.state === 'active' && !contact.email.trim() && contact.lineDestinations.length === 0);
  const lineConfigured = data.connections.line.channelAccessTokenConfigured && data.connections.line.channelSecretConfigured;

  const act = (key: string, work: () => Promise<unknown>): void => void operations.run(key, async () => { await work(); await reload(); });
  const selectHandle = (id: string): void => {
    setSelectedHandleId(id);
    const handle = unassigned.find((value) => value.id === id);
    if (handle?.displayName) setName(handle.displayName);
  };
  const promoteHandle = (id: string): void => {
    selectHandle(id);
    nameInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    nameInputRef.current?.focus();
  };
  const registerPending = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!poolHandleId.trim()) return;
    act(pendingKey.lineDestinationRegister, async () => {
      await api.registerLineHandle(accountId, { destinationId: poolHandleId.trim(), kind: poolKind });
      setPoolHandleId('');
      setPoolKind('user');
    });
  };
  const createContact = (event: React.FormEvent): void => {
    event.preventDefault();
    const input: ContactInput = {
      name: name.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
      description: description.trim(),
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      ...(selectedHandleId ? { lineDestinationId: selectedHandleId } : {}),
    };
    act(pendingKey.contactCreate, async () => {
      await api.createContact(accountId, input);
      setSelectedHandleId('');
      setName('');
      setEmail('');
      setDescription('');
      setTags('');
    });
  };
  const saveContact = (contactId: string, input: ContactUpdate): void => act(pendingKey.contactUpdate(contactId), async () => {
    await api.updateContact(accountId, contactId, input);
    setEditingId('');
  });
  const deleteContact = (contactId: string): void => act(pendingKey.contactDelete(contactId), async () => {
    await api.deleteContact(accountId, contactId);
    setRemovingId('');
  });

  return <section className="page-layout members-page">
    <PendingOverlay running={operations.running} />
    <OperationError error={operations.error} />
    <div className="page-title"><p>CONTACT ROSTER</p><h1>連絡先</h1><span>LINEで見つけた表示名・ユーザーIDに、名称、メールアドレス、分類を紐付けます。個人でもグループでも同じ一件です。</span></div>
    <section className="member-metrics">
      <div><span className="member-metric-icon green"><UsersRound size={18} /></span><p><b>{data.contacts.length}</b><small>登録済みの連絡先</small></p></div>
      <div><span className="member-metric-icon blue"><MessageCircle size={18} /></span><p><b>{linkedToLine}</b><small>LINE紐付け済み</small></p></div>
      <div><span className="member-metric-icon amber"><Mail size={18} /></span><p><b>{withEmail}</b><small>メール設定済み</small></p></div>
      <div><span className="member-metric-icon violet"><UserPlus size={18} /></span><p><b>{unassigned.length}</b><small>未登録のLINE</small></p></div>
    </section>

    <section className="member-onboarding">
      <div className="member-onboarding-copy">
        <span className="line-mark">LINE</span>
        <div><p>LINEから連絡先を追加</p><h2>{unassigned.length ? `${unassigned.length}件のLINEアカウントが登録待ちです` : 'LINEアカウントの受信を待っています'}</h2><span>公式アカウントにメッセージが届くと、表示名とIDを自動取得します。手動でも登録できます。</span></div>
        <button type="button" className="secondary member-refresh" onClick={() => act(pendingKey.contactRefresh, async () => undefined)} disabled={refreshing}><RefreshCw className={refreshing ? 'spin' : ''} size={16} />{refreshing ? '更新中…' : '更新'}</button>
      </div>
      {!lineConfigured && <p className="dashboard-warning member-connection-warning">LINE Messaging APIが未設定です。<Link to="../connections">接続設定を開く</Link></p>}

      <div className="pending-line-pool">
        <p>保留中のLINE連絡先</p>
        {unassigned.length > 0 ? <div className="pending-line-list">
          {unassigned.map((handle) => <div key={handle.id}>
            <span className="line-badge"><MessageCircle size={13} />{handleKindLabel(handle.kind)}{handle.source === 'manual' ? '・手動登録' : '・Webhook検出'}</span>
            <strong>{handle.displayName || '表示名未取得'}</strong>
            <code>{handle.destinationId}</code>
            <button type="button" className="secondary" onClick={() => promoteHandle(handle.id)}><UserPlus size={13} />連絡先として登録</button>
            <button type="button" className="member-line-unlink" onClick={() => act(pendingKey.lineDestinationRemove(handle.id), () => api.removeLineHandle(accountId, handle.id))} disabled={operations.pending(pendingKey.lineDestinationRemove(handle.id))}>{operations.pending(pendingKey.lineDestinationRemove(handle.id)) ? <><RefreshCw className="spin" size={13} />削除中…</> : <><X size={13} />削除</>}</button>
          </div>)}
        </div> : <p className="pending-line-empty">Webhookでの受信、または下のフォームからの手動登録を待っています。</p>}
        <form className="pending-line-form" onSubmit={registerPending}>
          <label>LINE IDを手動で登録<input value={poolHandleId} onChange={(event) => setPoolHandleId(event.target.value)} placeholder="例: U4af498062xxxxxxxxxxxxxxxxxxxxxx" /></label>
          <label>種別<select value={poolKind} onChange={(event) => setPoolKind(event.target.value as LineHandleKind)}><option value="user">個人</option><option value="group">グループ</option><option value="room">ルーム</option></select></label>
          <button type="submit" className="secondary" disabled={registeringHandle || !poolHandleId.trim()}>{registeringHandle ? <><RefreshCw className="spin" size={13} />追加中…</> : '追加'}</button>
        </form>
        <small>友だち追加前やWebhook未設定でも、既知のLINE IDを先に登録しておけます。氏名やメールは下のフォームで後から設定してください。</small>
      </div>

      <form className="member-create-form" onSubmit={createContact}>
        <label className="member-line-select">LINEアカウント<select value={selectedHandleId} onChange={(event) => selectHandle(event.target.value)}><option value="">LINEなしで登録</option>{unassigned.map((handle) => <option key={handle.id} value={handle.id}>{handle.displayName || '表示名未取得'} · {handleKindLabel(handle.kind)} · {handle.destinationId}</option>)}</select></label>
        <label>名称<input ref={nameInputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="例: 山田 太郎 / ○○グループ" required /></label>
        <label>メールアドレス（任意）<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="後から設定できます" /></label>
        <label>説明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例: 会計を見ている人 / 全員が入っているグループ" /></label>
        <label>分類タグ<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例: 2026年度, 全体連絡" /></label>
        <button className="primary" disabled={creatingContact}>{creatingContact ? <RefreshCw className="spin" size={16} /> : <UserPlus size={16} />}{creatingContact ? '登録中…' : '連絡先を追加'}</button>
      </form>
    </section>

    <section className="member-directory">
      <div className="member-directory-heading"><div><p>CONTACT DIRECTORY</p><h2>連絡先一覧</h2></div><span>{visible.length} / {data.contacts.length}件</span></div>
      {unreachable.length > 0 && <p className="dashboard-warning">
        <CircleAlert size={16} />
        <span>{unreachable.map((contact) => contact.name).join('、')}にはメールアドレスも LINE もありません。要約もリマインドも届きません。</span>
      </p>}
      <div className="member-filters">
        <label className="member-search"><Search size={16} /><input aria-label="連絡先を検索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前・メール・LINE IDで検索" /></label>
        <select aria-label="状態で絞り込み" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}><option value="all">すべての状態</option><option value="active">有効</option><option value="inactive">無効</option></select>
      </div>
      <div className="member-list">
        {visible.map((contact) => <article key={contact.id} className={`member-card ${contact.state}`}>
          <div className="member-avatar" aria-hidden="true">{contact.name.trim().slice(0, 1) || '?'}</div>
          {editingId === contact.id ? <ContactEditor
            contact={contact}
            operations={operations}
            onSave={saveContact}
            onSetHandle={(contactId, input) => act(pendingKey.lineDestinationSet(contactId), () => api.setContactLineHandle(accountId, contactId, input))}
            onUnlinkHandle={(contactId, lineDestinationId) => act(pendingKey.lineDestinationUnlink(lineDestinationId), () => api.removeContactLineHandle(accountId, contactId, lineDestinationId))}
            onCancel={() => setEditingId('')}
          /> : <>
            <div className="member-identity">
              <div><h3>{contact.name}</h3><span className={`member-state ${contact.state}`}>{contact.state === 'active' ? '有効' : '無効'}</span></div>
              <p><Mail size={14} />{contact.email || 'メール未設定'}</p>
              {contact.description && <p className="member-description">{contact.description}</p>}
              <div className="member-tags">{contact.tags.length ? contact.tags.map((tag) => <span key={tag}>{tag}</span>) : <small>タグなし</small>}</div>
            </div>
            <div className="member-line-details">
              {contact.lineDestinations.length ? contact.lineDestinations.map((handle) => <div key={handle.id}><span className="line-badge"><MessageCircle size={13} />LINE {handleKindLabel(handle.kind)}{handle.source === 'manual' ? '・手動' : ''}</span><strong>{handle.displayName || contact.name}</strong><code title="LINE IDは先頭5文字のみ表示しています">{handle.destinationId}</code></div>) : <div className="member-line-empty"><MessageCircle size={15} /><span>LINE未連携</span></div>}
            </div>
            <div className="member-card-actions">
              <button type="button" className="member-edit-button" onClick={() => { setRemovingId(''); setEditingId(contact.id); }}><Pencil size={15} />編集</button>
              <button type="button" className="member-edit-button member-delete-button" aria-label={`${contact.name}を削除`} onClick={() => setRemovingId(contact.id)} disabled={removingId === contact.id}><Trash2 size={15} />削除</button>
            </div>
            {removingId === contact.id && <div className="member-delete-confirm" role="alertdialog" aria-label={`${contact.name}の削除確認`}>
              <p>「{contact.name}」を削除しますか？LINE の紐付けとリストの登録は外れます。担当しているタスクには名前だけが残ります。</p>
              <div>
                <button type="button" className="member-line-unlink" onClick={() => deleteContact(contact.id)} disabled={operations.pending(pendingKey.contactDelete(contact.id))}>{operations.pending(pendingKey.contactDelete(contact.id)) ? <><RefreshCw className="spin" size={13} />削除中…</> : <><Trash2 size={13} />削除する</>}</button>
                <button type="button" className="secondary" onClick={() => setRemovingId('')} disabled={operations.pending(pendingKey.contactDelete(contact.id))}><X size={13} />やめる</button>
              </div>
            </div>}
          </>}
        </article>)}
        {visible.length === 0 && <div className="member-empty"><UsersRound size={28} /><h3>{data.contacts.length ? '条件に一致する連絡先がありません' : '連絡先はまだ登録されていません'}</h3><p>{data.contacts.length ? '検索条件を変更してください。' : 'LINEアカウントと氏名だけで追加できます。メールアドレスやタグは後から編集できます。'}</p></div>}
      </div>
    </section>
    <ContactChannelTest accountId={accountId} targets={data.channelTargets} />
    <TypedListManager lists={data.lists} operations={operations} onCreate={(kind, listName) => act(pendingKey.listCreate, () => api.createList(accountId, { kind, name: listName }))} />
    <ContactCsv accountId={accountId} operations={operations} onImported={reload} />
  </section>;
};

export default ContactsScreen;

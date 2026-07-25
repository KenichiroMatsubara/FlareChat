import { Mail, MessageCircle, Plus, Trash2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ListItem, ListKind, TypedList } from '@mail/domain';

import { api } from './api';
import { Empty, PageHeading } from './app';
import { Modal } from './modal';

const kinds: Array<{ kind: ListKind; label: string; description: string; icon: typeof Mail }> = [
  { kind: 'source', label: '送信元', description: '選別するメールアドレス・ドメイン', icon: Mail },
  { kind: 'recipient', label: '会員', description: 'カレンダーを共有するGmailアドレス', icon: Users },
  { kind: 'line', label: 'LINE宛先', description: '通知先の個人・グループ', icon: MessageCircle },
];

export const Lists = ({ organizationId, lists, onChange }: {
  organizationId: string;
  lists: TypedList[];
  onChange: () => void;
}) => {
  const [kind, setKind] = useState<ListKind>('source');
  const [selected, setSelected] = useState<TypedList | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const filtered = lists.filter((list) => list.kind === kind);

  return <>
    <PageHeading eyebrow="LISTS" title="リスト" description="送信元、会員、LINEの宛先を用途ごとにまとめます。" action={
      <button className="primary" onClick={() => setCreateOpen(true)}><Plus size={16} />リストを作成</button>
    } />
    <div className="tabs">{kinds.map((entry) => <button key={entry.kind} className={kind === entry.kind ? 'active' : ''} onClick={() => setKind(entry.kind)}><entry.icon size={17} />{entry.label}<b>{lists.filter((list) => list.kind === entry.kind).length}</b></button>)}</div>
    <section className="panel">
      {filtered.length === 0 ? <Empty icon={kinds.find((entry) => entry.kind === kind)?.icon ?? Mail} title={`${kinds.find((entry) => entry.kind === kind)?.label}リストはまだありません`} text={kinds.find((entry) => entry.kind === kind)?.description ?? ''} /> :
        <div className="list-grid">{filtered.map((list) => <button className="list-card" key={list.id} onClick={() => setSelected(list)}>
          <span className={`list-icon ${list.kind}`}>{kindIcon(list.kind)}</span>
          <div><strong>{list.name}</strong><p>{list.description || '説明なし'}</p><small>{list.itemCount} 件</small></div>
        </button>)}</div>}
    </section>
    <CreateList open={createOpen} organizationId={organizationId} defaultKind={kind} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); onChange(); }} />
    <ListDetail list={selected} onClose={() => setSelected(null)} onDeleted={() => { setSelected(null); onChange(); }} onChange={onChange} />
  </>;
};

const kindIcon = (kind: ListKind) => {
  if (kind === 'source') return <Mail size={20} />;
  if (kind === 'recipient') return <Users size={20} />;
  return <MessageCircle size={20} />;
};

const CreateList = ({ open, organizationId, defaultKind, onClose, onCreated }: {
  open: boolean; organizationId: string; defaultKind: ListKind; onClose: () => void; onCreated: () => void;
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<ListKind>(defaultKind);
  useEffect(() => setKind(defaultKind), [defaultKind]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await api.createList(organizationId, kind, name, description);
    setName(''); setDescription(''); onCreated();
  };
  return <Modal open={open} onClose={onClose} title="新しいリスト">
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <label>種類<select value={kind} onChange={(event) => setKind(event.target.value as ListKind)}>{kinds.map((entry) => <option value={entry.kind} key={entry.kind}>{entry.label}</option>)}</select></label>
      <label>リスト名<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例: 現役会員" required /></label>
      <label>説明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="このリストの用途" rows={3} /></label>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>キャンセル</button><button className="primary">作成する</button></div>
    </form>
  </Modal>;
};

const ListDetail = ({ list, onClose, onDeleted, onChange }: {
  list: TypedList | null; onClose: () => void; onDeleted: () => void; onChange: () => void;
}) => {
  const [items, setItems] = useState<ListItem[]>([]);
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const load = async () => {
    if (list) setItems(await api.items(list.id));
  };
  useEffect(() => { void load(); }, [list?.id]);
  if (!list) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await api.createItem(list.id, value, label);
    setValue(''); setLabel(''); await load(); onChange();
  };
  const remove = async (id: string) => { await api.deleteItem(id); await load(); onChange(); };
  return <Modal open onClose={onClose} title={list.name}>
    <p className="modal-description">{list.description || '項目を追加してください。'}</p>
    <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="表示名（任意）" />
      <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={list.kind === 'line' ? 'LINE宛先ID' : 'メールアドレス / ドメイン'} required />
      <button className="primary"><Plus size={16} />追加</button>
    </form>
    <div className="item-list">{items.length === 0 ? <p className="muted">項目はまだありません。</p> : items.map((item) => <div key={item.id}><span><strong>{item.label || item.value}</strong>{item.label && <small>{item.value}</small>}</span><button onClick={() => void remove(item.id)} aria-label="削除"><Trash2 size={16} /></button></div>)}</div>
    <div className="danger-zone"><button onClick={async () => { await api.deleteList(list.id); onDeleted(); }}><Trash2 size={15} />このリストを削除</button></div>
  </Modal>;
};

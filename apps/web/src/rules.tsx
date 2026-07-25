import { CirclePause, CirclePlay, Plus, Workflow } from 'lucide-react';
import { useState } from 'react';

import type { AutomationRule, TypedList } from '@mail/domain';

import { api } from './api';
import { Empty, PageHeading } from './app';
import { Modal } from './modal';

export const Rules = ({ organizationId, rules, lists, onChange }: {
  organizationId: string;
  rules: AutomationRule[];
  lists: TypedList[];
  onChange: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const toggle = async (rule: AutomationRule) => {
    await api.ruleStatus(rule.id, rule.status === 'active' ? 'suspended' : 'active');
    onChange();
  };
  return <>
    <PageHeading eyebrow="AUTOMATION" title="自動化ルール" description="どのメールを、誰に、どの方法で共有するかを設定します。" action={<button className="primary" onClick={() => setOpen(true)}><Plus size={16} />ルールを作成</button>} />
    <section className="panel">
      {rules.length === 0 ? <Empty icon={Workflow} title="自動化ルールはまだありません" text="最初のルールを作成し、メールの自動確認を始めましょう。" /> :
        <div className="rule-list">{rules.map((rule) => <article key={rule.id} className="rule-card">
          <span className={rule.status === 'active' ? 'rule-state active' : 'rule-state'}><Workflow size={19} /></span>
          <div className="rule-main"><div><strong>{rule.name}</strong><span className={`status ${rule.status}`}>{rule.status === 'active' ? '稼働中' : rule.status === 'draft' ? '下書き' : '停止中'}</span></div><p>{rule.scheduleMinutes}分ごと · {rule.requireAttendance ? `参加登録あり（${rule.deadlineDaysBefore ?? 0}日前締切）` : '参加登録なし'}</p></div>
          <button className="secondary" onClick={() => void toggle(rule)}>{rule.status === 'active' ? <><CirclePause size={16} />停止</> : <><CirclePlay size={16} />有効化</>}</button>
        </article>)}</div>}
    </section>
    <CreateRule open={open} organizationId={organizationId} lists={lists} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); onChange(); }} />
  </>;
};

const CreateRule = ({ open, organizationId, lists, onClose, onCreated }: {
  open: boolean; organizationId: string; lists: TypedList[]; onClose: () => void; onCreated: () => void;
}) => {
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [recipient, setRecipient] = useState('');
  const [line, setLine] = useState('');
  const [attendance, setAttendance] = useState(true);
  const [deadline, setDeadline] = useState(3);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await api.createRule({ organizationId, name, sourceListId: source || null, recipientListId: recipient || null, lineListId: line || null, scheduleMinutes: 5, requireAttendance: attendance, deadlineDaysBefore: attendance ? deadline : null });
    onCreated();
  };
  const options = (kind: TypedList['kind']) => lists.filter((list) => list.kind === kind).map((list) => <option key={list.id} value={list.id}>{list.name}</option>);
  return <Modal open={open} onClose={onClose} title="自動化ルールを作成">
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <label>ルール名<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例: 例会案内" required /></label>
      <div className="form-grid">
        <label>送信元リスト<select value={source} onChange={(event) => setSource(event.target.value)}><option value="">すべて</option>{options('source')}</select></label>
        <label>会員リスト<select value={recipient} onChange={(event) => setRecipient(event.target.value)}><option value="">選択なし</option>{options('recipient')}</select></label>
      </div>
      <label>LINE宛先リスト<select value={line} onChange={(event) => setLine(event.target.value)}><option value="">通知しない</option>{options('line')}</select></label>
      <label className="check-row"><input type="checkbox" checked={attendance} onChange={(event) => setAttendance(event.target.checked)} /><span><strong>参加登録を求める</strong><small>会員は締切まで参加・不参加とコメントを変更できます</small></span></label>
      {attendance && <label>予定の何日前を締切にするか<input type="number" min="0" max="90" value={deadline} onChange={(event) => setDeadline(Number(event.target.value))} /></label>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>キャンセル</button><button className="primary">下書きを作成</button></div>
    </form>
  </Modal>;
};

import { BellRing, CircleAlert, MessageCircle, Play, RefreshCw, Save, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { AutomationStatus, Connections, Contact, ContactList, DeliveryRecord, ExecutionMode, ReminderCadence, RuleRun, RuleState, SchemaRule, SchemaRuleUpdate, TypedList } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { DeliveryAudit, RuleRunHistory } from '../history';
import { MailTestFlow, useMailboxTest } from '../mailbox';
import { DestinationListChoices, FieldSaveState, OperationError, toggledIds } from '../parts';
import { pendingKey, usePendingOperations, type PendingOperations } from '../pending';
import { PendingOverlay } from '../progress';

/** A Contact a Source Message Notice can reach, and the Channels it is reachable on. */
export interface NoticeTarget {
  id: string;
  name: string;
  channels: string[];
}

export interface SchemaRuleData {
  rule: SchemaRule;
  connections: Connections;
  automation: AutomationStatus | null;
  contacts: Contact[];
  noticeTargets: NoticeTarget[];
  contactLists: ContactList[];
  lists: TypedList[];
  taskCadence: ReminderCadence;
  ruleRuns: RuleRun[];
  deliveries: DeliveryRecord[];
}

/**
 * Who a Rule's notice may be addressed to (ADR 0166). Email is the ordinary
 * way to reach a person, so every active Contact holding an address is
 * offered; a group or a room holds no address and is offered on the Channel
 * the Channel Test found it reachable on. A Contact with neither is left
 * out, because ticking it would do nothing.
 */
export const noticeTargetsOf = (contacts: readonly Contact[], reachable: ReadonlyArray<{ id: string; channels: string[] }>): NoticeTarget[] =>
  contacts.flatMap((contact) => {
    if (contact.state !== 'active') return [];
    if (contact.email) return [{ id: contact.id, name: contact.name, channels: ['email'] }];
    const channels = reachable.find((target) => target.id === contact.id)?.channels ?? [];
    return channels.length ? [{ id: contact.id, name: contact.name, channels }] : [];
  });

export const loader = async (args: LoaderFunctionArgs): Promise<SchemaRuleData> => {
  const accountId = accountIdOf(args);
  const ruleId = args.params.ruleId ?? '';
  const [rules, connections, automation, contacts, reachable, contactLists, lists, taskCadence, ruleRuns, deliveries] = await Promise.all([
    api.rules(accountId),
    api.connections(accountId),
    api.currentAutomation(accountId),
    api.contacts(accountId),
    api.channelTestTargets(accountId),
    api.contactLists(accountId),
    api.lists(accountId),
    api.taskReminders(accountId),
    api.ruleRuns(accountId),
    api.deliveries(accountId),
  ]);
  const rule = rules.find((entry) => entry.id === ruleId);
  if (!rule) throw new Response('Rule was not found', { status: 404 });
  return {
    rule,
    connections,
    automation,
    contacts,
    noticeTargets: noticeTargetsOf(contacts, reachable),
    contactLists,
    lists,
    taskCadence,
    ruleRuns: ruleRuns.filter((run) => run.rule.type === 'schema' && run.rule.id === rule.id),
    deliveries,
  };
};

/** The four things a Selection Policy can require, in the order an operator reads them. */
const SELECTION_FIELDS = [
  { key: 'sender', label: '送信者（完全一致）', placeholder: 'sender@example.com' },
  { key: 'domain', label: '送信元ドメイン', placeholder: 'example.com' },
  { key: 'keyword', label: '本文・件名のキーワード', placeholder: '例: 招待行事' },
  { key: 'label', label: 'Gmailラベル', placeholder: '例: Announcements' },
] as const;

const policyValue = (policy: Record<string, unknown>, key: string): string =>
  typeof policy[key] === 'string' ? policy[key] as string : '';

type UpdateRule = (input: SchemaRuleUpdate) => void;

/**
 * What this Rule matches and how it is ordered against the others, editable for
 * the life of the Rule. Until ADR 0167 these could only be entered on the
 * creation form, so narrowing a Rule meant replacing it.
 */
const RuleMatchEditor = ({ rule, operations, onUpdate }: { rule: SchemaRule; operations: PendingOperations; onUpdate: UpdateRule }) => {
  const [name, setName] = useState(rule.name);
  const [policy, setPolicy] = useState<Record<string, string>>(
    Object.fromEntries(SELECTION_FIELDS.map((field) => [field.key, policyValue(rule.selectionPolicy, field.key)])),
  );
  const [priority, setPriority] = useState(String(rule.priority));
  const saving = operations.pending(pendingKey.ruleUpdate(rule.id));
  const save = (): void => {
    // Keys this screen does not offer are carried through rather than dropped,
    // because a Policy written by a Preset may require more than these four.
    const selectionPolicy: Record<string, unknown> = { ...rule.selectionPolicy };
    for (const field of SELECTION_FIELDS) {
      const value = policy[field.key]?.trim() ?? '';
      if (value) selectionPolicy[field.key] = value;
      else delete selectionPolicy[field.key];
    }
    onUpdate({ name: name.trim(), selectionPolicy, priority: Number.parseInt(priority, 10) || 0 });
  };
  return <section className="settings-card">
    <div className="settings-card-title"><SlidersHorizontal size={19} /><div>
      <h2>拾うメール</h2><p>すべて空にすると、届いたメールすべてがこのルールに入ります。</p>
    </div></div>
    <label>ルール名<input value={name} onChange={(event) => setName(event.target.value)} disabled={saving} /></label>
    {SELECTION_FIELDS.map((field) => <label key={field.key}>{field.label}
      <input
        value={policy[field.key] ?? ''}
        placeholder={field.placeholder}
        disabled={saving}
        onChange={(event) => setPolicy((current) => ({ ...current, [field.key]: event.target.value }))}
      />
    </label>)}
    <label>優先度<input type="number" inputMode="numeric" value={priority} disabled={saving} onChange={(event) => setPriority(event.target.value)} /></label>
    <p className="api-guide">条件に当てはまるルールが複数あるときは、優先度の大きいものが1つだけ選ばれます。</p>
    <div className="settings-card-actions">
      <p className="connection-state">revision {rule.revision}</p>
      <button className="primary" type="button" disabled={saving || !name.trim()} onClick={save}>
        {saving ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{saving ? '保存中…' : '拾うメールを保存'}
      </button>
    </div>
    <FieldSaveState saving={saving} saved={operations.settled(pendingKey.ruleUpdate(rule.id))} />
  </section>;
};

/** Whether the Rule runs at all, and whether its effects are applied without asking. */
const RuleExecutionEditor = ({ rule, operations, onUpdate }: { rule: SchemaRule; operations: PendingOperations; onUpdate: UpdateRule }) => {
  const saving = operations.pending(pendingKey.ruleUpdate(rule.id));
  return <section className="settings-card">
    <div className="settings-card-title"><Play size={19} /><div>
      <h2>実行のしかた</h2><p>Draft は選ばれません。Approval はこの画面の実行履歴で承認するまで何も起こりません。</p>
    </div></div>
    <label>状態<select value={rule.state} disabled={saving} onChange={(event) => onUpdate({ state: event.target.value as RuleState })}>
      <option value="draft">Draft（選ばれない）</option>
      <option value="active">Active（有効）</option>
      <option value="suspended">Suspended（停止）</option>
      <option value="archived">Archived（保管）</option>
    </select></label>
    <label>Execution Mode<select value={rule.executionMode} disabled={saving} onChange={(event) => onUpdate({ executionMode: event.target.value as ExecutionMode })}>
      <option value="read_only">Read only（記録するだけ）</option>
      <option value="approval">Approval（承認してから適用）</option>
      <option value="unattended">Unattended（そのまま適用）</option>
    </select></label>
    <FieldSaveState saving={saving} saved={operations.settled(pendingKey.ruleUpdate(rule.id))} />
  </section>;
};

/**
 * Who this Rule tells about a Source Message, chosen as Contacts (ADR 0162, ADR 0166).
 * The address is never typed here: the Account picks people, groups, and rooms
 * it already holds, and delivery resolves each one's email or Channel handle.
 */
const NoticeContactChoices = ({ rule, targets, initial, operations, onSave }: {
  rule: SchemaRule;
  targets: readonly NoticeTarget[];
  initial: string[];
  operations: PendingOperations;
  onSave: (contactIds: string[]) => void;
}) => {
  const [contactIds, setContactIds] = useState<string[]>(initial);
  const saving = operations.pending(pendingKey.ruleNoticeContacts(rule.id));
  const named = targets.filter((target) => contactIds.includes(target.id)).map((target) => target.name);
  return <fieldset className="rule-notice-contacts">
    <legend>要約の送り先（連絡先）</legend>
    <small>ここで選んだ連絡先にだけ要約を配信します。メールアドレスを持つ連絡先にはメールで届きます。</small>
    {targets.length
      ? targets.map((target) => <label key={target.id}>
        <input
          type="checkbox"
          checked={contactIds.includes(target.id)}
          disabled={saving}
          onChange={(change) => setContactIds((current) => toggledIds(current, target.id, change.target.checked))}
        />{target.name}<small>{target.channels.join('・').toUpperCase()}</small>
      </label>)
      : <small>送信できる連絡先がありません。連絡先画面でメールアドレスかLINEを登録してください。</small>}
    <small>選択中: {named.join('、') || '送り先なし'}</small>
    <button type="button" className="secondary" disabled={saving} onClick={() => onSave(contactIds)}>{saving ? <><RefreshCw className="spin" size={13} />保存中…</> : '要約の送り先を保存'}</button>
    <FieldSaveState saving={saving} saved={operations.settled(pendingKey.ruleNoticeContacts(rule.id))} />
  </fieldset>;
};

/**
 * The cadence this Account's Tasks remind on, stated where the Rule that raises
 * them is configured (ADR 0167). It is read-only here because it is an
 * Account-wide setting, not this Rule's: it is edited beside the Tasks.
 */
const ReminderCadenceSummary = ({ cadence }: { cadence: ReminderCadence }) => {
  const stated = (day: number): string => day > 0 ? `${day}日前` : day === 0 ? '当日' : `${Math.abs(day)}日後`;
  return <section className="settings-card">
    <div className="settings-card-title"><BellRing size={19} /><div>
      <h2>タスクのリマインド</h2><p>このルールが作るタスクの締め切り前後に送る合図です。</p>
    </div></div>
    {!cadence.enabled
      ? <p className="dashboard-warning"><CircleAlert size={15} /><span>リマインドは停止中です。締め切りが来ても誰にも通知されません。</span></p>
      : cadence.days.length === 0
        ? <p className="dashboard-warning"><CircleAlert size={15} /><span>送る日が1つも選ばれていないため、何も送られません。</span></p>
        : <p className="connection-state">{cadence.days.map(stated).join('、')}に送ります</p>}
    <p className="api-guide">Account 全体の設定です。変更はタスク画面で行います。</p>
    <Link className="secondary" to="../tasks">タスク画面へ</Link>
  </section>;
};

/**
 * The permitted Typed Lists, kept until ADR 0147 deletes them. They are stated
 * as what they are — a path on its way out — rather than presented beside the
 * Contact selection as an equal choice.
 */
const RulePermittedLists = ({ rule, lists, operations, onUpdate }: { rule: SchemaRule; lists: readonly TypedList[]; operations: PendingOperations; onUpdate: UpdateRule }) => {
  const recipientLists = lists.filter((list) => list.kind === 'recipient');
  const lineLists = lists.filter((list) => list.kind === 'line');
  const [permittedRecipientListIds, setPermittedRecipientListIds] = useState(rule.permittedRecipientListIds);
  const [permittedLineListIds, setPermittedLineListIds] = useState(rule.permittedLineListIds);
  const saving = operations.pending(pendingKey.ruleUpdate(rule.id));
  const recipientNames = recipientLists.filter((list) => rule.permittedRecipientListIds.includes(list.id)).map((list) => list.name);
  const lineNames = lineLists.filter((list) => rule.permittedLineListIds.includes(list.id)).map((list) => list.name);
  if (!recipientLists.length && !lineLists.length) return null;
  return <details className="rule-destination-editor">
    <summary>旧来の許可リスト（Typed Lists）</summary>
    <small>選択中: {recipientNames.join('、') || 'Calendar Recipient Listなし'}</small>
    <small>選択中: {lineNames.join('、') || 'LINE Destination Listなし'}</small>
    <DestinationListChoices legend="許可されたCalendar Recipient Lists" lists={recipientLists} selectedIds={permittedRecipientListIds} onChange={setPermittedRecipientListIds} />
    <DestinationListChoices legend="許可されたLINE Destination Lists" lists={lineLists} selectedIds={permittedLineListIds} onChange={setPermittedLineListIds} />
    <button type="button" className="secondary" disabled={saving} onClick={() => onUpdate({ permittedRecipientListIds, permittedLineListIds })}>{saving ? <><RefreshCw className="spin" size={13} />保存中…</> : '許可リストを保存'}</button>
    <FieldSaveState saving={saving} saved={operations.settled(pendingKey.ruleUpdate(rule.id))} />
  </details>;
};

/**
 * One Schema Rule, whole (ADR 0167). Everything that decides what this Rule
 * does is on this screen, and the screen says what is missing rather than
 * leaving an operator to discover it from the absence of messages nobody received.
 */
const SchemaRuleScreen = () => {
  const data = useLoaderData<SchemaRuleData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const { rule } = data;
  const reload = (): Promise<void> => revalidator.revalidate();
  const test = useMailboxTest(accountId, operations, reload);
  const noticeList = data.contactLists.find((entry) => entry.id === rule.noticeContactListId);
  const readers = noticeList?.contactIds.length ?? 0;
  const conditions = SELECTION_FIELDS
    .map((field) => ({ field, value: policyValue(rule.selectionPolicy, field.key) }))
    .filter((entry) => entry.value);

  const update = (input: SchemaRuleUpdate): void => void operations.run(pendingKey.ruleUpdate(rule.id), async () => {
    await api.updateRule(accountId, rule.id, input);
    await reload();
  });
  /**
   * Names who this Rule tells, as Contacts. The set is stored as the Rule's own
   * Contact List, so the platform keeps one named-set concept (ADR 0162).
   */
  const saveNoticeContacts = (contactIds: string[]): void => void operations.run(pendingKey.ruleNoticeContacts(rule.id), async () => {
    if (!contactIds.length) {
      await api.updateRule(accountId, rule.id, { noticeContactListId: null });
      await reload();
      return;
    }
    const listId = rule.noticeContactListId ?? crypto.randomUUID();
    await api.saveContactList(accountId, listId, { name: `${rule.name} の要約送り先`, contactIds });
    await api.updateRule(accountId, rule.id, { noticeContactListId: listId });
    await reload();
  });
  const decide = (runId: string, decision: 'approve' | 'reject'): void => void operations.run(pendingKey.ruleRunDecision(runId, decision), async () => {
    await api.decideRuleRun(accountId, runId, decision);
    await reload();
  });

  return <section className="page-layout rules-page">
    <PendingOverlay running={operations.running} />
    <OperationError error={operations.error} />
    <div className="page-title">
      <p>SCHEMA RULE</p>
      <h1>{rule.name}</h1>
      <span>
        {conditions.length ? conditions.map((entry) => `${entry.field.label}: ${entry.value}`).join(' / ') : '条件なし（すべてのメール）'}
        {' ・ '}優先度 {rule.priority} ・ {rule.state} ・ {rule.executionMode}
      </span>
    </div>
    {!data.connections.ai.apiKeyConfigured && <p className="dashboard-warning">
      <CircleAlert size={17} />
      <span>AI 接続が設定されていません。このルールはメールを1通も処理できません。</span>
      <Link to="../connections">接続設定へ</Link>
    </p>}
    {readers === 0 && <p className="dashboard-warning">
      <CircleAlert size={17} />
      <span>要約の送り先が選ばれていません。このルールは予定とタスクを作りますが、要約は誰にも届きません。</span>
    </p>}
    <RuleMatchEditor key={`match-${rule.revision}-${rule.updatedAt}`} rule={rule} operations={operations} onUpdate={update} />
    <RuleExecutionEditor rule={rule} operations={operations} onUpdate={update} />
    <section className="settings-card">
      <div className="settings-card-title"><MessageCircle size={19} /><div>
        <h2>要約の送り先</h2><p>このルールが作る要約を受け取る連絡先です。</p>
      </div></div>
      <NoticeContactChoices rule={rule} targets={data.noticeTargets} initial={noticeList?.contactIds ?? []} operations={operations} onSave={saveNoticeContacts} />
    </section>
    <ReminderCadenceSummary cadence={data.taskCadence} />
    <RulePermittedLists rule={rule} lists={data.lists} operations={operations} onUpdate={update} />
    <section className="test-card">
      <div><p>TRY THIS RULE</p><h2>このルールを実メールで試す</h2><span>{rule.state === 'draft'
        ? 'Draft なので、効果のない read-only の Rule Run として保存されます。'
        : '抽出までは何も書き込みません。書き込むのは最後の確定操作だけです。'}</span></div>
    </section>
    <MailTestFlow
      test={test}
      pending={operations.pending}
      connected={Boolean(data.automation)}
      aiConfigured={data.connections.ai.apiKeyConfigured}
      assigneeName={(contactId) => data.contacts.find((contact) => contact.id === contactId)?.name ?? '未割り当て'}
      rule={rule}
    />
    <RuleRunHistory runs={data.ruleRuns} ruleName={() => rule.name} heading="このルールの実行履歴" pending={operations.pending} onDecide={decide} />
    <DeliveryAudit deliveries={data.deliveries} />
    <Link className="secondary" to="../rules">ルール一覧へ戻る</Link>
  </section>;
};

export default SchemaRuleScreen;

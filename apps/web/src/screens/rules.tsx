import { CircleAlert, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { AgentRule, ContactList, ExecutionMode, Preset, Prompt, SchemaRule } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { OperationError } from '../parts';
import { pendingKey, usePendingOperations } from '../pending';
import { PendingOverlay } from '../progress';

export interface RulesData {
  rules: SchemaRule[];
  agentRules: AgentRule[];
  prompts: Prompt[];
  contactLists: ContactList[];
  presets: Preset[];
}

export const loader = async (args: LoaderFunctionArgs): Promise<RulesData> => {
  const accountId = accountIdOf(args);
  const [rules, agentRules, prompts, contactLists, presets] = await Promise.all([
    api.rules(accountId),
    api.agentRules(accountId),
    api.prompts(accountId),
    api.contactLists(accountId),
    api.presets(),
  ]);
  return { rules, agentRules, prompts, contactLists, presets };
};

/** One Schema Rule in the index: what it matches, whether it can deliver, and the way in. */
const SchemaRuleRow = ({ rule, readers }: { rule: SchemaRule; readers: number }) => <article className="rule-row">
  <div>
    <strong>{rule.name}</strong>
    <small>
      優先度 {rule.priority} ・ {Object.entries(rule.selectionPolicy).map(([key, value]) => `${key}: ${String(value)}`).join(' / ') || '条件なし'}
    </small>
    {readers === 0
      ? <small className="rule-row-warning"><CircleAlert size={12} />要約の送り先が未設定です</small>
      : <small>要約の送り先 {readers}件</small>}
    <Link className="secondary" to={`../rules/schema/${encodeURIComponent(rule.id)}`}>このルールを設定</Link>
  </div>
  <span className={`rule-state ${rule.state}`}>{rule.state}</span>
</article>;

/** One Agent Rule in the index. */
const AgentRuleRow = ({ rule, promptName }: { rule: AgentRule; promptName: string }) => <article className="rule-row">
  <div>
    <strong>{rule.name}</strong>
    <small>Prompt: {promptName} ・ {rule.executionMode} ・ revision {rule.revision}</small>
    <Link className="secondary" to={`../rules/agent/${encodeURIComponent(rule.id)}`}>このルールを設定</Link>
  </div>
  <span className={`rule-state ${rule.state}`}>{rule.state}</span>
</article>;

/** A Preset lands as Rules and Prompts, so it is copied from the Rules index. */
export const PresetSettings = ({ presets, hasConfiguration, pending, onApply }: {
  presets: readonly Preset[];
  hasConfiguration: boolean;
  pending: (key: string) => boolean;
  onApply: (presetId: string, conflictPolicy?: 'duplicate') => void;
}) => {
  const [confirmed, setConfirmed] = useState(false);
  return <section className="test-card preset-settings">
    <div><p>PRESET</p><h2>Presetをコピー</h2><span>コピー後の構成は製品更新とリンクされず、このAccountだけで編集できます。</span></div>
    {presets.map((preset) => <article key={preset.id}>
      <strong>{preset.name}</strong><p>{preset.description}</p>
      {hasConfiguration && <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />既存の構成に別のコピーを追加する</label>}
      <button type="button" className="secondary" disabled={pending(pendingKey.presetApply(preset.id)) || (hasConfiguration && !confirmed)} onClick={() => onApply(preset.id, hasConfiguration ? 'duplicate' : undefined)}>{pending(pendingKey.presetApply(preset.id)) ? <><RefreshCw className="spin" size={14} />適用中…</> : 'Presetを適用'}</button>
      {pending(pendingKey.presetApply(preset.id)) && <p className="field-state saving"><RefreshCw className="spin" size={12} />構成をコピーし、ルールと Prompt を読み直しています…</p>}
    </article>)}
  </section>;
};

/**
 * The index of both rule types (ADR 0167). It lists and creates; it never edits,
 * because editing one Rule belongs on that Rule's screen.
 */
const RulesScreen = () => {
  const { rules, agentRules, prompts, contactLists, presets } = useLoaderData<RulesData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const creatingRule = operations.pending(pendingKey.ruleCreate);
  const creatingAgentRule = operations.pending(pendingKey.agentRuleCreate);
  const [ruleName, setRuleName] = useState('');
  const [ruleSender, setRuleSender] = useState('');
  const [ruleDomain, setRuleDomain] = useState('');
  const [ruleKeyword, setRuleKeyword] = useState('');
  const [ruleLabel, setRuleLabel] = useState('');
  const [rulePriority, setRulePriority] = useState('0');
  const [ruleState, setRuleState] = useState<'draft' | 'active'>('draft');
  const [ruleExecutionMode, setRuleExecutionMode] = useState<ExecutionMode>('unattended');
  const [agentName, setAgentName] = useState('');
  const [agentPromptId, setAgentPromptId] = useState(prompts[0]?.id ?? '');
  const [agentDomain, setAgentDomain] = useState('');
  const [agentState, setAgentState] = useState<'draft' | 'active'>('draft');
  const [agentExecutionMode, setAgentExecutionMode] = useState<ExecutionMode>('unattended');
  const readersOf = (rule: SchemaRule): number => contactLists.find((entry) => entry.id === rule.noticeContactListId)?.contactIds.length ?? 0;
  const promptName = (promptId: string): string => prompts.find((prompt) => prompt.id === promptId)?.name ?? promptId;

  const createRule = (event: React.FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.ruleCreate, async () => {
      const selectionPolicy = Object.fromEntries(Object.entries({ sender: ruleSender.trim(), domain: ruleDomain.trim(), keyword: ruleKeyword.trim(), label: ruleLabel.trim() }).filter(([, value]) => value));
      await api.createRule(accountId, { name: ruleName, state: ruleState, executionMode: ruleExecutionMode, selectionPolicy, routingPolicy: {}, permittedRecipientListIds: [], permittedLineListIds: [], priority: Number.parseInt(rulePriority, 10) || 0 });
      setRuleName(''); setRuleSender(''); setRuleDomain(''); setRuleKeyword(''); setRuleLabel(''); setRulePriority('0'); setRuleState('draft');
      await revalidator.revalidate();
    });
  };
  const createAgentRule = (event: React.FormEvent): void => {
    event.preventDefault();
    void operations.run(pendingKey.agentRuleCreate, async () => {
      await api.createAgentRule(accountId, { name: agentName, promptId: agentPromptId, state: agentState, executionMode: agentExecutionMode, selectionPolicy: agentDomain.trim() ? { domain: agentDomain.trim() } : {}, permittedRecipientListIds: [], permittedLineListIds: [] });
      setAgentName(''); setAgentDomain('');
      await revalidator.revalidate();
    });
  };
  const applyPreset = (presetId: string, conflictPolicy?: 'duplicate'): void => void operations.run(pendingKey.presetApply(presetId), async () => {
    await api.applyPreset(accountId, presetId, conflictPolicy);
    await revalidator.revalidate();
  });

  return <section className="page-layout rules-page">
    <PendingOverlay running={operations.running} />
    <OperationError error={operations.error} />
    <div className="page-title"><p>AUTOMATION RULES</p><h1>ルール</h1><span>届いたメールを1本のルールが受け持ちます。設定は各ルールの画面で行います。</span></div>
    <section className="rules-list">
      <div className="rules-list-title"><h2>Schema Rules</h2><span>{rules.length}件</span></div>
      {rules.length ? rules.map((rule) => <SchemaRuleRow key={rule.id} rule={rule} readers={readersOf(rule)} />) : <p className="rules-empty">まだルールはありません。</p>}
    </section>
    <section className="rules-list">
      <div className="rules-list-title"><h2>Agent Rules</h2><span>{agentRules.length}件</span></div>
      {agentRules.length ? agentRules.map((rule) => <AgentRuleRow key={rule.id} rule={rule} promptName={promptName(rule.promptId)} />) : <p className="rules-empty">まだ Agent Rule はありません。</p>}
    </section>
    <form className="rule-builder" onSubmit={createRule}>
      <div><p>NEW SCHEMA RULE</p><h2>Schema Rule を作成</h2><span>Draft + Unattended で作成し、本番と同じ経路を効果なしで試せます。作成後もすべて編集できます。</span></div>
      <label>ルール名<input value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder="例: ローターアクト行事" required /></label>
      <div className="rule-grid">
        <label>送信者（完全一致）<input value={ruleSender} onChange={(event) => setRuleSender(event.target.value)} placeholder="sender@example.com" /></label>
        <label>送信元ドメイン<input value={ruleDomain} onChange={(event) => setRuleDomain(event.target.value)} placeholder="example.com" /></label>
        <label>本文・件名のキーワード<input value={ruleKeyword} onChange={(event) => setRuleKeyword(event.target.value)} placeholder="例: 招待行事" /></label>
        <label>Gmailラベル<input value={ruleLabel} onChange={(event) => setRuleLabel(event.target.value)} placeholder="例: Announcements" /></label>
        <label>優先度<input type="number" value={rulePriority} onChange={(event) => setRulePriority(event.target.value)} /></label>
        <label>Execution Mode<select value={ruleExecutionMode} onChange={(event) => setRuleExecutionMode(event.target.value as ExecutionMode)}><option value="read_only">Read only</option><option value="approval">Approval</option><option value="unattended">Unattended</option></select></label>
        <label>作成時の状態<select value={ruleState} onChange={(event) => setRuleState(event.target.value as 'draft' | 'active')}><option value="draft">下書き</option><option value="active">有効</option></select></label>
      </div>
      <button className="primary" disabled={creatingRule}>{creatingRule ? <><RefreshCw className="spin" size={14} />作成中…</> : 'Schema Rule を作成'}</button>
    </form>
    <form className="rule-builder" onSubmit={createAgentRule}>
      <div><p>NEW AGENT RULE</p><h2>Agent Rule を作成</h2><span>既定は Draft + Unattended です。Prompt は Prompt 画面で作ります。</span></div>
      <label>Agent Rule名<input required value={agentName} onChange={(event) => setAgentName(event.target.value)} /></label>
      <label>Prompt<select required value={agentPromptId} onChange={(event) => setAgentPromptId(event.target.value)}><option value="">選択してください</option>{prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}</select></label>
      <label>送信元ドメイン<input value={agentDomain} onChange={(event) => setAgentDomain(event.target.value)} placeholder="example.com" /></label>
      <label>Execution Mode<select value={agentExecutionMode} onChange={(event) => setAgentExecutionMode(event.target.value as ExecutionMode)}><option value="read_only">Read only</option><option value="approval">Approval</option><option value="unattended">Unattended</option></select></label>
      <label>状態<select value={agentState} onChange={(event) => setAgentState(event.target.value as 'draft' | 'active')}><option value="draft">Draft</option><option value="active">Active</option></select></label>
      <button className="primary" disabled={creatingAgentRule || !agentPromptId}>{creatingAgentRule ? <><RefreshCw className="spin" size={14} />作成中…</> : 'Agent Rule を作成'}</button>
    </form>
    <PresetSettings presets={presets} hasConfiguration={Boolean(rules.length || agentRules.length || prompts.length)} pending={operations.pending} onApply={applyPreset} />
  </section>;
};

export default RulesScreen;

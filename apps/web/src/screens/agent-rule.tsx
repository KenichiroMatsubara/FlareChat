import { CircleAlert, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { AgentRule, AgentRuleUpdate, AgentRun, ExecutionMode, Prompt, RuleRun, RuleState, RunTranscript, TypedList } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { RuleRunHistory } from '../history';
import { DestinationListChoices, FieldSaveState, OperationError } from '../parts';
import { pendingKey, usePendingOperations, type PendingOperations } from '../pending';
import { PendingOverlay } from '../progress';

export interface AgentRuleData {
  rule: AgentRule;
  prompt: Prompt | null;
  lists: TypedList[];
  ruleRuns: RuleRun[];
  agentRuns: AgentRun[];
}

export const loader = async (args: LoaderFunctionArgs): Promise<AgentRuleData> => {
  const accountId = accountIdOf(args);
  const ruleId = args.params.ruleId ?? '';
  const [agentRules, prompts, lists, ruleRuns, agentRuns] = await Promise.all([
    api.agentRules(accountId),
    api.prompts(accountId),
    api.lists(accountId),
    api.ruleRuns(accountId),
    api.agentRuns(accountId),
  ]);
  const rule = agentRules.find((entry) => entry.id === ruleId);
  if (!rule) throw new Response('Agent Rule was not found', { status: 404 });
  return {
    rule,
    prompt: prompts.find((entry) => entry.id === rule.promptId) ?? null,
    lists,
    ruleRuns: ruleRuns.filter((run) => run.rule.type === 'agent' && run.rule.id === rule.id),
    agentRuns: agentRuns.filter((run) => run.agentRuleId === rule.id),
  };
};

const AgentRuleEditor = ({ rule, lists, operations, onUpdate }: { rule: AgentRule; lists: readonly TypedList[]; operations: PendingOperations; onUpdate: (input: AgentRuleUpdate) => void }) => {
  const recipientLists = lists.filter((list) => list.kind === 'recipient');
  const lineLists = lists.filter((list) => list.kind === 'line');
  const [recipientIds, setRecipientIds] = useState(rule.permittedRecipientListIds);
  const [lineIds, setLineIds] = useState(rule.permittedLineListIds);
  const saving = operations.pending(pendingKey.agentRuleUpdate(rule.id));
  const saved = operations.settled(pendingKey.agentRuleUpdate(rule.id));
  return <details className="rule-destination-editor">
    <summary>Execution Mode・許可リストを編集<FieldSaveState saving={saving} saved={saved} /></summary>
    <label>Execution Mode<select value={rule.executionMode} disabled={saving} onChange={(event) => onUpdate({ executionMode: event.target.value as ExecutionMode })}><option value="read_only">Read only</option><option value="approval">Approval</option><option value="unattended">Unattended</option></select></label>
    <DestinationListChoices legend="許可されたCalendar Recipient Lists" lists={recipientLists} selectedIds={recipientIds} onChange={setRecipientIds} />
    <DestinationListChoices legend="許可されたLINE Destination Lists" lists={lineLists} selectedIds={lineIds} onChange={setLineIds} />
    <button type="button" className="secondary" disabled={saving} onClick={() => onUpdate({ permittedRecipientListIds: recipientIds, permittedLineListIds: lineIds })}>{saving ? <><RefreshCw className="spin" size={13} />保存中…</> : '許可リストを保存'}</button>
  </details>;
};

const AgentRunHistory = ({ runs, ruleName, transcript, pending, onOpen }: {
  runs: readonly AgentRun[];
  ruleName: string;
  transcript: RunTranscript | null;
  pending: (key: string) => boolean;
  onOpen: (runId: string) => void;
}) => <section className="rules-list">
  <div className="rules-list-title"><h2>Run Transcripts</h2><span>{runs.length}件</span></div>
  {runs.map((run) => <article className="rule-row" key={run.id}>
    <div><strong>{ruleName}</strong><small>{run.outcome} ・ {run.model} ・ tools {run.toolCallCount} ・ tokens {run.tokens}</small></div>
    <button type="button" className="secondary" disabled={pending(pendingKey.agentRunTranscript(run.id))} onClick={() => onOpen(run.id)}>{pending(pendingKey.agentRunTranscript(run.id)) ? <><RefreshCw className="spin" size={13} />読込中…</> : 'Run Transcriptを読む'}</button>
  </article>)}
  {transcript && <article className="test-card">
    <div><p>RUN TRANSCRIPT</p><h2>{transcript.source.subject}</h2></div>
    <pre>{transcript.source.body}</pre>
    {transcript.source.attachments.map((attachment) => <pre key={attachment.filename}>{attachment.filename}{'\n'}{attachment.text}</pre>)}
    <pre>{transcript.finalOutput || transcript.error}</pre>
  </article>}
</section>;

/** One Agent Rule, whole (ADR 0167). */
const AgentRuleScreen = () => {
  const data = useLoaderData<AgentRuleData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const { rule, prompt } = data;
  const [transcript, setTranscript] = useState<RunTranscript | null>(null);
  const update = (input: AgentRuleUpdate): void => void operations.run(pendingKey.agentRuleUpdate(rule.id), async () => {
    await api.updateAgentRule(accountId, rule.id, input);
    await revalidator.revalidate();
  });
  const openTranscript = (runId: string): void => void operations.run(pendingKey.agentRunTranscript(runId), async () => {
    setTranscript(await api.runTranscript(accountId, runId));
  });
  const decide = (runId: string, decision: 'approve' | 'reject'): void => void operations.run(pendingKey.ruleRunDecision(runId, decision), async () => {
    await api.decideRuleRun(accountId, runId, decision);
    await revalidator.revalidate();
  });
  return <section className="page-layout rules-page">
    <PendingOverlay running={operations.running} />
    <OperationError error={operations.error} />
    <div className="page-title">
      <p>AGENT RULE</p><h1>{rule.name}</h1>
      <span>Prompt: {prompt?.name ?? rule.promptId} ・ {rule.state} ・ {rule.executionMode} ・ revision {rule.revision}</span>
    </div>
    {!prompt && <p className="dashboard-warning"><CircleAlert size={17} /><span>Prompt が見つかりません。この Agent Rule は実行できません。</span></p>}
    <section className="settings-card">
      <div className="settings-card-title"><Play size={19} /><div><h2>実行のしかた</h2><p>Draft の間は write plan が効果なしで記録されます。</p></div></div>
      <label>状態<select aria-label={`${rule.name}の状態`} value={rule.state} disabled={operations.pending(pendingKey.agentRuleUpdate(rule.id))} onChange={(event) => update({ state: event.target.value as RuleState })}>
        <option value="draft">Draft</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="archived">Archived</option>
      </select></label>
      <AgentRuleEditor rule={rule} lists={data.lists} operations={operations} onUpdate={update} />
    </section>
    <RuleRunHistory runs={data.ruleRuns} ruleName={() => rule.name} heading="このルールの実行履歴" pending={operations.pending} onDecide={decide} />
    <AgentRunHistory runs={data.agentRuns} ruleName={rule.name} transcript={transcript} pending={operations.pending} onOpen={openTranscript} />
    <Link className="secondary" to="../rules">ルール一覧へ戻る</Link>
  </section>;
};

export default AgentRuleScreen;

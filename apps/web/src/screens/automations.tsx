import { useState } from 'react';
import { CalendarClock, RefreshCw, Trash2 } from 'lucide-react';
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { Automation, AutomationRun, ContactList, Prompt } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { OperationError } from '../parts';
import { pendingKey, usePendingOperations } from '../pending';
import { PendingOverlay } from '../progress';

const READ_TOOLS = ['query_scheduled_events', 'query_contacts', 'query_tasks', 'query_attendance'] as const;
const WRITE_TOOLS = ['channel.send', 'reminder.schedule'] as const;
const WINDOWS = ['none', 'hour', 'day', 'week', 'forever'] as const;
const STATES = ['draft', 'active', 'suspended'] as const;

export interface AutomationsData {
  automations: Automation[];
  prompts: Prompt[];
  lists: ContactList[];
}

export const loader = async (args: LoaderFunctionArgs): Promise<AutomationsData> => {
  const accountId = accountIdOf(args);
  const [automations, prompts, lists] = await Promise.all([
    api.automations(accountId),
    api.prompts(accountId),
    api.contactLists(accountId),
  ]);
  return { automations, prompts, lists };
};

/** Says what a run did, including the runs that failed, which is the point of keeping them. */
export const AutomationRunList = ({ runs }: { runs: readonly AutomationRun[] }) => <ul className="automation-runs">
  {runs.length === 0 && <li className="automation-empty">まだ実行されていません。</li>}
  {runs.map((run) => <li key={run.id}>
    <span className="automation-run-time">{run.startedAt}</span>
    <span className={run.status === 'failed' ? 'automation-run-failed' : 'automation-run-ok'}>
      {run.status === 'failed' ? (run.error ?? '失敗') : (run.output || '（出力なし）')}
    </span>
    <span>ツール {run.toolCalls} 回</span>
  </li>)}
</ul>;

const toggle = (values: string[], value: string): string[] =>
  values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];

/**
 * Automations: a Trigger with no payload, a Prompt, and the tools it may use.
 * Granting a send requires naming who may be reached, which is why the Contact
 * List sits beside the Tool Grant rather than somewhere else.
 */
const AutomationsScreen = () => {
  const { automations, prompts, lists } = useLoaderData<AutomationsData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const [runs, setRuns] = useState<Record<string, AutomationRun[]>>({});
  const [name, setName] = useState('');
  const [promptId, setPromptId] = useState(prompts[0]?.id ?? '');
  const [contactListId, setContactListId] = useState(lists[0]?.id ?? '');
  const [schedule, setSchedule] = useState('daily 09:00');
  const [offsetMinutes, setOffsetMinutes] = useState(540);
  const [tools, setTools] = useState<string[]>([...READ_TOOLS]);
  const [suppressionWindow, setSuppressionWindow] = useState('day');
  const [state, setState] = useState('draft');
  const grantsWrite = tools.some((tool) => WRITE_TOOLS.includes(tool as (typeof WRITE_TOOLS)[number]));
  const saving = operations.pending(pendingKey.scheduleSave);

  const save = (): void => void operations.run(pendingKey.scheduleSave, async () => {
    await api.saveAutomation(accountId, crypto.randomUUID(), {
      name: name.trim(),
      promptId,
      contactListId: grantsWrite ? contactListId : null,
      schedule: schedule.trim(),
      offsetMinutes,
      executionMode: 'unattended',
      suppressionWindow,
      state,
      tools,
    });
    setName('');
    await revalidator.revalidate();
  });

  const remove = (id: string): void => void operations.run(pendingKey.scheduleRemove(id), async () => {
    await api.removeAutomation(accountId, id);
    await revalidator.revalidate();
  });

  const showRuns = (id: string): void => void operations.run(pendingKey.scheduleRuns(id), async () => {
    const loaded = await api.automationRuns(accountId, id);
    setRuns((current) => ({ ...current, [id]: loaded }));
  });

  return <section className="automations-page">
    <PendingOverlay running={operations.running} />
    <header className="page-heading">
      <h2><CalendarClock size={20} />定期実行</h2>
      <p>決まった時刻に、Prompt と許可したツールだけで動きます。前回の実行は覚えていません。</p>
    </header>
    <OperationError error={operations.error} />

    <ul className="automation-list">
      {automations.map((automation) => <li key={automation.id}>
        <div className="automation-row">
          <span className="automation-name">{automation.name}</span>
          <span>{automation.schedule}</span>
          <span>{automation.state}</span>
          <span>{automation.nextRunAt ? `次回 ${automation.nextRunAt}` : '予定なし'}</span>
          <button type="button" className="secondary" disabled={operations.pending(pendingKey.scheduleRuns(automation.id))} onClick={() => showRuns(automation.id)}>{operations.pending(pendingKey.scheduleRuns(automation.id)) ? <RefreshCw className="spin" size={14} /> : null}実行履歴</button>
          <button type="button" className="secondary" disabled={operations.pending(pendingKey.scheduleRemove(automation.id))} onClick={() => remove(automation.id)} aria-label={`${automation.name} を削除`}><Trash2 size={16} /></button>
        </div>
        {automation.lastError && <p className="chat-failure">{automation.lastError}</p>}
        {runs[automation.id] && <AutomationRunList runs={runs[automation.id] ?? []} />}
      </li>)}
    </ul>

    <form className="access-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <h3>追加</h3>
      <label>名前<input value={name} onChange={(event) => setName(event.target.value)} placeholder="朝の確認" /></label>
      <label>Prompt
        <select value={promptId} onChange={(event) => setPromptId(event.target.value)}>
          {prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.name}</option>)}
        </select>
      </label>
      <label>スケジュール
        <input value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="daily 09:00" />
      </label>
      <label>UTC からの分オフセット
        <input type="number" value={offsetMinutes} onChange={(event) => setOffsetMinutes(Number(event.target.value))} />
      </label>
      <fieldset>
        <legend>許可するツール</legend>
        {[...READ_TOOLS, ...WRITE_TOOLS].map((tool) => <label key={tool} className="access-check">
          <input type="checkbox" checked={tools.includes(tool)} onChange={() => setTools((current) => toggle(current, tool))} />
          {tool}
        </label>)}
      </fieldset>
      {grantsWrite && <label>届けてよい相手
        <select value={contactListId} onChange={(event) => setContactListId(event.target.value)}>
          {lists.map((list) => <option key={list.id} value={list.id}>{list.name}（{list.contactIds.length}名）</option>)}
        </select>
      </label>}
      <label>同じ送信を抑止する期間
        <select value={suppressionWindow} onChange={(event) => setSuppressionWindow(event.target.value)}>
          {WINDOWS.map((window) => <option key={window} value={window}>{window}</option>)}
        </select>
      </label>
      <label>状態
        <select value={state} onChange={(event) => setState(event.target.value)}>
          {STATES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </label>
      <button type="submit" className="primary" disabled={saving || !name.trim() || !promptId || (grantsWrite && !contactListId)}>{saving ? <><RefreshCw className="spin" size={14} />保存中…</> : '保存'}</button>
    </form>
  </section>;
};

export default AutomationsScreen;

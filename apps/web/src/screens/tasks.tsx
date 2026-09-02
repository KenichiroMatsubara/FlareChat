import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom';

import type { Contact, Task, TaskUpdate } from '@mail/domain';

import { api } from '../api';
import { accountIdOf, useAccount } from '../dashboard';
import { FieldSaveState, OperationError } from '../parts';
import { pendingKey, usePendingOperations, type PendingOperations } from '../pending';
import { PendingOverlay } from '../progress';
import { loadReminders, Reminders, type ReminderData } from '../reminders';

export interface TasksData {
  tasks: Task[];
  contacts: Contact[];
  reminders: ReminderData;
}

export const loader = async (args: LoaderFunctionArgs): Promise<TasksData> => {
  const accountId = accountIdOf(args);
  const [tasks, contacts, reminders] = await Promise.all([
    api.tasks(accountId),
    api.contacts(accountId),
    loadReminders(accountId),
  ]);
  return { tasks, contacts, reminders };
};

/** One row of the Task table: its completion and its remarks each report their own save. */
const TaskRow = ({ task, assignees, operations, today, near, onUpdate }: {
  task: Task;
  assignees: readonly Contact[];
  operations: PendingOperations;
  today: string;
  near: string;
  onUpdate: (taskId: string, input: TaskUpdate) => void;
}) => {
  const saving = operations.pending(pendingKey.taskUpdate(task.id));
  const saved = operations.settled(pendingKey.taskUpdate(task.id));
  return <tr className={task.completed ? 'completed' : task.deadline < today ? 'overdue' : task.deadline <= near ? 'near-deadline' : ''} aria-busy={saving}>
    <td><input aria-label={`${task.title}を完了`} type="checkbox" checked={task.completed} disabled={saving} onChange={(change) => onUpdate(task.id, { completed: change.target.checked })} />{saving && <RefreshCw className="spin" size={12} />}</td>
    <td>{task.deadline}</td>
    <td><select
      aria-label={`${task.title}の担当`}
      value={task.assigneeContactId ?? ''}
      disabled={saving}
      onChange={(change) => onUpdate(task.id, { assigneeContactId: change.target.value || null })}
    ><option value="">未割り当て</option>{assignees.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select></td>
    <td>{task.sourceMessageSubject}</td>
    <td><strong>{task.title}</strong><small>{task.description}</small></td>
    <td><textarea aria-label={`${task.title}の備考`} defaultValue={task.remarks} disabled={saving} onBlur={(change) => { if (change.target.value !== task.remarks) onUpdate(task.id, { remarks: change.target.value }); }} maxLength={10_000} /><FieldSaveState saving={saving} saved={saved} /></td>
  </tr>;
};

/** The Account's Tasks, who each was given to, and the reminders that chase them. */
const TasksScreen = () => {
  const { tasks, contacts, reminders } = useLoaderData<TasksData>();
  const { account } = useAccount();
  const operations = usePendingOperations();
  const revalidator = useRevalidator();
  const accountId = account.accountId;
  const [assignee, setAssignee] = useState('');
  const [event, setEvent] = useState('');
  const assignees = contacts.filter((contact) => contact.state === 'active');
  const named = [...new Map(tasks.flatMap((task) => task.assigneeContactId ? [[task.assigneeContactId, task.assigneeName] as const] : [])).entries()];
  const events = [...new Set(tasks.map((task) => task.sourceMessageSubject))];
  const visible = tasks.filter((task) => (
    !assignee
    || (assignee === 'unassigned' ? !task.assigneeContactId : task.assigneeContactId === assignee)
  ) && (!event || task.sourceMessageSubject === event));
  const today = new Date().toISOString().slice(0, 10);
  const near = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const update = (taskId: string, input: TaskUpdate): void => void operations.run(pendingKey.taskUpdate(taskId), async () => {
    await api.updateTask(accountId, taskId, input);
    await revalidator.revalidate();
  });
  return <section className="page-layout tasks-page">
    <PendingOverlay running={operations.running} />
    <OperationError error={operations.error} />
    <div className="page-title"><p>ACCOUNT TASKS</p><h1>タスク</h1><span>Source Message から抽出された期限タスクです。担当は抽出時に連絡先が指名され、ここで付け替えられます。</span></div>
    <section className="task-filters"><label>担当者<select value={assignee} onChange={(change) => setAssignee(change.target.value)}><option value="">すべて</option><option value="unassigned">未割り当て</option>{named.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>イベント<select value={event} onChange={(change) => setEvent(change.target.value)}><option value="">すべて</option>{events.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><button className="secondary" onClick={() => { setAssignee(''); setEvent(''); }}>フィルターをリセット</button></section>
    <section className="tasks-table-wrap"><table className="tasks-table"><thead><tr><th>完了</th><th>期限</th><th>担当</th><th>イベント名</th><th>内容</th><th>備考</th></tr></thead><tbody>{visible.map((task) => <TaskRow key={task.id} task={task} assignees={assignees} operations={operations} today={today} near={near} onUpdate={update} />)}</tbody></table>{visible.length === 0 && <p className="rules-empty">表示するタスクはありません。</p>}</section>
    <Reminders accountId={accountId} reminders={reminders} reload={() => revalidator.revalidate()} />
  </section>;
};

export default TasksScreen;

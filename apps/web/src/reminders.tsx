import { MIN_ATTENDANCE_REMINDER_DAY, MIN_REMINDER_DAY } from '@mail/domain';
import { BellRing, CheckCircle2, CircleAlert, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { ReminderCadence, ReminderCadenceInput, ReminderSubject, ScheduledReminder } from '@mail/domain';

import { api } from './api';
import { errorText } from './parts';

/**
 * How one milestone reads to an operator. A bare `-1` in a list of days is not
 * something anybody should have to interpret, so the sign is spelled out.
 */
export const milestoneLabel = (day: number): string => day > 0
  ? `締め切り${day}日前`
  : day === 0 ? '締め切り当日' : `締め切り${Math.abs(day)}日後`;

/**
 * The milestones an Account reminds on, and the only way to change them. Both
 * cadences are edited through it (ADR 0164): a Response Deadline is a deadline
 * an Account sets itself, so it chooses how far ahead to chase it exactly as it
 * does for a Task.
 */
export const MilestoneEditor = ({ days, busy, label, minimum, onChange }: {
  days: readonly number[];
  busy: boolean;
  label: string;
  minimum: number;
  onChange: (next: readonly number[]) => void;
}) => {
  const [entry, setEntry] = useState('0');
  const day = Number(entry.trim());
  const addable = Number.isInteger(day) && day >= minimum && !days.includes(day);

  return <>
    {days.length === 0
      ? <p className="rules-empty">リマインドする日が設定されていません。</p>
      : <ul className="reminder-days">
        {days.map((current) => <li key={current}>
          <span>{milestoneLabel(current)}</span>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            aria-label={`${label}の${milestoneLabel(current)}のリマインドを削除`}
            onClick={() => onChange(days.filter((kept) => kept !== current))}
          ><Trash2 size={16} /></button>
        </li>)}
      </ul>}
    <form className="access-form" onSubmit={(event) => { event.preventDefault(); if (addable) onChange([...days, day]); }}>
      <label>
        締め切りからの日数
        <input type="number" min={minimum} value={entry} disabled={busy} aria-label={`${label}をリマインドする日`} onChange={(change) => setEntry(change.target.value)} />
      </label>
      <button type="submit" className="primary" disabled={busy || !addable}>
        <Plus size={16} />追加
      </button>
    </form>
  </>;
};

/** How a reminder's subject reads in the schedule. */
export const subjectLabel = (subject: ReminderSubject): string => subject === 'task' ? 'タスク' : '出欠';

/** Which subjects are switched on, so the schedule can say what will not be sent. */
export type ReminderSwitches = Record<ReminderSubject, boolean>;

/**
 * The Reminder Schedule: every reminder the configured milestones will send,
 * whichever subject it is about, addressed and worded as it will arrive. It is
 * rendered whether or not reminders are switched on, because deciding to turn
 * them on is exactly when somebody needs to see what that would send; a row
 * whose switch is off says so rather than implying delivery.
 */
export const ReminderSchedule = ({ rows, enabled }: { rows: readonly ScheduledReminder[]; enabled: ReminderSwitches }) => {
  if (rows.length === 0) return <p className="rules-empty">送信予定のリマインドはありません。</p>;
  const muted = rows.some((row) => !enabled[row.subject]);
  return <>
    {muted && <p className="reminder-muted">
      <CircleAlert size={15} />オフの種別のリマインドは送信されません。オンにするとこの内容で送られます。
    </p>}
    <div className="reminder-schedule-wrap">
      <table className="reminder-schedule">
        <thead><tr><th>送信日</th><th>種別</th><th>タイミング</th><th>宛先</th><th>送信内容</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={`${row.subject}:${row.subjectId}:${row.contactId}:${row.milestone}`} className={enabled[row.subject] ? undefined : 'muted'}>
            <td>{row.sendOn}</td>
            <td>{subjectLabel(row.subject)}{!enabled[row.subject] && <small>オフ</small>}</td>
            <td>{milestoneLabel(row.milestone)}</td>
            <td><strong>{row.contactName}</strong><small>{row.channel.toUpperCase()} {row.destination}</small></td>
            <td><pre>{row.text}</pre></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </>;
};

const ReminderSwitch = ({ enabled, busy, onChange, label }: {
  enabled: boolean;
  busy: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) => <section className="hero-status reminder-switch">
  <div>
    <span className={enabled ? 'status-light on' : 'status-light'} />
    <p>{enabled ? `${label}は有効です` : `${label}は停止中です`}</p>
    <small>{enabled ? '下の予定どおりに送信されます。' : 'オンにするまで一通も送信されません。'}</small>
  </div>
  <div className="hero-switch">
    {busy && <small className="field-state saving"><RefreshCw className="spin" size={12} />切替中…</small>}
    <label className="switch">
      <input type="checkbox" checked={enabled} disabled={busy} aria-label={`${label}を切り替える`} onChange={(event) => onChange(event.target.checked)} />
      <span />
    </label>
  </div>
</section>;

/** The Reminder Schedule the Tasks screen shows, and the two cadences behind it. */
export interface ReminderData {
  taskCadence: ReminderCadence;
  attendanceCadence: ReminderCadence;
  schedule: ScheduledReminder[];
}

export const loadReminders = async (accountId: string): Promise<ReminderData> => {
  const [taskCadence, attendanceCadence, schedule] = await Promise.all([
    api.taskReminders(accountId),
    api.attendanceReminders(accountId),
    api.reminderSchedule(accountId),
  ]);
  return { taskCadence, attendanceCadence, schedule };
};

/**
 * Both reminder cadences an Account controls, each beside the schedule it
 * produces. Both are chosen the same way (ADR 0164): a switch, the milestones
 * counted from the deadline, and the schedule those milestones would send.
 */
export const Reminders = ({ accountId, reminders, reload }: { accountId: string; reminders: ReminderData; reload: () => Promise<void> }) => {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const save = async (work: () => Promise<unknown>, fallback: string): Promise<void> => {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await work();
      await reload();
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause, fallback));
    } finally {
      setSaving(false);
    }
  };

  const saveTask = (input: ReminderCadenceInput): void =>
    void save(() => api.saveTaskReminders(accountId, input), 'タスクのリマインド設定を保存できませんでした。');

  const saveAttendance = (input: ReminderCadenceInput): void =>
    void save(() => api.saveAttendanceReminders(accountId, input), '出欠のリマインド設定を保存できませんでした。');

  return <section className="page-layout reminders-page">
    <div className="page-title">
      <p>REMINDERS</p>
      <h1>リマインド</h1>
      <span>タスクの締め切りと出欠の回答期限について、連絡先へ送るリマインドです。送信予定はオフのままでも確認できます。</span>
    </div>
    {error && <p className="chat-failure"><CircleAlert size={16} />{error}</p>}
    {saving && <small className="field-state saving"><RefreshCw className="spin" size={12} />保存中…</small>}
    {!saving && saved && <small className="field-state saved"><CheckCircle2 size={12} />保存しました</small>}

    <section className="access-panel">
      <h3><BellRing size={17} />タスクのリマインド</h3>
      <ReminderSwitch enabled={reminders.taskCadence.enabled} busy={saving} label="タスクのリマインド" onChange={(next) => saveTask({ enabled: next })} />
      <p className="api-guide">
        未完了で担当者のいるタスクについて、締め切りからの日数でリマインドします。
        正の数は締め切り前、0 は当日、負の数は期限切れ後です。
      </p>
      <MilestoneEditor days={reminders.taskCadence.days} busy={saving} label="タスク" minimum={MIN_REMINDER_DAY} onChange={(next) => saveTask({ days: next })} />
    </section>

    <section className="access-panel">
      <h3><BellRing size={17} />出欠のリマインド</h3>
      <ReminderSwitch enabled={reminders.attendanceCadence.enabled} busy={saving} label="出欠のリマインド" onChange={(next) => saveAttendance({ enabled: next })} />
      <p className="api-guide">
        まだ回答していない相手にだけ、回答期限からの日数でお願いを送ります。出欠を登録した時点で止まります。
        正の数は回答期限前、0 は当日です。期限を過ぎた出欠は受け付けられないため、当日より後は設定できません。
      </p>
      <MilestoneEditor days={reminders.attendanceCadence.days} busy={saving} label="出欠" minimum={MIN_ATTENDANCE_REMINDER_DAY} onChange={(next) => saveAttendance({ days: next })} />
    </section>

    <section className="access-panel">
      <h3><BellRing size={17} />送信予定</h3>
      <ReminderSchedule
        rows={reminders.schedule}
        enabled={{ task: reminders.taskCadence.enabled, registration: reminders.attendanceCadence.enabled }}
      />
    </section>
  </section>;
};

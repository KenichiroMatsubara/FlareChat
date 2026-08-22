import { BellRing, CheckCircle2, CircleAlert, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api, type ScheduledAttendanceReminder, type ScheduledTaskReminder } from './api';

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * How one milestone reads to an operator. A bare `-1` in a list of days is not
 * something anybody should have to interpret, so the sign is spelled out.
 */
export const milestoneLabel = (day: number): string => day > 0
  ? `締め切り${day}日前`
  : day === 0 ? '締め切り当日' : `締め切り${Math.abs(day)}日後`;

/** The milestones as they read together, for a page that only reports them. */
export const MilestoneSummary = ({ days }: { days: readonly number[] }) => days.length === 0
  ? <p className="rules-empty">リマインドしません。</p>
  : <ul className="reminder-days">
    {days.map((day) => <li key={day}>{milestoneLabel(day)}</li>)}
  </ul>;

/** One row of either preview, which differ only in what they name. */
interface PreviewRow {
  key: string;
  sendOn: string;
  milestone: number;
  contactName: string;
  channel: string;
  destination: string;
  text: string;
}

/**
 * What the configured milestones will send, addressed and worded as it will
 * arrive. It is rendered whether or not reminders are switched on, because
 * deciding to turn them on is exactly when somebody needs to see what that
 * would send; when the switch is off it says so rather than implying delivery.
 */
export const ReminderSchedule = ({ rows, enabled }: { rows: readonly PreviewRow[]; enabled: boolean }) => rows.length === 0
  ? <p className="rules-empty">送信予定のリマインドはありません。</p>
  : <>
    {!enabled && <p className="reminder-muted">
      <CircleAlert size={15} />オフのため、これらは送信されません。オンにするとこの内容で送られます。
    </p>}
    <div className="reminder-schedule-wrap">
      <table className={enabled ? 'reminder-schedule' : 'reminder-schedule muted'}>
        <thead><tr><th>送信日</th><th>タイミング</th><th>宛先</th><th>送信内容</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.key}>
            <td>{row.sendOn}</td>
            <td>{milestoneLabel(row.milestone)}</td>
            <td><strong>{row.contactName}</strong><small>{row.channel.toUpperCase()} {row.destination}</small></td>
            <td><pre>{row.text}</pre></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </>;

export const taskPreviewRows = (reminders: readonly ScheduledTaskReminder[]): PreviewRow[] =>
  reminders.map((reminder) => ({ ...reminder, key: `${reminder.taskId}:${reminder.milestone}` }));

export const attendancePreviewRows = (reminders: readonly ScheduledAttendanceReminder[]): PreviewRow[] =>
  reminders.map((reminder) => ({ ...reminder, key: `${reminder.eventId}:${reminder.contactId}:${reminder.milestone}` }));

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

/**
 * Both reminder cadences an Account controls, each beside the schedule it
 * produces. The Task milestones are chosen; the attendance milestones are fixed
 * by ADR 0030, so only its switch is offered.
 */
export const RemindersPage = ({ accountId }: { accountId: string }) => {
  const [taskEnabled, setTaskEnabled] = useState(false);
  const [days, setDays] = useState<readonly number[]>([]);
  const [taskSchedule, setTaskSchedule] = useState<readonly ScheduledTaskReminder[]>([]);
  const [attendanceEnabled, setAttendanceEnabled] = useState(false);
  const [attendanceDays, setAttendanceDays] = useState<readonly number[]>([]);
  const [attendanceSchedule, setAttendanceSchedule] = useState<readonly ScheduledAttendanceReminder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [entry, setEntry] = useState('0');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const reload = (): Promise<void> => Promise.all([
    api.taskReminders(accountId),
    api.scheduledTaskReminders(accountId),
    api.attendanceReminders(accountId),
    api.scheduledAttendanceReminders(accountId),
  ]).then(([task, taskUpcoming, attendance, attendanceUpcoming]) => {
    setTaskEnabled(task.enabled);
    setDays(task.days);
    setTaskSchedule(taskUpcoming);
    setAttendanceEnabled(attendance.enabled);
    setAttendanceDays(attendance.days);
    setAttendanceSchedule(attendanceUpcoming);
    setLoaded(true);
  }).catch((cause: unknown) => setError(errorText(cause, 'リマインドの設定を取得できませんでした。')));

  useEffect(() => {
    setLoaded(false);
    void reload();
  }, [accountId]);

  const run = async (work: () => Promise<unknown>, fallback: string): Promise<void> => {
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

  const saveTask = (input: { days?: readonly number[]; enabled?: boolean }): void =>
    void run(() => api.saveTaskReminders(accountId, input), 'タスクのリマインド設定を保存できませんでした。');

  const add = (): void => {
    const day = Number(entry.trim());
    if (!Number.isInteger(day) || days.includes(day)) return;
    saveTask({ days: [...days, day] });
  };

  if (!loaded && !error) {
    return <section className="page-layout reminders-page">
      <div className="loading"><RefreshCw className="spin" size={18} />読み込み中…</div>
    </section>;
  }

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
      <ReminderSwitch
        enabled={taskEnabled}
        busy={saving}
        label="タスクのリマインド"
        onChange={(next) => saveTask({ enabled: next })}
      />
      <p className="api-guide">
        未完了で担当者のいるタスクについて、締め切りからの日数でリマインドします。
        正の数は締め切り前、0 は当日、負の数は期限切れ後です。
      </p>
      {days.length === 0
        ? <p className="rules-empty">リマインドする日が設定されていません。</p>
        : <ul className="reminder-days">
          {days.map((day) => <li key={day}>
            <span>{milestoneLabel(day)}</span>
            <button
              type="button"
              className="secondary"
              disabled={saving}
              aria-label={`${milestoneLabel(day)}のリマインドを削除`}
              onClick={() => saveTask({ days: days.filter((current) => current !== day) })}
            ><Trash2 size={16} /></button>
          </li>)}
        </ul>}
      <form className="access-form" onSubmit={(event) => { event.preventDefault(); add(); }}>
        <label>
          締め切りからの日数
          <input type="number" value={entry} disabled={saving} onChange={(change) => setEntry(change.target.value)} />
        </label>
        <button type="submit" className="primary" disabled={saving || !Number.isInteger(Number(entry.trim())) || days.includes(Number(entry.trim()))}>
          <Plus size={16} />追加
        </button>
      </form>
      <h4>送信予定</h4>
      <ReminderSchedule rows={taskPreviewRows(taskSchedule)} enabled={taskEnabled} />
    </section>

    <section className="access-panel">
      <h3><BellRing size={17} />出欠のリマインド</h3>
      <ReminderSwitch
        enabled={attendanceEnabled}
        busy={saving}
        label="出欠のリマインド"
        onChange={(next) => void run(() => api.saveAttendanceReminders(accountId, next), '出欠のリマインド設定を保存できませんでした。')}
      />
      <p className="api-guide">
        まだ回答していない相手にだけ、回答期限の前にお願いを送ります。出欠を登録した時点で止まります。
        送信する日は製品側で決まっており、変更できません。
      </p>
      <MilestoneSummary days={attendanceDays} />
      <h4>送信予定</h4>
      <ReminderSchedule rows={attendancePreviewRows(attendanceSchedule)} enabled={attendanceEnabled} />
    </section>
  </section>;
};

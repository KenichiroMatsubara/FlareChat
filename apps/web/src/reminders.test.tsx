import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MilestoneEditor, ReminderSchedule, milestoneLabel } from './reminders';
import type { ScheduledReminder } from '@mail/domain';

const reminder = (overrides: Partial<ScheduledReminder>): ScheduledReminder => ({
  subject: 'task',
  subjectId: 'task-1',
  title: '参加費を振り込む',
  deadline: '2026-08-20',
  contactId: 'contact-1',
  contactName: '山田花子',
  channel: 'line',
  destination: 'Umemb…',
  milestone: 0,
  sendOn: '2026-08-20',
  text: '【リマインド】本日が締め切りです\n・8/20(木)まで 参加費を振り込む',
  ...overrides,
});

describe('Task reminder milestones', () => {
  it('says which side of the deadline a milestone sits on', () => {
    expect(milestoneLabel(3)).toBe('締め切り3日前');
    expect(milestoneLabel(0)).toBe('締め切り当日');
    expect(milestoneLabel(-1)).toBe('締め切り1日後');
  });

  it('lists the milestones in the order they fire, and offers to remove each', () => {
    const markup = renderToStaticMarkup(
      <MilestoneEditor days={[7, 3, 1, 0, -1]} busy={false} label="タスク" minimum={-30} onChange={() => undefined} />,
    );

    expect(markup).toContain('締め切り7日前');
    expect(markup).toContain('締め切り当日');
    expect(markup).toContain('締め切り1日後');
    expect(markup).toContain('タスクの締め切り7日前のリマインドを削除');
    expect(markup.indexOf('締め切り7日前')).toBeLessThan(markup.indexOf('締め切り当日'));
  });

  it('offers the same editor to the attendance cadence, named for it', () => {
    const markup = renderToStaticMarkup(
      <MilestoneEditor days={[7]} busy={false} label="出欠" minimum={0} onChange={() => undefined} />,
    );

    expect(markup).toContain('出欠をリマインドする日');
    expect(markup).toContain('出欠の締め切り7日前のリマインドを削除');
    expect(markup).toContain('min="0"');
  });

  it('says nothing is set rather than rendering an empty list, and still takes a new day', () => {
    const markup = renderToStaticMarkup(
      <MilestoneEditor days={[]} busy={false} label="タスク" minimum={-30} onChange={() => undefined} />,
    );

    expect(markup).toContain('リマインドする日が設定されていません。');
    expect(markup).toContain('追加');
  });
});

describe('the schedule of reminders still to be sent', () => {
  it('shows who each reminder reaches, when, and the words it will arrive with', () => {
    const markup = renderToStaticMarkup(<ReminderSchedule rows={[reminder({})]} enabled={{ task: true, registration: true }} />);

    expect(markup).toContain('2026-08-20');
    expect(markup).toContain('山田花子');
    expect(markup).toContain('LINE');
    expect(markup).toContain('本日が締め切りです');
    expect(markup).toContain('締め切り当日');
  });

  it('never shows a whole LINE destination, as no other Account screen does', () => {
    const markup = renderToStaticMarkup(<ReminderSchedule rows={[reminder({})]} enabled={{ task: true, registration: true }} />);

    expect(markup).toContain('Umemb…');
    expect(markup).not.toContain('Umember-1');
  });

  it('says there is nothing coming rather than rendering an empty table', () => {
    expect(renderToStaticMarkup(<ReminderSchedule rows={[]} enabled={{ task: true, registration: true }} />)).toContain('送信予定のリマインドはありません。');
  });

  it('shows the schedule while reminders are off, and says they will not be sent', () => {
    const markup = renderToStaticMarkup(<ReminderSchedule rows={[reminder({})]} enabled={{ task: false, registration: true }} />);

    expect(markup).toContain('本日が締め切りです');
    expect(markup).toContain('オフの種別のリマインドは送信されません');
  });

  it('names the subject of each row, and marks the ones whose switch is off', () => {
    const markup = renderToStaticMarkup(<ReminderSchedule rows={[
      reminder({}),
      reminder({ subject: 'registration', subjectId: 'event-1', title: '例会', text: '【出欠のお願い】回答期限まであと3日' }),
    ]} enabled={{ task: true, registration: false }} />);

    expect(markup).toContain('タスク');
    expect(markup).toContain('出欠');
    expect(markup).toContain('回答期限まであと3日');
    expect(markup).toContain('オフ');
  });

  it('does not warn about being off when reminders are on', () => {
    const markup = renderToStaticMarkup(<ReminderSchedule rows={[reminder({})]} enabled={{ task: true, registration: true }} />);

    expect(markup).not.toContain('オフのため');
  });

  it('keeps one row per Task and milestone so the same Task may appear more than once', () => {
    const markup = renderToStaticMarkup(<ReminderSchedule rows={[
      reminder({ milestone: 1, sendOn: '2026-08-19' }),
      reminder({ milestone: -1, sendOn: '2026-08-21' }),
    ]} enabled={{ task: true, registration: true }} />);

    expect(markup).toContain('締め切り1日前');
    expect(markup).toContain('締め切り1日後');
  });
});

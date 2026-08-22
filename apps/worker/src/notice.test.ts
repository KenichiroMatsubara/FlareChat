import { describe, expect, it } from 'vitest';

import { sourceMessageNotice, taskReminderNotice } from './notice';

const event = {
  title: '定例会議',
  startsAt: '2026-08-25T19:00:00+09:00',
  endsAt: '2026-08-25T21:00:00+09:00',
  location: '第一会議室',
};

const task = {
  title: '会場を予約する',
  deadline: '2026-08-28',
  assigneeName: '山田',
};

describe('source message notice', () => {
  it('states the summary, the events, and the Tasks as one message', () => {
    expect(sourceMessageNotice({
      summary: '次年度の活動方針を共有するお知らせです。',
      events: [event],
      tasks: [task],
    })).toBe([
      '次年度の活動方針を共有するお知らせです。',
      '',
      '【予定】',
      '・8/25(火) 19:00〜21:00 定例会議（第一会議室）',
      '',
      '【タスク】',
      '・8/28(金)まで 会場を予約する（山田）',
    ].join('\n'));
  });

  it('reads as the summary alone when the message produced neither an event nor a Task', () => {
    expect(sourceMessageNotice({ summary: 'お知らせです。', events: [], tasks: [] })).toBe('お知らせです。');
  });

  it('names the closing day when an event does not end on the day it starts', () => {
    expect(sourceMessageNotice({
      summary: '合宿の案内です。',
      events: [{ ...event, title: '夏合宿', location: '', endsAt: '2026-08-26T12:00:00+09:00' }],
      tasks: [],
    })).toContain('・8/25(火) 19:00〜8/26(水) 12:00 夏合宿');
  });

  it('states the times of an event in the Account time zone rather than in UTC', () => {
    expect(sourceMessageNotice({
      summary: '案内です。',
      events: [{ ...event, startsAt: '2026-08-25T10:00:00Z', endsAt: '2026-08-25T12:00:00Z' }],
      tasks: [],
    })).toContain('・8/25(火) 19:00〜21:00 定例会議（第一会議室）');
  });

  it('repeats an instant it cannot read rather than stating a date it did not derive', () => {
    expect(sourceMessageNotice({
      summary: '案内です。',
      events: [{ ...event, startsAt: '来週の火曜日', endsAt: '' }],
      tasks: [{ ...task, deadline: '今月中' }],
    })).toContain('・来週の火曜日 定例会議（第一会議室）');
  });

  it('leaves out a location the extraction did not state', () => {
    expect(sourceMessageNotice({ summary: '案内です。', events: [{ ...event, location: '  ' }], tasks: [] }))
      .toBe('案内です。\n\n【予定】\n・8/25(火) 19:00〜21:00 定例会議');
  });
});

describe('Task reminder notice', () => {
  const reminder = {
    title: '登録用紙の返信',
    deadline: '2026-08-29',
    milestone: 3,
    sourceMessageSubject: '田原RAC9月第一例会「ビールの世界」ご案内',
    description: '登録用紙にふりがなを含めて記入し、メールで返信する。',
  };

  it('places the Task by naming the message it came from and what it asks for', () => {
    expect(taskReminderNotice(reminder)).toBe([
      '【リマインド】締め切りまであと3日',
      '・8/29(土)まで 登録用紙の返信',
      '元メール：田原RAC9月第一例会「ビールの世界」ご案内',
      '登録用紙にふりがなを含めて記入し、メールで返信する。',
    ].join('\n'));
  });

  it('states the milestone in words on the deadline day and after it', () => {
    expect(taskReminderNotice({ ...reminder, milestone: 0 })).toContain('【リマインド】本日が締め切りです');
    expect(taskReminderNotice({ ...reminder, milestone: -2 })).toContain('【リマインド】期限切れです（2日経過）');
  });

  it('leaves out a subject or a description the Task does not carry', () => {
    expect(taskReminderNotice({ ...reminder, sourceMessageSubject: '  ', description: '' }))
      .toBe('【リマインド】締め切りまであと3日\n・8/29(土)まで 登録用紙の返信');
  });
});

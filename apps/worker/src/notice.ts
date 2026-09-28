/**
 * The one notice a Source Message produces.
 *
 * A Contact reading LINE learns everything one message caused in a single
 * place: what it said, the Scheduled Events it produced, and the Tasks it
 * raised. Sending the summary on its own and leaving the events and Tasks to be
 * discovered elsewhere makes the reader correlate three sources for one piece of
 * news, so they are composed here and delivered once.
 *
 * The composition is deliberately pure. What it states is decided by the caller,
 * which delivers only after the events and Tasks are actually applied, so a
 * notice never announces work that did not happen.
 *
 * Nothing composed here is sent when it is composed: each notice is kept as a
 * Morning Entry and reaches its reader inside the Morning Notice, which is
 * composed here too (ADR 0176).
 */

/** One Scheduled Event as it is stated to a reader. */
export interface NoticeEvent {
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
}

/** One Task as it is stated to a reader, already carrying its resolved assignee. */
export interface NoticeTask {
  title: string;
  deadline: string;
  assigneeName: string;
}

const TIME_ZONE = 'Asia/Tokyo';

const dayAndWeekday = new Intl.DateTimeFormat('ja-JP', { timeZone: TIME_ZONE, month: 'numeric', day: 'numeric', weekday: 'short' });
const clock = new Intl.DateTimeFormat('ja-JP', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
const calendarDay = new Intl.DateTimeFormat('ja-JP', { timeZone: TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric' });

/** An instant the extraction stated, or null when what it stated cannot be read as one. */
const instant = (value: string): Date | null => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
};

/**
 * When one event runs. An unreadable instant is repeated as the extraction wrote
 * it rather than replaced by a date this could not derive.
 */
const when = (startsAt: string, endsAt: string): string => {
  const start = instant(startsAt);
  if (!start) return startsAt;
  const opening = `${dayAndWeekday.format(start)} ${clock.format(start)}`;
  const end = instant(endsAt);
  if (!end) return opening;
  return calendarDay.format(start) === calendarDay.format(end)
    ? `${opening}〜${clock.format(end)}`
    : `${opening}〜${dayAndWeekday.format(end)} ${clock.format(end)}`;
};

/** By when one Task is due, from the date-only deadline the extraction states. */
const by = (deadline: string): string => {
  const date = instant(deadline);
  return date ? `${dayAndWeekday.format(date)}まで` : `${deadline}まで`;
};

const eventLine = (event: NoticeEvent): string => {
  const location = event.location.trim();
  return `・${when(event.startsAt, event.endsAt)} ${event.title}${location ? `（${location}）` : ''}`;
};

const taskLine = (task: NoticeTask): string => `・${by(task.deadline)} ${task.title}（${task.assigneeName}）`;

/**
 * One Task reminder as its assignee reads it, and as the administration GUI
 * shows it before it is sent. The milestone is stated in words rather than as a
 * signed number of days, because "本日締め切り" and "期限切れ" are what a reader
 * acts on; the same composition serves the preview so the GUI cannot promise
 * text the delivery would not send.
 */
export const attendanceReminderNotice = (input: {
  title: string;
  deadline: string;
  milestone: number;
}): string => {
  const heading = input.milestone > 0
    ? `【出欠のお願い】回答期限まであと${input.milestone}日`
    : input.milestone === 0
      ? '【出欠のお願い】本日が回答期限です'
      : '【出欠のお願い】回答期限を過ぎています';
  return `${heading}\n・${input.title}（${by(input.deadline)}）`;
};

/**
 * A Task's title is a fragment of the message it was raised from — "登録用紙の返信"
 * names an action but not which registration form — so the reminder states the
 * Source Message it came from and what the extraction understood the Task to be.
 * Both are already on the Task; stating only the title left the reader to
 * recognise a deadline they had no way to place.
 */
export const taskReminderNotice = (input: {
  title: string;
  deadline: string;
  milestone: number;
  sourceMessageSubject?: string;
  description?: string;
}): string => {
  const heading = input.milestone > 0
    ? `【リマインド】締め切りまであと${input.milestone}日`
    : input.milestone === 0
      ? '【リマインド】本日が締め切りです'
      : `【リマインド】期限切れです（${Math.abs(input.milestone)}日経過）`;
  const subject = input.sourceMessageSubject?.trim();
  const description = input.description?.trim();
  return [
    `${heading}\n・${by(input.deadline)} ${input.title}`,
    ...(subject ? [`元メール：${subject}`] : []),
    ...(description ? [description] : []),
  ].join('\n');
};

/**
 * One Source Message's summary, the events it produced, and the Tasks it raised,
 * as one message. A section with nothing in it is left out entirely, so a
 * message that produced neither reads exactly as its summary alone.
 */
export const sourceMessageNotice = (input: {
  summary: string;
  events: readonly NoticeEvent[];
  tasks: readonly NoticeTask[];
}): string => [
  input.summary.trim(),
  ...(input.events.length ? [['【予定】', ...input.events.map(eventLine)].join('\n')] : []),
  ...(input.tasks.length ? [['【タスク】', ...input.tasks.map(taskLine)].join('\n')] : []),
].filter(Boolean).join('\n\n');

/** One thing a Morning Notice carries, as its reader will see it. */
export interface MorningNoticeEntry {
  /** What the entry is about, such as the subject of the mail it came from; empty when the body says it. */
  heading: string;
  body: string;
}

/** Splits text that alone exceeds a limit, never between the two halves of a surrogate pair. */
const hardSplit = (text: string, limit: number): string[] => {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const low = rest.charCodeAt(limit);
    const cut = low >= 0xdc00 && low <= 0xdfff ? limit - 1 : limit;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return rest ? [...pieces, rest] : pieces;
};

/** The subject a Morning Notice carries when it arrives by email. */
export const morningNoticeSubject = (morning: string): string => `朝のお知らせ ${dayAndWeekday.format(new Date(morning))}`;

/**
 * One address's Morning Notice (ADR 0176): every entry kept for it since the
 * last Morning, under one heading naming the day, packed into as few texts of at
 * most `limit` characters as the entries allow.
 *
 * An entry is never divided while a whole one still fits in a fresh text, so a
 * reader finds each piece of news in one place; only an entry longer than the
 * limit on its own is cut. The address's quota pays per request rather than per
 * text, so the caller carries these texts in as few requests as the Channel
 * allows.
 */
export const morningNotice = (input: {
  morning: string;
  entries: readonly MorningNoticeEntry[];
  limit: number;
}): string[] => {
  const blocks = [
    `【${dayAndWeekday.format(new Date(input.morning))}のお知らせ】`,
    ...input.entries.map(({ heading, body }) => heading.trim() ? `■ ${heading.trim()}\n${body.trim()}` : body.trim()),
  ].filter(Boolean);
  const texts: string[] = [];
  let current = '';
  for (const block of blocks) {
    const joined = current ? `${current}\n\n${block}` : block;
    if (joined.length <= input.limit) {
      current = joined;
      continue;
    }
    if (current) texts.push(current);
    const pieces = hardSplit(block, input.limit);
    current = pieces.pop() ?? '';
    texts.push(...pieces);
  }
  return current ? [...texts, current] : texts;
};

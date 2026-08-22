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

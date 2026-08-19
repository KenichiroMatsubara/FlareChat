/**
 * When a Trigger with no payload is next due (ADR 0140).
 *
 * A deliberately small vocabulary rather than cron: an Account states a time it
 * would say out loud, and anything this cannot run is refused instead of guessed
 * at, because a schedule silently read as something else fires at the wrong hour.
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type Schedule =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

const clockTime = (hour: string, minute: string): { hour: number; minute: number } | null => {
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) return null;
  if (!Number.isInteger(parsedMinute) || parsedMinute < 0 || parsedMinute > 59) return null;
  return { hour: parsedHour, minute: parsedMinute };
};

export const parseSchedule = (text: string): Schedule | null => {
  const hourly = /^hourly\s+:(\d{2})$/u.exec(text.trim());
  if (hourly?.[1]) {
    const time = clockTime('0', hourly[1]);
    return time ? { kind: 'hourly', minute: time.minute } : null;
  }
  const daily = /^daily\s+(\d{2}):(\d{2})$/u.exec(text.trim());
  if (daily?.[1] && daily[2]) {
    const time = clockTime(daily[1], daily[2]);
    return time ? { kind: 'daily', ...time } : null;
  }
  const weekly = /^weekly\s+([a-z]{3})\s+(\d{2}):(\d{2})$/u.exec(text.trim());
  if (weekly?.[1] && weekly[2] && weekly[3]) {
    const weekday = WEEKDAYS.indexOf(weekly[1] as (typeof WEEKDAYS)[number]);
    const time = clockTime(weekly[2], weekly[3]);
    return weekday >= 0 && time ? { kind: 'weekly', weekday, ...time } : null;
  }
  return null;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The first instant strictly after `after` that matches the Schedule.
 *
 * `offsetMinutes` is the Account's offset from UTC, so a stated 09:00 is 09:00
 * where the Account is rather than where the Worker happens to run.
 */
export const nextScheduledRun = (input: {
  schedule: string;
  offsetMinutes: number;
  after: Date;
}): string | null => {
  const schedule = parseSchedule(input.schedule);
  if (!schedule) return null;
  const offset = input.offsetMinutes * MINUTE_MS;
  const local = input.after.getTime() + offset;

  if (schedule.kind === 'hourly') {
    const hourStart = Math.floor(local / HOUR_MS) * HOUR_MS;
    let candidate = hourStart + schedule.minute * MINUTE_MS;
    if (candidate <= local) candidate += HOUR_MS;
    return new Date(candidate - offset).toISOString();
  }

  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  const timeOfDay = schedule.hour * HOUR_MS + schedule.minute * MINUTE_MS;

  if (schedule.kind === 'daily') {
    let candidate = dayStart + timeOfDay;
    if (candidate <= local) candidate += DAY_MS;
    return new Date(candidate - offset).toISOString();
  }

  // 1970-01-01 was a Thursday, so day 0 of the local epoch grid is weekday 4.
  const currentWeekday = (Math.floor(local / DAY_MS) + 4) % 7;
  let days = (schedule.weekday - currentWeekday + 7) % 7;
  let candidate = dayStart + days * DAY_MS + timeOfDay;
  if (candidate <= local) {
    days += 7;
    candidate = dayStart + days * DAY_MS + timeOfDay;
  }
  return new Date(candidate - offset).toISOString();
};

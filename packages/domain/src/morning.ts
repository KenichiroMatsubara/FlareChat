/**
 * The Morning (ADR 0176): 05:00 Asia/Tokyo, the one moment each day an
 * Automation Inbox owes an intake and its Account's readers are spoken to.
 *
 * Every Account the product serves keeps Asia/Tokyo time, as every Calendar
 * write already does, and Japan keeps no daylight saving, so the Morning is a
 * fixed offset from UTC rather than a zone lookup.
 */

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** The hour of the Asia/Tokyo day the Morning falls on. */
export const MORNING_HOUR = 5;

/**
 * How long an unfinished intake may hold the Morning Notice back. An Inbox whose
 * grant was revoked must not also withhold the day's reminders.
 */
export const MORNING_NOTICE_GRACE_MS = 2 * 60 * 60 * 1_000;

/** The Asia/Tokyo calendar day an instant falls on, as `YYYY-MM-DD`. */
export const tokyoDay = (instant: number): string => new Date(instant + TOKYO_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Whole Asia/Tokyo calendar days from the day `from` falls on to the day `to`
 * falls on, or NaN when either is not an instant: a deadline the extraction
 * wrote unreadably matches no milestone rather than stopping the Morning.
 */
export const tokyoDaysBetween = (from: number, to: number): number => {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return Math.round((Date.parse(tokyoDay(to)) - Date.parse(tokyoDay(from))) / DAY_MS);
};

/** The latest Morning at or before `at`, as an ISO instant. */
export const latestMorning = (at: string): string => {
  const instant = Date.parse(at);
  const morningOfDay = Date.parse(tokyoDay(instant)) - TOKYO_OFFSET_MS + MORNING_HOUR * 60 * 60 * 1_000;
  return new Date(morningOfDay <= instant ? morningOfDay : morningOfDay - DAY_MS).toISOString();
};

/** Whether an Automation Inbox last completed an intake before this Morning, and so owes one. */
export const intakeOwed = (input: { lastSyncedAt: string | null; morning: string }): boolean =>
  input.lastSyncedAt === null || Date.parse(input.lastSyncedAt) < Date.parse(input.morning);

/** Whether an Account's Morning Notice already went out for this Morning. */
export const morningNoticeSent = (input: { sentFor: string | null; morning: string }): boolean =>
  input.sentFor !== null && Date.parse(input.sentFor) >= Date.parse(input.morning);

/**
 * Whether an Account's Morning Notice is to be sent now: not yet sent for this
 * Morning, and either every intake it owed has finished or the grace has run out.
 */
export const morningNoticeDue = (input: {
  at: string;
  morning: string;
  sentFor: string | null;
  intakeComplete: boolean;
}): boolean => {
  if (morningNoticeSent(input)) return false;
  return input.intakeComplete || Date.parse(input.at) - Date.parse(input.morning) >= MORNING_NOTICE_GRACE_MS;
};

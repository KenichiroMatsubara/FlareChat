import { eq } from 'drizzle-orm';
import { DEFAULT_RESPONSE_WINDOW_DAYS } from '@mail/domain';

import type { EventDetails } from './event-details';
import type { CalendarEventFields, DesiredCalendarFields } from './event-refresh';
import { settings } from './storage/organization-schema';
import type { OrganizationDatabase } from './storage/database';

export const RESPONSE_WINDOW_DAYS_SETTING = 'response_window_days';

/** The Event Response window this Organization configured, falling back to the product default. */
export const organizationResponseWindowDays = async (database: OrganizationDatabase): Promise<number> => {
  const stored = await database.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, RESPONSE_WINDOW_DAYS_SETTING)).get();
  const days = Number(stored?.value);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_RESPONSE_WINDOW_DAYS;
};

export const saveOrganizationResponseWindowDays = async (
  database: OrganizationDatabase,
  days: number,
  updatedAt: string,
): Promise<void> => {
  const value = String(days);
  await database.insert(settings).values({ key: RESPONSE_WINDOW_DAYS_SETTING, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
};

/**
 * The Calendar fields Mail Automation recorded the last time it wrote a
 * Scheduled Event. The difference between these and the event's current Calendar
 * values is the evidence that a human edited it.
 */
export interface RecordedEventFields {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
}

export type MergeableField = keyof RecordedEventFields;

const MERGEABLE_FIELDS: readonly MergeableField[] = ['title', 'description', 'location', 'startsAt', 'endsAt'];

const DAY_MS = 24 * 60 * 60 * 1_000;

const parsed = (value: string): number | null => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

const sameMoment = (left: string, right: string): boolean => {
  const first = parsed(left);
  const second = parsed(right);
  return first === null || second === null ? left.trim() === right.trim() : first === second;
};

const sameValue = (field: MergeableField, left: string, right: string): boolean =>
  field === 'startsAt' || field === 'endsAt' ? sameMoment(left, right) : left.trim() === right.trim();

/**
 * Names the fields a human has taken over. A field whose live Calendar value has
 * drifted from the value Mail Automation last wrote was changed by somebody else,
 * whether in the GUI or directly on the organizer's calendar, and is a Manual
 * Override that no automated merge may overwrite.
 */
export const lockedCalendarFields = (
  current: CalendarEventFields,
  recorded: RecordedEventFields | null,
): MergeableField[] => {
  if (!recorded) return [];
  // Divergence can only be read against a value that was actually recorded. A
  // Scheduled Event written before a field was stored holds nothing to compare,
  // and treating that emptiness as a human edit would freeze the field forever.
  return MERGEABLE_FIELDS.filter((field) => recorded[field].trim() !== ''
    && !sameValue(field, current[field], recorded[field]));
};

/**
 * Merges one Event Candidate into the event that already exists, field by field.
 * A locked field keeps its current Calendar value; every other field takes the
 * newly extracted one. Freezing the whole event on one locked field was rejected:
 * a corrected title would then bury a genuine venue change forever.
 */
export const mergedCalendarFields = (input: {
  current: CalendarEventFields;
  desired: DesiredCalendarFields;
  locked: readonly MergeableField[];
}): DesiredCalendarFields => {
  const locked = new Set(input.locked);
  return {
    title: locked.has('title') ? input.current.title : input.desired.title,
    description: locked.has('description') ? input.current.description : input.desired.description,
    location: locked.has('location') ? input.current.location : input.desired.location,
    startsAt: locked.has('startsAt') ? input.current.startsAt : input.desired.startsAt,
    endsAt: locked.has('endsAt') ? input.current.endsAt : input.desired.endsAt,
    timeZone: input.desired.timeZone,
  };
};

/** Two moments belong to the same meeting for the purpose of locating it from an Event Response. */
export const withinResponseWindow = (
  candidateStartsAt: string,
  eventStartsAt: string,
  windowDays: number = DEFAULT_RESPONSE_WINDOW_DAYS,
): boolean => {
  const candidate = parsed(candidateStartsAt);
  const event = parsed(eventStartsAt);
  if (candidate === null || event === null) return false;
  return Math.abs(candidate - event) <= windowDays * DAY_MS;
};

/** The Calendar search span for locating the Scheduled Event an Event Response answers. */
export const responseSearchWindow = (
  candidates: EventDetails[],
  windowDays: number = DEFAULT_RESPONSE_WINDOW_DAYS,
): { timeMin: string; timeMax: string } | null => {
  const times = candidates.flatMap((candidate) => {
    const time = parsed(candidate.startsAt);
    return time === null ? [] : [time];
  });
  if (!times.length) return null;
  return {
    timeMin: new Date(Math.min(...times) - windowDays * DAY_MS).toISOString(),
    timeMax: new Date(Math.max(...times) + windowDays * DAY_MS).toISOString(),
  };
};

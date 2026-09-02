/**
 * A Scheduled Event as Google Calendar holds it and as FlareChat recorded it:
 * correlating an Event Candidate with the event it already is, merging into it
 * without overwriting a Manual Override, and the revision lock that makes the
 * write safe (ADR 0034, ADR 0056, ADR 0134).
 */
import { now } from './clock';

import { and, eq, inArray } from 'drizzle-orm';

import { aiConnection } from './ai';
import { calendarEventDescription, type AttachmentLink } from './event-description';
import type { EventDetails, MailExtraction } from './event-details';
import {
  attributedMessageId,
  changedCalendarFields,
  refreshSearchWindow,
  sourceMessageAttribution,
  withinRefreshWindow,
  type CalendarEventFields,
  type DesiredCalendarFields,
  type EventCorrespondence,
} from './event-refresh';
import {
  accountResponseWindowDays,
  lockedCalendarFields,
  mergedCalendarFields,
  responseSearchWindow,
  withinResponseWindow,
  type RecordedEventFields,
} from './event-merge';
import { guestCountsLine } from './guests';
import type { CalendarEventResource, GoogleProvider, Providers } from './providers';
import { accountDatabase } from './storage/database';
import { eventAttachments, events, exceptions, guestRegistrations } from './storage/account-schema';
import type { Bindings } from './types';


/** The fields an Event Refresh or a merge reads from a Calendar event, or null when it is not a timed event. */
export const calendarEventFields = (event: CalendarEventResource): CalendarEventFields | null => {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime) return null;
  return {
    id: event.id,
    etag: event.etag ?? null,
    title: event.summary ?? '',
    description: event.description ?? '',
    location: event.location ?? '',
    startsAt: event.start.dateTime,
    endsAt: event.end.dateTime,
    timeZone: event.start.timeZone ?? '',
  };
};

/**
 * Whether an automated write may be applied to a Scheduled Event. Manual
 * Override is a property of individual fields rather than of the whole event, so
 * a human's correction to one field no longer blocks a genuine change to
 * another; this is the last check that no locked field slipped into the write.
 * A write that changes nothing is refused so a no-op cannot reach the calendar.
 */
export const canApplyCalendarUpdate = (input: {
  storedRevision: string | null;
  incomingRevision: string | null;
  changedFields: readonly string[];
  lockedFields: readonly string[];
}): boolean => {
  if (!input.changedFields.length) return false;
  const locked = new Set(input.lockedFields);
  if (input.changedFields.some((field) => locked.has(field))) return false;
  return input.storedRevision === null || input.incomingRevision === null
    || input.storedRevision === input.incomingRevision;
};

/** Records that the Automation Inbox owner deleted a Calendar event; it is never recreated. */
export const recordCalendarDeletion = async (database: D1Database, input: { eventId: string; sourceMessageId: string | null; now: string }): Promise<void> => {
  const db = accountDatabase(database);
  await db.batch([
    db.update(events).set({ status: 'exception', updatedAt: input.now }).where(eq(events.id, input.eventId)),
    db.insert(exceptions).values({
      id: crypto.randomUUID(),
      sourceMessageId: input.sourceMessageId,
      code: 'calendar_event_deleted',
      message: 'The Automation Inbox owner deleted this Calendar event; it was not recreated.',
      state: 'open',
      createdAt: input.now,
    }),
  ]);
};

/** Finds the Scheduled Events this Source Message already produced, by Source Attribution. */
export const attributedScheduledEvents = async (
  google: GoogleProvider,
  accessToken: string,
  messageId: string,
  candidates: EventDetails[],
): Promise<CalendarEventFields[]> => {
  const window = refreshSearchWindow(candidates);
  if (!window) return [];
  const list = await google.calendar.listEvents(accessToken, { ...window, query: messageId, maxResults: 50 });
  return list.flatMap((item) => {
    const fields = calendarEventFields(item);
    return fields && attributedMessageId(fields.description) === messageId ? [fields] : [];
  });
};

/** One Scheduled Event a candidate may be merged into, as Calendar holds it and as D1 recorded it. */
export interface CorrelationTarget {
  rowId: string;
  googleEventId: string;
  current: CalendarEventFields;
  recorded: RecordedEventFields;
  /** The Calendar Revision recorded at the last write, held as the optimistic lock. */
  storedEtag: string | null;
}

/**
 * The Scheduled Events this Account's automation owns inside a time window,
 * each paired with the values FlareChat last wrote. Calendar supplies the
 * window and the live state; D1 supplies what a merge is allowed to overwrite.
 */
const correlationTargets = async (
  google: GoogleProvider,
  accessToken: string,
  database: D1Database,
  window: { timeMin: string; timeMax: string },
): Promise<CorrelationTarget[]> => {
  const list = await google.calendar.listEvents(accessToken, { ...window, maxResults: 250 });
  const attributed = list.flatMap((item) => {
    const fields = calendarEventFields(item);
    return fields && attributedMessageId(fields.description) !== null ? [fields] : [];
  });
  if (!attributed.length) return [];
  const rows = await accountDatabase(database).select({
    id: events.id,
    googleEventId: events.googleEventId,
    title: events.title,
    calendarDescription: events.calendarDescription,
    calendarEtag: events.calendarEtag,
    location: events.location,
    startsAt: events.startsAt,
    endsAt: events.endsAt,
  }).from(events).where(inArray(events.googleEventId, attributed.map((event) => event.id))).all();
  const recorded = new Map(rows.flatMap((row) => row.googleEventId ? [[row.googleEventId, row] as const] : []));
  return attributed.flatMap((current) => {
    const row = recorded.get(current.id);
    return row ? [{
      rowId: row.id,
      googleEventId: current.id,
      current,
      storedEtag: row.calendarEtag,
      recorded: {
        title: row.title,
        description: row.calendarDescription,
        location: row.location,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      },
    }] : [];
  });
};

/** Asks the model which existing Scheduled Event each candidate belongs to. */
export const aiEventCorrespondence = async (input: {
  env: Bindings;
  accountId: string;
  database: D1Database;
  providers: Providers;
  candidates: EventDetails[];
  existing: CalendarEventFields[];
}): Promise<EventCorrespondence[]> => {
  const connection = await aiConnection(input.env, input.accountId, input.database);
  if (!connection) throw new Error('先に OpenAI 互換 API を設定してください。');
  const correspondences = await input.providers.ai.correspond({ ...connection, candidates: input.candidates, existing: input.existing });
  if (!correspondences) throw new Error('AI が既存予定との対応を判定できませんでした。');
  return correspondences;
};

export interface PlannedSchemaCorrelation {
  candidateIndex: number;
  target: CorrelationTarget;
}

/**
 * Freezes every AI correspondence and Calendar revision before a Rule Run may
 * wait for approval. The window is applied after the AI has spoken, so a
 * confident but distant match still cannot carry an existing invitation list
 * onto another meeting.
 */
export const planSchemaCorrelations = async (input: {
  env: Bindings;
  accountId: string;
  database: D1Database;
  providers: Providers;
  accessToken: string;
  extraction: MailExtraction;
}): Promise<PlannedSchemaCorrelation[]> => {
  const candidates = input.extraction.events;
  if (!candidates.length) return [];
  const isResponse = input.extraction.kind === 'response';
  const windowDays = isResponse ? await accountResponseWindowDays(accountDatabase(input.database)) : null;
  const window = isResponse ? responseSearchWindow(candidates, windowDays!) : refreshSearchWindow(candidates);
  if (!window) return [];
  const targets = await correlationTargets(input.providers.google, input.accessToken, input.database, window);
  if (!targets.length) return [];
  const withinWindow = isResponse
    ? (candidateStartsAt: string, eventStartsAt: string) => withinResponseWindow(candidateStartsAt, eventStartsAt, windowDays!)
    : withinRefreshWindow;
  const correspondences = await aiEventCorrespondence({ ...input, candidates, existing: targets.map((target) => target.current) });
  const planned: PlannedSchemaCorrelation[] = [];
  for (const correspondence of correspondences) {
    if (correspondence.eventId === null) continue;
    const target = targets.find((value) => value.googleEventId === correspondence.eventId);
    const candidate = candidates[correspondence.candidateIndex];
    if (!target || !candidate || !withinWindow(candidate.startsAt, target.current.startsAt)) continue;
    if (planned.some((entry) => entry.candidateIndex === correspondence.candidateIndex)) continue;
    planned.push({ candidateIndex: correspondence.candidateIndex, target });
  }
  return planned;
};

/** The Guest Registration line for a Scheduled Event, or undefined when nobody outside has registered. */
const guestCountsFor = async (database: D1Database, eventId: string): Promise<string | undefined> => {
  const rows = await accountDatabase(database).select({
    name: guestRegistrations.name,
    affiliation: guestRegistrations.affiliation,
    attending: guestRegistrations.attending,
  }).from(guestRegistrations).where(eq(guestRegistrations.eventId, eventId)).all();
  return guestCountsLine(rows) ?? undefined;
};

/** The published attachments already linked from a Scheduled Event's description. */
const recordedAttachmentLinks = async (database: D1Database, eventId: string): Promise<AttachmentLink[]> => {
  const rows = await accountDatabase(database).select({
    filename: eventAttachments.filename,
    publicUrl: eventAttachments.publicUrl,
  }).from(eventAttachments).where(eq(eventAttachments.eventId, eventId)).all();
  return rows.flatMap((row) => row.publicUrl ? [{ filename: row.filename, url: row.publicUrl }] : []);
};

/** Keeps the first link for each published URL when a later message republishes a file. */
const distinctAttachmentLinks = (links: AttachmentLink[]): AttachmentLink[] => {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
};

/**
 * Merges one Event Candidate into the Scheduled Event it was correlated with.
 * The Calendar `attachments` list is deliberately left alone: a `PATCH` replaces
 * it wholesale, so writing this message's files would drop the chips an earlier
 * message put there. The description still links every published file.
 */
export const mergeScheduledEvent = async (input: {
  google: GoogleProvider;
  database: D1Database;
  accessToken: string;
  target: CorrelationTarget;
  candidate: EventDetails;
  attachmentLinks: AttachmentLink[];
  gmailMessageId: string;
}): Promise<void> => {
  const guestCounts = await guestCountsFor(input.database, input.target.rowId);
  const description = calendarEventDescription({
    summary: input.candidate.summary,
    ...(guestCounts === undefined ? {} : { guestCounts }),
    attachments: distinctAttachmentLinks([
      ...await recordedAttachmentLinks(input.database, input.target.rowId),
      ...input.attachmentLinks,
    ]),
    attribution: sourceMessageAttribution(input.gmailMessageId),
  });
  const desired: DesiredCalendarFields = {
    title: input.candidate.title,
    description,
    location: input.candidate.location,
    startsAt: input.candidate.startsAt,
    endsAt: input.candidate.endsAt,
    timeZone: input.target.current.timeZone || 'Asia/Tokyo',
  };
  const lockedFields = lockedCalendarFields(input.target.current, input.target.recorded);
  const merged = mergedCalendarFields({ current: input.target.current, desired, locked: lockedFields });
  const changedFields = changedCalendarFields(input.target.current, merged);
  if (!canApplyCalendarUpdate({
    storedRevision: input.target.storedEtag,
    incomingRevision: input.target.current.etag,
    changedFields,
    lockedFields,
  })) return;
  const updated = await input.google.calendar.patchEvent(input.accessToken, input.target.googleEventId, {
    summary: merged.title,
    description: merged.description,
    location: merged.location,
    start: { dateTime: merged.startsAt, timeZone: merged.timeZone },
    end: { dateTime: merged.endsAt, timeZone: merged.timeZone },
  });
  await accountDatabase(input.database).update(events).set({
    title: merged.title,
    startsAt: merged.startsAt,
    endsAt: merged.endsAt,
    location: merged.location,
    description: input.candidate.summary,
    calendarDescription: merged.description,
    calendarEtag: updated.etag ?? null,
    updatedAt: now(),
  }).where(eq(events.id, input.target.rowId)).run();
};

/**
 * Rewrites only the description of the Scheduled Event an Event Response
 * answered, so the Guest Registration counts it just changed are visible. A
 * guest moves neither the meeting nor its deadline, so this is never news to a
 * Contact and never sends an update.
 */
export const rewriteScheduledEventDescription = async (input: {
  google: GoogleProvider;
  database: D1Database;
  accessToken: string;
  target: CorrelationTarget;
  gmailMessageId: string;
}): Promise<void> => {
  const db = accountDatabase(input.database);
  const row = await db.select({ summary: events.description }).from(events)
    .where(eq(events.id, input.target.rowId)).get();
  const guestCounts = await guestCountsFor(input.database, input.target.rowId);
  const description = calendarEventDescription({
    summary: row?.summary ?? '',
    ...(guestCounts === undefined ? {} : { guestCounts }),
    attachments: distinctAttachmentLinks(await recordedAttachmentLinks(input.database, input.target.rowId)),
    // The event keeps naming the message that described it, not the one answering it.
    attribution: sourceMessageAttribution(
      attributedMessageId(input.target.current.description) ?? input.gmailMessageId,
    ),
  });
  const lockedFields = lockedCalendarFields(input.target.current, input.target.recorded);
  const changedFields = description.trim() === input.target.current.description.trim() ? [] : ['description'];
  if (!canApplyCalendarUpdate({
    storedRevision: input.target.storedEtag,
    incomingRevision: input.target.current.etag,
    changedFields,
    lockedFields,
  })) return;
  const updated = await input.google.calendar.patchEvent(input.accessToken, input.target.googleEventId, { description });
  await db.update(events).set({
    calendarDescription: description,
    calendarEtag: updated.etag ?? null,
    updatedAt: now(),
  }).where(eq(events.id, input.target.rowId)).run();
};

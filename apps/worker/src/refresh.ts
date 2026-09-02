/**
 * The Event Refresh exit (ADR 0134): an operator-approved repair that rewrites a
 * Scheduled Event's Calendar fields from a fresh extraction, deliberately
 * overwriting Manual Overrides, and additively invites the active Contact roster.
 * It is kept out of Rule Execution because ordinary runs never overwrite a
 * human's edit.
 */

import { eq } from 'drizzle-orm';
import { validateAttachmentIntake } from '@mail/domain';

import { resolveSourceMessageFolder } from './attachment-folders';
import { receivedAtOf, sourceAttachments, subjectOf } from './source';
import { aiEventCorrespondence, attributedScheduledEvents, calendarEventFields } from './calendar';
import { activeContactInvitees, recordDeliveryAttempt } from './delivery';
import { calendarEventDescription, type AttachmentLink } from './event-description';
import type { EventDetails } from './event-details';
import {
  buildEventCorrespondenceRequest,
  changedCalendarFields,
  invitedAttendees,
  partitionByRefreshWindow,
  refreshPlan,
  sourceMessageAttribution,
  type AiEventCorrespondenceRequest,
  type CalendarEventFields,
  type DesiredCalendarFields,
  type RefreshPlan,
} from './event-refresh';
import type { InboxSession } from './inbox';
import { accountKeyFor } from './keys';
import { GoogleApiError, type GmailMessage, type Providers, type SourceAttachment } from './providers';
import { writeRecoveryReceipt } from './recovery-receipts';
import { accountDatabase } from './storage/database';
import { events, sourceMessages } from './storage/account-schema';
import type { Bindings } from './types';

interface RefreshInput {
  accountId: string;
  database: D1Database;
  session: InboxSession;
  messageId: string;
}

export interface MailboxTestRefreshRequest {
  existing: CalendarEventFields[];
  outOfWindow: CalendarEventFields[];
  request: AiEventCorrespondenceRequest | null;
}

export interface MailboxTestRefreshPlan extends RefreshPlan {
  desired: DesiredCalendarFields[];
  pendingAttachments: string[];
}

export interface EventRefreshEntry {
  googleEventId: string | null;
  etag: string | null;
  candidate: EventDetails;
}

export interface EventRefreshConflict {
  googleEventId: string;
  etag: string | null;
  current: CalendarEventFields;
  changedFields: string[];
  candidate: EventDetails;
}

export interface EventRefreshOutcome {
  updated: string[];
  created: string[];
  conflicts: EventRefreshConflict[];
  failures: Array<{ googleEventId: string | null; title: string; message: string }>;
}

interface RefreshAttachments {
  links: AttachmentLink[];
  calendar: Array<{ fileUrl: string; title: string; mimeType: string }>;
  /** Accepted attachments no previous run left in the folder; published only when applying. */
  pending: string[];
}

const desiredCalendarFields = (candidate: EventDetails, messageId: string, links: AttachmentLink[]): DesiredCalendarFields => ({
  title: candidate.title,
  description: calendarEventDescription({
    summary: candidate.summary,
    attachments: links,
    attribution: sourceMessageAttribution(messageId),
  }),
  location: candidate.location,
  startsAt: candidate.startsAt,
  endsAt: candidate.endsAt,
  timeZone: candidate.timeZone,
});

/**
 * Reuses the Public Attachments a previous run already placed in the Source
 * Message's folder, and publishes only what is missing. Planning never uploads.
 */
const resolveRefreshAttachments = async (
  providers: Providers,
  input: RefreshInput & { message: GmailMessage; publishMissing: boolean },
): Promise<RefreshAttachments> => {
  const { google } = providers;
  const { accessToken } = input.session;
  const attachments = sourceAttachments(input.message.payload);
  const resolved: RefreshAttachments = { links: [], calendar: [], pending: [] };
  if (!attachments.length) return resolved;
  const intake = validateAttachmentIntake(attachments.map((attachment) => attachment.size));
  if (!intake.accepted) throw new Error('Source Message attachments exceed the configured intake limit.');
  const db = accountDatabase(input.database);
  const known = await db.select({ id: sourceMessages.id, driveFolderId: sourceMessages.driveFolderId })
    .from(sourceMessages).where(eq(sourceMessages.gmailMessageId, input.messageId)).get();
  const missing: SourceAttachment[] = [];
  for (const attachment of attachments) {
    const found = known?.driveFolderId
      ? await google.drive.findPublishedAttachment(accessToken, { filename: attachment.filename, folderId: known.driveFolderId })
      : null;
    if (!found) {
      missing.push(attachment);
      continue;
    }
    resolved.links.push({ filename: attachment.filename, url: found.publicUrl });
    resolved.calendar.push({ fileUrl: found.publicUrl, title: attachment.filename, mimeType: attachment.mimeType });
  }
  if (!missing.length) return resolved;
  if (!input.publishMissing) return { ...resolved, pending: missing.map((attachment) => attachment.filename) };
  const contents = await input.session.readAttachments(input.messageId, missing);
  const folderId = await resolveSourceMessageFolder({
    database: db,
    drive: google.drive,
    accessToken,
    subject: subjectOf(input.message.payload),
    receivedAt: receivedAtOf(input.message.internalDate) ?? new Date().toISOString(),
    recordedFolderId: known?.driveFolderId,
    ...(known?.id === undefined ? {} : { sourceMessageId: known.id }),
  });
  for (const attachment of contents) {
    const publication = await google.drive.publishAttachment(accessToken, { attachment, parentFolderId: folderId });
    if (publication.outcome === 'failed' || !publication.publicUrl) {
      throw new Error(`添付ファイル ${attachment.filename} を公開できませんでした。`);
    }
    resolved.links.push({ filename: attachment.filename, url: publication.publicUrl });
    resolved.calendar.push({ fileUrl: publication.publicUrl, title: attachment.filename, mimeType: attachment.mimeType });
  }
  return resolved;
};

/** Prepares the correspondence request for review without calling the AI API. */
export const previewEventRefreshRequest = async (
  providers: Providers,
  input: RefreshInput & { events: EventDetails[] },
): Promise<MailboxTestRefreshRequest> => {
  const found = await attributedScheduledEvents(providers.google, input.session.accessToken, input.messageId, input.events);
  const { inWindow, outOfWindow } = partitionByRefreshWindow(input.events, found);
  return {
    existing: inWindow,
    outOfWindow,
    request: inWindow.length ? buildEventCorrespondenceRequest({ candidates: input.events, existing: inWindow }) : null,
  };
};

/** Asks the AI for a correspondence and turns it into the plan an operator approves. */
export const planEventRefresh = async (
  env: Bindings,
  providers: Providers,
  input: RefreshInput & { events: EventDetails[] },
): Promise<MailboxTestRefreshPlan> => {
  const message = await providers.google.gmail.readMessage(input.session.accessToken, input.messageId);
  const found = await attributedScheduledEvents(providers.google, input.session.accessToken, input.messageId, input.events);
  const { inWindow, outOfWindow } = partitionByRefreshWindow(input.events, found);
  const attachments = await resolveRefreshAttachments(providers, { ...input, message, publishMissing: false });
  const desired = input.events.map((candidate) => desiredCalendarFields(candidate, input.messageId, attachments.links));
  const correspondences = inWindow.length
    ? await aiEventCorrespondence({ env, accountId: input.accountId, database: input.database, providers, candidates: input.events, existing: inWindow })
    : [];
  const plan = refreshPlan({ candidates: input.events, existing: [...inWindow, ...outOfWindow], correspondences, desired });
  return { ...plan, desired, pendingAttachments: attachments.pending };
};

const recordRefreshEffect = async (
  env: Bindings,
  input: { accountId: string; database: D1Database; googleEventId: string; candidate: EventDetails; messageId: string; effect: 'updated' | 'created' },
): Promise<void> => {
  const timestamp = new Date().toISOString();
  if (input.effect === 'updated') {
    await accountDatabase(input.database).update(events).set({
      title: input.candidate.title,
      startsAt: input.candidate.startsAt,
      endsAt: input.candidate.endsAt,
      location: input.candidate.location,
      description: input.candidate.description,
      updatedAt: timestamp,
    }).where(eq(events.googleEventId, input.googleEventId)).run();
  }
  await recordDeliveryAttempt(input.database, {
    destination: 'primary',
    channel: 'calendar',
    outcome: 'succeeded',
    externalId: input.googleEventId,
  });
  await writeRecoveryReceipt({
    bucket: env.RECOVERY_RECEIPTS,
    accountKey: await accountKeyFor(env, input.accountId),
    receipt: {
      accountId: input.accountId,
      idempotencyKey: `event-refresh:${input.googleEventId}:${timestamp}`,
      effectType: 'calendar',
      externalId: input.googleEventId,
      destinationFingerprint: `mail-test:${input.messageId}`,
      succeededAt: timestamp,
    },
  });
};

/**
 * Rewrites every Calendar field of an already confirmed Scheduled Event and
 * additively invites the active Contact roster. A Contact the Calendar already
 * lists keeps whatever they answered; only Contacts missing from that list are
 * appended, and Google mails nobody either way.
 */
export const applyEventRefresh = async (
  env: Bindings,
  providers: Providers,
  input: RefreshInput & { entries: EventRefreshEntry[] },
): Promise<EventRefreshOutcome> => {
  const { google } = providers;
  const { accessToken } = input.session;
  const message = await google.gmail.readMessage(accessToken, input.messageId);
  const attachments = await resolveRefreshAttachments(providers, { ...input, message, publishMissing: true });
  const invitees = await activeContactInvitees(input.database);
  const outcome: EventRefreshOutcome = { updated: [], created: [], conflicts: [], failures: [] };
  for (const entry of input.entries) {
    const desired = desiredCalendarFields(entry.candidate, input.messageId, attachments.links);
    const fields = {
      summary: desired.title,
      description: desired.description,
      location: desired.location,
      start: { dateTime: desired.startsAt, timeZone: desired.timeZone },
      end: { dateTime: desired.endsAt, timeZone: desired.timeZone },
      attachments: attachments.calendar,
    };
    try {
      if (!entry.googleEventId) {
        const created = await google.calendar.createEvent(accessToken, { ...fields, attendees: invitees.map(({ email }) => ({ email })) });
        if (!created.id) throw new Error('Google Calendar が予定 ID を返しませんでした。');
        outcome.created.push(created.id);
        await recordRefreshEffect(env, { ...input, googleEventId: created.id, candidate: entry.candidate, effect: 'created' });
        continue;
      }
      const existing = await google.calendar.readEvent(accessToken, entry.googleEventId);
      const { attendees } = invitedAttendees(existing.attendees ?? [], invitees);
      await google.calendar.patchEvent(accessToken, entry.googleEventId, { ...fields, attendees }, { etag: entry.etag });
      outcome.updated.push(entry.googleEventId);
      await recordRefreshEffect(env, { ...input, googleEventId: entry.googleEventId, candidate: entry.candidate, effect: 'updated' });
    } catch (error) {
      const conflicted = error instanceof GoogleApiError && (error.status === 412 || error.status === 409);
      if (!conflicted || !entry.googleEventId) {
        outcome.failures.push({
          googleEventId: entry.googleEventId,
          title: entry.candidate.title,
          message: error instanceof Error ? error.message : 'Google Calendar の更新に失敗しました。',
        });
        continue;
      }
      const current = calendarEventFields(await google.calendar.readEvent(accessToken, entry.googleEventId));
      if (!current) {
        outcome.failures.push({
          googleEventId: entry.googleEventId,
          title: entry.candidate.title,
          message: '照合後に変更された予定を読み直せませんでした。',
        });
        continue;
      }
      outcome.conflicts.push({
        googleEventId: entry.googleEventId,
        etag: current.etag,
        current,
        changedFields: changedCalendarFields(current, desired),
        candidate: entry.candidate,
      });
    }
  }
  return outcome;
};

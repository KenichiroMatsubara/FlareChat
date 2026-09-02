/**
 * Rule Effects: the planned mutations a Rule Run applies, and the one adapter
 * per Account that applies them (ADR 0134, ADR 0168).
 *
 * Each kind carries exactly the arguments its mutation needs, so a Rule Effect
 * row is one decision rather than a copy of the whole extraction, and the
 * switch that applies them is exhaustive: a kind nobody handles does not
 * compile. Callers of Rule Execution never see this adapter; they hand it a
 * plan and the Account does the rest.
 */

import { and, asc, eq } from 'drizzle-orm';

import { resolveSourceMessageFolder } from './attachment-folders';
import { mergeScheduledEvent, rewriteScheduledEventDescription, type PlannedSchemaCorrelation } from './calendar';
import { channelCredentials, contactChannels, sendOnChannel, sendOnDestination, type ChannelCredentials } from './channel';
import { activeContactInvitees, recordDeliveryAttempt, recordEventInvitations } from './delivery';
import { calendarEventDescription } from './event-description';
import type { EventDetails, GuestDetails, MailExtractionWarning, SourceMessageKind, TaskDetails } from './event-details';
import { sourceMessageAttribution } from './event-refresh';
import { openInbox, type InboxSession } from './inbox';
import { accountKeyFor } from './keys';
import { sourceMessageNotice } from './notice';
import type { Providers, PublishedDriveAttachment, SourceAttachment, SourceAttachmentContent } from './providers';
import { accountDatabase } from './storage/database';
import {
  automationWarnings,
  contactListMembers,
  contacts,
  deliveries,
  eventAttachments,
  events,
  exceptions,
  guestRegistrations,
  sourceMessages,
  tasks,
} from './storage/account-schema';
import { createTaskWorkflow } from './tasks';
import type { Bindings } from './types';

export interface ScheduledEventsArguments {
  accountId: string;
  sourceMessageId: string;
  gmailMessageId: string;
  subject: string;
  receivedAt: string;
  recordedFolderId: string | null;
  ruleId: string;
  kind: SourceMessageKind;
  events: EventDetails[];
  guests: GuestDetails[];
  correlations: PlannedSchemaCorrelation[];
  attachments: SourceAttachment[];
}

export interface SummaryArguments {
  accountId: string;
  sourceMessageId: string;
  subject: string;
  summary: string;
  /** The Scheduled Events the notice states; an Event Response creates none, so it states none. */
  events: EventDetails[];
  noticeContactListId: string | null;
}

export interface AgentScheduledEventArguments {
  destination: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  description?: string;
}

export type RuleEffect =
  | { kind: 'schema.record_warnings'; arguments: { sourceMessageId: string; warnings: MailExtractionWarning[] } }
  | { kind: 'schema.create_tasks'; arguments: { accountId: string; sourceMessageId: string; subject: string; tasks: TaskDetails[] } }
  | { kind: 'schema.apply_events'; arguments: ScheduledEventsArguments }
  | { kind: 'schema.deliver_summary'; arguments: SummaryArguments }
  | { kind: 'agent.send_line_message'; arguments: { destination: string; message: string } }
  | { kind: 'agent.send_email_summary'; arguments: { destination: string; subject: string; body: string } }
  | { kind: 'agent.create_scheduled_event'; arguments: AgentScheduledEventArguments };

export type RuleEffectKind = RuleEffect['kind'];

export const RULE_EFFECT_KINDS: readonly RuleEffectKind[] = [
  'schema.record_warnings',
  'schema.create_tasks',
  'schema.apply_events',
  'schema.deliver_summary',
  'agent.send_line_message',
  'agent.send_email_summary',
  'agent.create_scheduled_event',
];

export const isRuleEffectKind = (value: string): value is RuleEffectKind =>
  (RULE_EFFECT_KINDS as readonly string[]).includes(value);

/** Restores one Rule Effect from the row that froze it; the one place the stored shape is trusted. */
export const decodeRuleEffect = (kind: string, encodedArguments: string): RuleEffect => {
  if (!isRuleEffectKind(kind)) throw new Error(`Unsupported Rule Effect: ${kind}`);
  const parsed = JSON.parse(encodedArguments) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error(`Rule Effect ${kind} has no arguments.`);
  return { kind, arguments: parsed } as RuleEffect;
};

/** What the adapter is told about the run an effect belongs to. */
export interface RuleEffectRun {
  id: string;
  rule: { type: 'schema' | 'agent' | 'chat'; id: string; revision: number };
  sourceMessageId: string | null;
}

export interface RuleEffectAdapter {
  apply(run: RuleEffectRun, effect: RuleEffect): Promise<unknown>;
}

const now = (): string => new Date().toISOString();

/** Stands in for a publication that never ran because no Drive folder was available. */
const unpublishedAttachment: PublishedDriveAttachment = { outcome: 'failed', driveFileId: null, publicUrl: null };

/**
 * Delivers one Source Message-level notice to the Contacts the Rule names.
 *
 * The Rule has exactly one destination setting: the Contacts an operator ticked
 * in the GUI (ADR 0162, ADR 0166). Each Contact is reached once: by email when
 * it holds an address, on its Channel handle when it does not, and not at all
 * when it holds neither.
 */
export const deliverSourceMessageNotice = async (input: {
  env: Bindings;
  database: D1Database;
  accountId: string;
  providers: Providers;
  accessToken: string;
  sourceMessageId: string;
  noticeContactListId: string | null;
  subject: string;
  body: string;
}): Promise<void> => {
  if (!input.noticeContactListId) return;
  const db = accountDatabase(input.database);
  const readers = await db.select({ contactId: contactListMembers.contactId, email: contacts.email })
    .from(contactListMembers)
    .innerJoin(contacts, eq(contacts.id, contactListMembers.contactId))
    .where(eq(contactListMembers.listId, input.noticeContactListId)).all();
  if (!readers.length) return;
  const credentials = await accountChannelCredentials(input.env, input.accountId, input.database);
  for (const reader of new Map(readers.map((reader) => [reader.contactId, reader])).values()) {
    if (reader.email) {
      await sendSourceMessageEmail({ ...input, destination: reader.email });
      continue;
    }
    const channel = (await contactChannels({ database: input.database, contactId: reader.contactId }))[0];
    if (!channel) continue;
    try {
      await sendOnChannel({
        database: input.database,
        credentials,
        contactId: reader.contactId,
        channel,
        texts: [input.body],
        sourceMessageId: input.sourceMessageId,
        fetch: input.providers.fetch,
      });
    } catch {
      // A refusal is already recorded as a failed Delivery Record; the rest of
      // the roster must still hear about the Source Message.
    }
  }
};

/** Sends one notice through the Automation Inbox and records the effect independently of Events. */
const sendSourceMessageEmail = async (input: {
  database: D1Database;
  providers: Providers;
  accessToken: string;
  sourceMessageId: string;
  destination: string;
  subject: string;
  body: string;
}): Promise<void> => {
  let outcome: 'succeeded' | 'failed' = 'failed';
  let externalId: string | null = null;
  try {
    const sent = await input.providers.google.gmail.sendMail(input.accessToken, {
      destination: input.destination, subject: input.subject, body: input.body,
    });
    outcome = 'succeeded';
    externalId = sent.id;
  } catch {
    // The failed intended effect remains visible and independently retryable.
  }
  await recordDeliveryAttempt(input.database, {
    sourceMessageId: input.sourceMessageId,
    destination: input.destination,
    channel: 'email',
    outcome,
    externalId,
  });
};

/**
 * This Account's Channel credentials, or none when they cannot be read. A run
 * that cannot decrypt a Connection records its notices as failed rather than
 * aborting the extraction it already completed.
 */
const accountChannelCredentials = async (env: Bindings, accountId: string, database: D1Database): Promise<ChannelCredentials> => {
  try {
    return await channelCredentials({ database, accountKey: await accountKeyFor(env, accountId), accountId });
  } catch {
    return { line: null, discord: null };
  }
};

const raiseException = async (database: D1Database, sourceMessageId: string, code: string, message: string): Promise<void> => {
  await accountDatabase(database).insert(exceptions).values({
    id: crypto.randomUUID(), sourceMessageId, code, message, state: 'open', createdAt: now(),
  }).run();
};

/** Applies the frozen Event Candidates: publishes attachments, then creates or merges each Scheduled Event. */
const applyScheduledEvents = async (input: {
  env: Bindings;
  database: D1Database;
  providers: Providers;
  session: InboxSession;
  arguments: ScheduledEventsArguments;
}): Promise<void> => {
  const { google } = input.providers;
  const { accessToken } = input.session;
  const args = input.arguments;
  const db = accountDatabase(input.database);
  if (!args.events.length) return;
  const contents: SourceAttachmentContent[] = await input.session.readAttachments(args.gmailMessageId, args.attachments);
  let folderId: string | null = null;
  if (contents.length) {
    try {
      folderId = await resolveSourceMessageFolder({
        database: db, drive: google.drive, accessToken, subject: args.subject,
        receivedAt: args.receivedAt, recordedFolderId: args.recordedFolderId,
        sourceMessageId: args.sourceMessageId,
      });
    } catch (error) {
      await db.insert(automationWarnings).values({
        id: crypto.randomUUID(), sourceMessageId: args.sourceMessageId, code: 'attachment_folder_unavailable',
        message: error instanceof Error ? error.message : 'The Attachment Folder Path could not be created in Drive.',
        createdAt: now(),
      }).run();
    }
  }
  const publications = await Promise.all(contents.map(async (attachment) => ({
    attachment,
    publication: folderId
      ? await google.drive.publishAttachment(accessToken, { attachment, parentFolderId: folderId })
      : unpublishedAttachment,
  })));
  const publicationFailed = publications.some(({ publication }) => publication.outcome === 'failed');
  const attachmentLinks = publications.flatMap(({ attachment, publication }) => publication.publicUrl
    ? [{ filename: attachment.filename, url: publication.publicUrl }] : []);
  const calendarAttachments = publications.flatMap(({ attachment, publication }) => publication.publicUrl ? [{
    fileUrl: publication.publicUrl, title: attachment.filename, mimeType: attachment.mimeType,
  }] : []);
  const recordEventAttachments = async (eventId: string): Promise<void> => {
    for (const { attachment, publication } of publications) {
      await db.insert(eventAttachments).values({
        id: crypto.randomUUID(), eventId, gmailAttachmentId: attachment.attachmentId,
        filename: attachment.filename, mimeType: attachment.mimeType, byteSize: attachment.size,
        driveFileId: publication.driveFileId, publicUrl: publication.publicUrl,
        outcome: publication.outcome, createdAt: now(),
      }).run();
      await db.insert(deliveries).values({
        id: crypto.randomUUID(), eventId, channel: 'drive', destination: attachment.filename,
        outcome: publication.outcome, externalId: publication.driveFileId, createdAt: now(),
      }).run();
    }
  };
  const correlated = new Map(args.correlations.map(({ candidateIndex, target }) => [candidateIndex, target]));
  if (args.kind === 'response') {
    const target = [...correlated.values()][0];
    if (target) {
      await db.delete(guestRegistrations).where(and(
        eq(guestRegistrations.eventId, target.rowId), eq(guestRegistrations.sourceMessageId, args.sourceMessageId),
      )).run();
      if (args.guests.length) {
        await db.insert(guestRegistrations).values(args.guests.map((guest) => ({
          id: crypto.randomUUID(), eventId: target.rowId, sourceMessageId: args.sourceMessageId,
          name: guest.name, affiliation: guest.affiliation, attending: guest.attending, createdAt: now(),
        }))).run();
      }
      await recordEventAttachments(target.rowId);
      await rewriteScheduledEventDescription({ google, database: input.database, accessToken, target, gmailMessageId: args.gmailMessageId });
    }
    if (publicationFailed) await raiseException(input.database, args.sourceMessageId, 'drive_attachment_publish_failed', '一部の添付ファイルを公開できませんでした。');
    return;
  }
  const invitees = await activeContactInvitees(input.database);
  const attendees = publicationFailed ? [] : invitees;
  for (const [index, candidate] of args.events.entries()) {
    const merged = correlated.get(index);
    if (merged) {
      await mergeScheduledEvent({
        google, database: input.database, accessToken, target: merged, candidate, attachmentLinks, gmailMessageId: args.gmailMessageId,
      });
      await recordEventAttachments(merged.rowId);
      continue;
    }
    const description = calendarEventDescription({
      summary: candidate.summary, attachments: attachmentLinks,
      attribution: sourceMessageAttribution(args.gmailMessageId),
    });
    const event = await google.calendar.createEvent(accessToken, {
      summary: candidate.title, description, location: candidate.location,
      start: { dateTime: candidate.startsAt, timeZone: 'Asia/Tokyo' },
      end: { dateTime: candidate.endsAt, timeZone: 'Asia/Tokyo' },
      attachments: calendarAttachments,
      attendees: attendees.map(({ email }) => ({ email })),
    });
    if (!event.id) throw new Error('Google Calendar did not return an event ID.');
    const eventId = crypto.randomUUID();
    const createdAt = now();
    await db.insert(events).values({
      id: eventId, accountId: args.accountId, ruleId: args.ruleId, sourceMessageId: args.sourceMessageId,
      googleEventId: event.id, title: candidate.title, startsAt: candidate.startsAt,
      endsAt: candidate.endsAt, location: candidate.location, description: candidate.summary,
      calendarDescription: description, calendarEtag: event.etag ?? null,
      status: publicationFailed ? 'draft' : 'scheduled', createdAt, updatedAt: createdAt,
    }).run();
    await recordEventInvitations({
      database: input.database, eventId, googleEventId: event.id, invitees,
      outcome: publicationFailed ? 'pending' : 'succeeded',
    });
    await recordEventAttachments(eventId);
  }
  if (publicationFailed) await raiseException(input.database, args.sourceMessageId, 'drive_attachment_publish_failed', '一部の添付ファイルを公開できませんでした。');
};

/** Sends the one notice a Source Message produces, stating the events and the Tasks it actually raised. */
const deliverSummary = async (input: {
  env: Bindings;
  database: D1Database;
  providers: Providers;
  session: InboxSession;
  arguments: SummaryArguments;
}): Promise<void> => {
  const args = input.arguments;
  await deliverSourceMessageNotice({
    env: input.env,
    database: input.database,
    accountId: args.accountId,
    providers: input.providers,
    accessToken: input.session.accessToken,
    sourceMessageId: args.sourceMessageId,
    noticeContactListId: args.noticeContactListId,
    subject: `Message Summary: ${args.subject}`,
    body: sourceMessageNotice({
      summary: args.summary,
      events: args.events,
      // The Tasks are read back rather than restated from the extraction,
      // because the assignee is resolved from the Contacts when they are created.
      tasks: await accountDatabase(input.database).select({
        title: tasks.title, deadline: tasks.deadline, assigneeName: tasks.assigneeName,
      }).from(tasks).where(eq(tasks.sourceMessageId, args.sourceMessageId))
        .orderBy(asc(tasks.deadline), asc(tasks.createdAt)).all(),
    }),
  });
};

/** Creates the Scheduled Event an Agent Rule planned for one permitted recipient, recording the outcome either way. */
const createAgentScheduledEvent = async (input: {
  database: D1Database;
  providers: Providers;
  session: InboxSession;
  accountId: string;
  run: RuleEffectRun;
  arguments: AgentScheduledEventArguments;
}): Promise<unknown> => {
  const args = input.arguments;
  const db = accountDatabase(input.database);
  const eventId = crypto.randomUUID();
  let googleEventId: string | null = null;
  let outcome: 'succeeded' | 'failed' = 'failed';
  try {
    const created = await input.providers.google.calendar.createEvent(input.session.accessToken, {
      summary: args.title,
      description: args.description ?? '',
      location: args.location ?? '',
      start: { dateTime: args.startsAt },
      end: { dateTime: args.endsAt },
      attendees: [{ email: args.destination }],
    });
    if (!created.id) throw new Error('Google Calendar did not return an event ID.');
    googleEventId = created.id;
    outcome = 'succeeded';
  } catch {
    outcome = 'failed';
  }
  await db.insert(events).values({
    id: eventId, accountId: input.accountId, ruleId: null, agentRuleId: input.run.rule.id,
    sourceMessageId: input.run.sourceMessageId, googleEventId, title: args.title,
    startsAt: args.startsAt, endsAt: args.endsAt, location: args.location ?? '',
    description: args.description ?? '', status: outcome === 'succeeded' ? 'scheduled' : 'exception',
    createdAt: now(), updatedAt: now(),
  }).run();
  return recordDeliveryAttempt(input.database, {
    eventId, sourceMessageId: input.run.sourceMessageId, destination: args.destination, channel: 'calendar', outcome, externalId: googleEventId,
  });
};

/**
 * The one adapter that applies this Account's Rule Effects. The Automation Inbox
 * is opened lazily, once, because a run whose effects are all LINE messages
 * never needs Google at all.
 */
export const ruleEffectsFor = (input: {
  env: Bindings;
  database: D1Database;
  accountId: string;
  providers: Providers;
  inbox?: InboxSession;
}): RuleEffectAdapter => {
  let session: Promise<InboxSession> | undefined = input.inbox ? Promise.resolve(input.inbox) : undefined;
  const inbox = (): Promise<InboxSession> => {
    session ??= openInbox({ env: input.env, accountId: input.accountId, database: input.database, google: input.providers.google });
    return session;
  };
  const credentials = (): Promise<ChannelCredentials> => accountChannelCredentials(input.env, input.accountId, input.database);
  return {
    apply: async (run, effect) => {
      switch (effect.kind) {
        case 'schema.record_warnings': {
          if (!effect.arguments.warnings.length) return { applied: true };
          await accountDatabase(input.database).insert(automationWarnings).values(effect.arguments.warnings.map((warning) => ({
            id: crypto.randomUUID(), sourceMessageId: effect.arguments.sourceMessageId, code: warning.code, message: warning.message, createdAt: now(),
          }))).run();
          return { applied: true };
        }
        case 'schema.create_tasks':
          await createTaskWorkflow(accountDatabase(input.database)).createFromSourceMessage({
            accountId: effect.arguments.accountId,
            sourceMessageId: effect.arguments.sourceMessageId,
            sourceMessageSubject: effect.arguments.subject,
            extractedTasks: effect.arguments.tasks,
          });
          return { applied: true };
        case 'schema.apply_events':
          await applyScheduledEvents({ env: input.env, database: input.database, providers: input.providers, session: await inbox(), arguments: effect.arguments });
          return { applied: true };
        case 'schema.deliver_summary':
          await deliverSummary({ env: input.env, database: input.database, providers: input.providers, session: await inbox(), arguments: effect.arguments });
          return { applied: true };
        case 'agent.send_line_message':
          return sendOnDestination({
            database: input.database,
            credentials: await credentials(),
            channel: 'line',
            destination: effect.arguments.destination,
            texts: [effect.arguments.message],
            sourceMessageId: run.sourceMessageId,
            fetch: input.providers.fetch,
          });
        case 'agent.send_email_summary': {
          const { accessToken } = await inbox();
          if (!run.sourceMessageId) throw new Error('An Agent Rule effect needs the Source Message its run read.');
          await sendSourceMessageEmail({
            database: input.database, providers: input.providers, accessToken,
            sourceMessageId: run.sourceMessageId, ...effect.arguments,
          });
          return { applied: true };
        }
        case 'agent.create_scheduled_event':
          return createAgentScheduledEvent({
            database: input.database, providers: input.providers, session: await inbox(),
            accountId: input.accountId, run, arguments: effect.arguments,
          });
      }
    },
  };
};

/** The state a Source Message settles into once its runs and exceptions are known. */
export const settledSourceMessageState = (input: { failed: boolean; openExceptions: number }): 'processed' | 'exception' =>
  input.failed || input.openExceptions > 0 ? 'exception' : 'processed';

/** Marks a Source Message as handled, as an exception when any run failed or raised one. */
export const settleSourceMessage = async (database: D1Database, sourceMessageId: string, failed: boolean): Promise<void> => {
  const db = accountDatabase(database);
  const open = await db.select({ id: exceptions.id }).from(exceptions)
    .where(and(eq(exceptions.sourceMessageId, sourceMessageId), eq(exceptions.state, 'open'))).all();
  await db.update(sourceMessages).set({
    state: settledSourceMessageState({ failed, openExceptions: open.length }),
    processedAt: now(),
  }).where(eq(sourceMessages.id, sourceMessageId)).run();
};

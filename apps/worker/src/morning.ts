/**
 * The Morning Notice (ADR 0176): the one message each address receives a day.
 *
 * Nothing a Source Message causes is said to a reader when it happens. Its
 * Source Message Notice, an Intake Notice, and a LINE message an Agent Rule
 * writes are kept here as Morning Entries, already addressed; at the Morning,
 * once the Account's intake has finished, every address hears all of its
 * entries at once, together with the reminders due that day. An address that
 * would have been spoken to three times in a day is spoken to once, and its
 * LINE quota pays for one message rather than three.
 *
 * Each Morning Entry keeps its own Delivery Record naming the Source Message it
 * came from, so the audit still reads per Source Message although the reader
 * received one message.
 */

import { latestMorning, morningNoticeDue } from '@mail/domain';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';

import { channelCredentials, contactChannels, contactDestination, sendOnDestination, type ChannelCredentials } from './channel';
import { now } from './clock';
import { recordDeliveryAttempt } from './delivery';
import { openInbox } from './inbox';
import { accountKeyFor } from './keys';
import { morningNotice, morningNoticeSubject } from './notice';
import type { Providers } from './providers';
import { dueReminders } from './reminders';
import { accountDatabase } from './storage/database';
import { contactListMembers, contacts, jobs, morningEntries, settings } from './storage/account-schema';
import type { Bindings } from './types';

export type MorningChannel = 'email' | 'line' | 'discord';

/** One thing to be said at the next Morning, addressed as it will be delivered. */
export interface MorningEntryInput {
  channel: MorningChannel;
  destination: string;
  contactId?: string | null;
  sourceMessageId?: string | null;
  /** What the entry is about, such as the subject of its mail; empty when the body says it. */
  heading?: string;
  body: string;
  /** Keeps the entry once however many times it is offered, as a reminder's milestone must be. */
  idempotencyKey?: string | null;
}

/** What one Morning Notice run did. */
export interface MorningNoticeRun {
  /** Whether this was the Account's Morning Notice for the current Morning rather than a retry. */
  morning: boolean;
  addresses: number;
  delivered: number;
  entries: number;
}

/** The settings row naming the Morning an Account's Morning Notice was last sent for. */
export const MORNING_NOTICE_SETTING = 'morning_notice_sent_for';

/** How many times a Morning Entry is attempted before it is recorded as failed. */
export const MORNING_ENTRY_ATTEMPTS = 3;

/** How long a sent or failed Morning Entry is kept; its Delivery Records outlive it. */
const MORNING_ENTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** D1 binds at most 100 parameters to one statement, so a list of ids is sent in slices below that. */
const PARAMETERS_PER_STATEMENT = 90;

const slices = <T>(values: readonly T[]): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += PARAMETERS_PER_STATEMENT) result.push(values.slice(index, index + PARAMETERS_PER_STATEMENT));
  return result;
};

/** The most one text may carry on each Channel. An email is one text of any length. */
const TEXT_LIMITS: Record<MorningChannel, number> = { email: Number.POSITIVE_INFINITY, line: 5_000, discord: 2_000 };

/** The Morning this Account's Morning Notice was last sent for, or null before its first. */
export const morningNoticeSentFor = async (database: D1Database): Promise<string | null> =>
  (await accountDatabase(database).select({ value: settings.value }).from(settings)
    .where(eq(settings.key, MORNING_NOTICE_SETTING)).get())?.value ?? null;

/** Keeps one Morning Entry. One already kept under the same key is left as it was; the answer says whether this one was kept. */
export const keepMorningEntry = async (database: D1Database, entry: MorningEntryInput): Promise<boolean> => {
  const result = await accountDatabase(database).insert(morningEntries).values({
    id: crypto.randomUUID(),
    channel: entry.channel,
    destination: entry.destination,
    contactId: entry.contactId ?? null,
    sourceMessageId: entry.sourceMessageId ?? null,
    heading: entry.heading ?? '',
    body: entry.body,
    idempotencyKey: entry.idempotencyKey ?? null,
    createdAt: now(),
  }).onConflictDoNothing().run();
  return result.meta.changes > 0;
};

/**
 * Keeps one Source Message-level notice for each Contact the Rule names.
 *
 * The Rule has exactly one destination setting: the Contacts an operator ticked
 * in the GUI (ADR 0162, ADR 0166). Each Contact is addressed once: by email when
 * it holds an address, on its first reachable Channel when it does not, and not
 * at all when it holds neither.
 */
export const keepSourceMessageNotice = async (input: {
  database: D1Database;
  sourceMessageId: string;
  noticeContactListId: string | null;
  heading: string;
  body: string;
}): Promise<number> => {
  if (!input.noticeContactListId) return 0;
  const readers = await accountDatabase(input.database).select({ contactId: contactListMembers.contactId, email: contacts.email })
    .from(contactListMembers)
    .innerJoin(contacts, eq(contacts.id, contactListMembers.contactId))
    .where(eq(contactListMembers.listId, input.noticeContactListId)).all();
  let kept = 0;
  for (const reader of new Map(readers.map((reader) => [reader.contactId, reader])).values()) {
    const entry = { contactId: reader.contactId, sourceMessageId: input.sourceMessageId, heading: input.heading, body: input.body };
    if (reader.email) {
      await keepMorningEntry(input.database, { ...entry, channel: 'email', destination: reader.email });
      kept += 1;
      continue;
    }
    const channel = (await contactChannels({ database: input.database, contactId: reader.contactId }))[0];
    const destination = channel ? await contactDestination({ database: input.database, contactId: reader.contactId, channel }) : null;
    if (!channel || !destination) continue;
    await keepMorningEntry(input.database, { ...entry, channel, destination });
    kept += 1;
  }
  return kept;
};

/**
 * Keeps the reminders due today. A reminder the Job path already queued before
 * ADR 0176 carries the same key there, so a milestone it delivered is not
 * delivered again.
 */
const keepDueReminders = async (database: D1Database, at: string): Promise<void> => {
  const due = await dueReminders(database, at);
  const queued = new Set<string>();
  for (const keys of slices(due.map(({ key }) => key))) {
    for (const { key } of await accountDatabase(database).select({ key: jobs.idempotencyKey }).from(jobs).where(inArray(jobs.idempotencyKey, keys)).all()) {
      queued.add(key);
    }
  }
  for (const reminder of due) {
    if (queued.has(reminder.key)) continue;
    await keepMorningEntry(database, {
      channel: 'line',
      destination: reminder.destination,
      contactId: reminder.contactId,
      body: reminder.text,
      idempotencyKey: reminder.key,
    });
  }
};

type StoredEntry = typeof morningEntries.$inferSelect;

/** Carries one address's entries as one Morning Notice and says whether it arrived. */
const speak = async (input: {
  database: D1Database;
  morning: string;
  channel: MorningChannel;
  destination: string;
  entries: readonly StoredEntry[];
  credentials: () => Promise<ChannelCredentials>;
  accessToken: () => Promise<string>;
  providers: Providers;
}): Promise<boolean> => {
  const texts = morningNotice({ morning: input.morning, entries: input.entries, limit: TEXT_LIMITS[input.channel] });
  const records = input.entries.map(({ sourceMessageId }) => ({ sourceMessageId }));
  if (input.channel !== 'email') {
    const outcome = await sendOnDestination({
      database: input.database,
      credentials: await input.credentials(),
      channel: input.channel,
      destination: input.destination,
      texts,
      records,
      fetch: input.providers.fetch,
    });
    return outcome.delivered;
  }
  let externalId: string | null = null;
  let delivered = false;
  try {
    const sent = await input.providers.google.gmail.sendMail(await input.accessToken(), {
      destination: input.destination,
      subject: morningNoticeSubject(input.morning),
      body: texts.join('\n\n'),
    });
    externalId = sent.id;
    delivered = true;
  } catch {
    // Each entry below still records the failed attempt, and the entry is attempted again.
  }
  for (const record of records) {
    await recordDeliveryAttempt(input.database, {
      ...record, destination: input.destination, channel: 'email', outcome: delivered ? 'succeeded' : 'failed', externalId,
    });
  }
  return delivered;
};

/**
 * Sends each address its pending entries as one Morning Notice. On the Morning
 * that is every pending entry; afterwards it is only the entries a failed
 * attempt left behind, so an entry kept at 10:00 still waits for tomorrow.
 */
const sendPending = async (input: {
  env: Bindings;
  database: D1Database;
  accountId: string;
  providers: Providers;
  morning: string;
  retriesOnly: boolean;
}): Promise<Omit<MorningNoticeRun, 'morning'>> => {
  const db = accountDatabase(input.database);
  const pending = await db.select().from(morningEntries).where(and(
    eq(morningEntries.state, 'pending'),
    input.retriesOnly ? gt(morningEntries.attempts, 0) : undefined,
  )).orderBy(asc(morningEntries.createdAt)).all();
  const addresses = new Map<string, StoredEntry[]>();
  for (const entry of pending) {
    const key = `${entry.channel}\n${entry.destination}`;
    addresses.set(key, [...addresses.get(key) ?? [], entry]);
  }
  let credentials: Promise<ChannelCredentials> | undefined;
  let accessToken: Promise<string> | undefined;
  let delivered = 0;
  for (const entries of addresses.values()) {
    const [first] = entries;
    if (!first) continue;
    const arrived = await speak({
      database: input.database,
      morning: input.morning,
      channel: first.channel,
      destination: first.destination,
      entries,
      credentials: () => {
        credentials ??= accountKeyFor(input.env, input.accountId)
          .then((accountKey) => channelCredentials({ database: input.database, accountKey, accountId: input.accountId }))
          .catch(() => ({ line: null, discord: null }));
        return credentials;
      },
      accessToken: () => {
        accessToken ??= openInbox({ env: input.env, accountId: input.accountId, database: input.database, google: input.providers.google })
          .then((session) => session.accessToken);
        return accessToken;
      },
      providers: input.providers,
    });
    if (arrived) delivered += 1;
    // Entries of one address may have been attempted a different number of
    // times, so each counts its own attempts.
    const attempts = sql`${morningEntries.attempts} + 1`;
    for (const ids of slices(entries.map(({ id }) => id))) {
      await db.update(morningEntries).set(arrived
        ? { state: 'sent', attempts, sentAt: now() }
        : { state: sql`case when ${morningEntries.attempts} + 1 >= ${MORNING_ENTRY_ATTEMPTS} then 'failed' else 'pending' end`, attempts })
        .where(inArray(morningEntries.id, ids)).run();
    }
  }
  return { addresses: addresses.size, delivered, entries: pending.length };
};

/**
 * Speaks to this Account's readers if the Morning has come for them, and
 * otherwise retries what an earlier attempt this Morning could not deliver.
 *
 * The Morning Notice waits for the Account's intake so the mail that arrived
 * overnight is in it, but not past the grace, so an Inbox that cannot be read
 * does not also withhold the day's reminders. The Morning is recorded as sent
 * only after its entries are, so an invocation that dies part-way leaves the
 * next tick to finish rather than to skip it.
 */
export const sendMorningNotice = async (input: {
  env: Bindings;
  database: D1Database;
  accountId: string;
  providers: Providers;
  at: string;
  intakeComplete: boolean;
}): Promise<MorningNoticeRun> => {
  const db = accountDatabase(input.database);
  const morning = latestMorning(input.at);
  const due = morningNoticeDue({ at: input.at, morning, sentFor: await morningNoticeSentFor(input.database), intakeComplete: input.intakeComplete });
  if (due) await keepDueReminders(input.database, input.at);
  const run = await sendPending({ ...input, morning, retriesOnly: !due });
  if (!due) return { morning: false, ...run };
  const updatedAt = now();
  await db.insert(settings).values({ key: MORNING_NOTICE_SETTING, value: morning, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value: morning, updatedAt } }).run();
  await db.delete(morningEntries).where(and(
    inArray(morningEntries.state, ['sent', 'failed']),
    lt(morningEntries.createdAt, new Date(Date.parse(input.at) - MORNING_ENTRY_RETENTION_MS).toISOString()),
  )).run();
  return { morning: true, ...run };
};

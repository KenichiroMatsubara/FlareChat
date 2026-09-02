/**
 * A Source Message as Gmail hands it over: its text, its attachments, the
 * Schema Rule that selects it, the bounded extraction it is put through, and
 * the plan that extraction becomes. Everything here reads; nothing writes to a
 * provider, so live Automation, Mailbox Test, and Draft Rule Preview can share
 * it without one of them causing an effect the others would not.
 */

import { asc, eq, inArray } from 'drizzle-orm';

import { aiConnection } from './ai';
import type { ConvertedAttachment } from './attachment-conversion';
import type { PlannedSchemaCorrelation } from './calendar';
import { fromBase64Url } from './encoding';
import type { ContactDescription, MailExtraction } from './event-details';
import type { ExecutionMode, PlannedRuleEffect } from './execution';
import type { GmailPart, Providers, SourceAttachment, SourceAttachmentContent } from './providers';
import { accountDatabase } from './storage/database';
import { contacts, rulePermittedLineLists, rulePermittedRecipientLists, rules as schemaRules } from './storage/account-schema';
import type { Bindings } from './types';

export interface ActiveRule {
  id: string;
  revision: number;
  priority: number;
  executionMode: ExecutionMode;
  selectionPolicy: Record<string, unknown>;
  permittedRecipientListIds?: string[];
  permittedLineListIds?: string[];
  /** The Contact List this Rule's notice reaches, resolved to handles at delivery (ADR 0162). */
  noticeContactListId?: string | null;
}

export interface ActiveAgentRule {
  id: string;
  priority: number;
  promptId: string;
  revision: number;
  selectionPolicy: Record<string, unknown>;
  executionMode: ExecutionMode;
  permittedRecipientListIds: string[];
  permittedLineListIds: string[];
}

export interface RuleSource {
  sender: string;
  subject: string;
  body: string;
  labels?: string[];
}

const mimeTypeOf = (part: GmailPart): string => (part.mimeType ?? '').toLowerCase();

const decodedPartText = (part: GmailPart): string => {
  if (!part.body?.data) return '';
  const text = new TextDecoder().decode(fromBase64Url(part.body.data));
  return mimeTypeOf(part).startsWith('text/html') ? text.replace(/<[^>]*>/gu, ' ') : text;
};

/**
 * Picks one representation of a multipart/alternative body. Both representations
 * carry the same text, so decoding both would send every sentence to the AI twice.
 */
const preferredAlternative = (parts: GmailPart[]): GmailPart[] => {
  const plain = parts.find((part) => mimeTypeOf(part).startsWith('text/plain'));
  if (plain) return [plain];
  const html = parts.find((part) => mimeTypeOf(part).startsWith('text/html'));
  if (html) return [html];
  return parts.slice(-1);
};

const bodyTextParts = (part: GmailPart): string[] => {
  const children = part.parts ?? [];
  const selected = mimeTypeOf(part) === 'multipart/alternative' ? preferredAlternative(children) : children;
  return [decodedPartText(part), ...selected.flatMap(bodyTextParts)];
};

/** Reads the Source Message body once, whichever representations Gmail supplies. */
export const decodedBody = (part: GmailPart | undefined): string => {
  if (!part) return '';
  return bodyTextParts(part).join('\n').replace(/\s+/gu, ' ').trim();
};

/**
 * States when the Source Message arrived, in the time zone this product schedules
 * in, so the AI can resolve a date that omits its year. Gmail reports epoch
 * milliseconds; an absent or unparseable value yields no fact at all rather than a
 * guessed one.
 */
export const receivedAtOf = (internalDate: string | undefined): string | undefined => {
  if (!internalDate || !/^\d+$/u.test(internalDate)) return undefined;
  const received = new Date(Number(internalDate) + 9 * 60 * 60 * 1_000);
  if (!Number.isFinite(received.getTime())) return undefined;
  return `${received.toISOString().slice(0, 19)}+09:00`;
};

/** Returns declared attachment byte sizes, excluding inline message body parts. */
export const sourceAttachmentSizes = (part: GmailPart | undefined): number[] => {
  if (!part) return [];
  const own = (part.filename || part.body?.attachmentId) && Number.isFinite(part.body?.size) ? [part.body?.size ?? 0] : [];
  return [...own, ...(part.parts?.flatMap(sourceAttachmentSizes) ?? [])];
};

/** Lists only Gmail file parts that can be copied safely after intake validation. */
export const sourceAttachments = (part: GmailPart | undefined): SourceAttachment[] => {
  if (!part) return [];
  const own = part.filename && part.body?.attachmentId
    ? [{ attachmentId: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', size: part.body.size ?? 0 }]
    : [];
  return [...own, ...(part.parts?.flatMap(sourceAttachments) ?? [])];
};

export const subjectOf = (part: GmailPart | undefined): string =>
  part?.headers?.find((header) => header.name?.toLowerCase() === 'subject')?.value?.trim() ?? '(件名なし)';

export const senderOf = (part: GmailPart | undefined): string =>
  part?.headers?.find((header) => header.name?.toLowerCase() === 'from')?.value?.trim() ?? '';

export const ruleMatches = (rule: Pick<ActiveRule, 'selectionPolicy'>, source: RuleSource): boolean => {
  const sender = source.sender.trim().toLowerCase();
  const domain = sender.split('@')[1] ?? '';
  const content = `${source.subject}\n${source.body}`.toLowerCase();
  const policy = rule.selectionPolicy;
  const requiredSender = typeof policy.sender === 'string' ? policy.sender.trim().toLowerCase() : '';
  const requiredDomain = typeof policy.domain === 'string' ? policy.domain.trim().toLowerCase() : '';
  const requiredKeyword = typeof policy.keyword === 'string' ? policy.keyword.trim().toLowerCase() : '';
  const requiredLabel = typeof policy.label === 'string' ? policy.label.trim() : '';
  return (!requiredSender || requiredSender === sender)
    && (!requiredDomain || requiredDomain === domain)
    && (!requiredKeyword || content.includes(requiredKeyword))
    && (!requiredLabel || (source.labels ?? []).includes(requiredLabel));
};

/** The highest-priority Active Schema Rule that selects this Source Message, or null. */
export const selectActiveRule = (rules: ActiveRule[], source: RuleSource): ActiveRule | null => {
  const matching = rules.filter((rule) => ruleMatches(rule, source));
  matching.sort((left, right) => right.priority - left.priority);
  return matching[0] ?? null;
};

export const activeSchemaRules = async (database: D1Database): Promise<ActiveRule[]> => {
  const db = accountDatabase(database);
  const rows = await db.select({
    id: schemaRules.id,
    revision: schemaRules.currentRevision,
    priority: schemaRules.priority,
    executionMode: schemaRules.executionMode,
    selectionPolicy: schemaRules.selectionPolicy,
    noticeContactListId: schemaRules.noticeContactListId,
  }).from(schemaRules).where(eq(schemaRules.status, 'active')).orderBy(schemaRules.priority).all();
  const ruleIds = rows.map(({ id }) => id);
  const [recipientReferences, lineReferences] = ruleIds.length ? await Promise.all([
    db.select().from(rulePermittedRecipientLists).where(inArray(rulePermittedRecipientLists.ruleId, ruleIds)).all(),
    db.select().from(rulePermittedLineLists).where(inArray(rulePermittedLineLists.ruleId, ruleIds)).all(),
  ]) : [[], []];
  return rows.flatMap((row) => {
    try {
      return [{
        id: row.id,
        revision: row.revision,
        priority: row.priority,
        executionMode: row.executionMode,
        selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>,
        noticeContactListId: row.noticeContactListId,
        permittedRecipientListIds: recipientReferences.flatMap((reference) => reference.ruleId === row.id ? [reference.listId] : []),
        permittedLineListIds: lineReferences.flatMap((reference) => reference.ruleId === row.id ? [reference.listId] : []),
      }];
    } catch {
      return [];
    }
  });
};

/**
 * The Contacts an extraction may name as a Task's assignee (ADR 0161). Only
 * active ones: naming a Contact the Account has switched off would produce a
 * Task nobody is reminded about.
 */
export const assignableContacts = async (database: D1Database): Promise<ContactDescription[]> =>
  accountDatabase(database).select({
    id: contacts.id,
    name: contacts.name,
    description: contacts.description,
  }).from(contacts).where(eq(contacts.state, 'active')).orderBy(asc(contacts.name)).all();

export type PrimarySchemaPreparation =
  | { kind: 'no_matching_rule' }
  | { kind: 'ai_connection_missing'; rule: ActiveRule }
  | { kind: 'invalid_extraction'; rule: ActiveRule }
  | { kind: 'ready'; rule: ActiveRule; extraction: MailExtraction };

/**
 * Selects the production Primary Rule and performs its bounded extraction.
 * Both unattended processing and Mailbox Test enter through this seam; callers
 * decide only how to report the outcome and whether to execute planned effects.
 */
export const preparePrimarySchema = async (input: {
  env: Bindings;
  accountId: string;
  database: D1Database;
  providers: Providers;
  source: RuleSource;
  extractionSource: string;
  attachments: SourceAttachmentContent[];
  convertedAttachments?: ConvertedAttachment[];
  receivedAt?: string;
  rules?: ActiveRule[];
}): Promise<PrimarySchemaPreparation> => {
  const rule = selectActiveRule(input.rules ?? await activeSchemaRules(input.database), input.source);
  if (!rule) return { kind: 'no_matching_rule' };
  const connection = await aiConnection(input.env, input.accountId, input.database).catch(() => null);
  if (!connection) return { kind: 'ai_connection_missing', rule };
  const roster = await assignableContacts(input.database);
  let extraction: MailExtraction | null;
  try {
    extraction = await input.providers.ai.extract({
      ...connection,
      source: input.extractionSource,
      attachments: input.attachments,
      ...(input.convertedAttachments === undefined ? {} : { convertedAttachments: input.convertedAttachments }),
      ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
      roster,
      markdown: input.env.AI,
    });
  } catch {
    extraction = null;
  }
  if (extraction === null) return { kind: 'invalid_extraction', rule };
  return { kind: 'ready', rule, extraction };
};

/** What a Schema Rule's extraction becomes: one effect per mutation, the notice last because it states the others. */
export const schemaPlan = (input: {
  accountId: string;
  sourceMessageId: string;
  gmailMessageId: string;
  subject: string;
  receivedAt: string;
  recordedFolderId: string | null;
  rule: ActiveRule;
  extraction: MailExtraction;
  correlations: PlannedSchemaCorrelation[];
  attachments: SourceAttachment[];
}): PlannedRuleEffect[] => {
  const { extraction } = input;
  const createsTasks = extraction.tasks.length > 0;
  const appliesEvents = extraction.events.length > 0;
  return [
    ...(extraction.warnings.length ? [{
      key: 'record-warnings', dependsOn: [], kind: 'schema.record_warnings' as const,
      arguments: { sourceMessageId: input.sourceMessageId, warnings: extraction.warnings },
    }] : []),
    ...(createsTasks ? [{
      key: 'create-tasks', dependsOn: [], kind: 'schema.create_tasks' as const,
      arguments: { accountId: input.accountId, sourceMessageId: input.sourceMessageId, subject: input.subject, tasks: extraction.tasks },
    }] : []),
    ...(appliesEvents ? [{
      key: 'apply-events', dependsOn: [], kind: 'schema.apply_events' as const,
      arguments: {
        accountId: input.accountId,
        sourceMessageId: input.sourceMessageId,
        gmailMessageId: input.gmailMessageId,
        subject: input.subject,
        receivedAt: input.receivedAt,
        recordedFolderId: input.recordedFolderId,
        ruleId: input.rule.id,
        kind: extraction.kind,
        events: extraction.events,
        guests: extraction.guests,
        correlations: input.correlations,
        attachments: input.attachments,
      },
    }] : []),
    {
      key: 'deliver-summary',
      dependsOn: [...(appliesEvents ? ['apply-events'] : []), ...(createsTasks ? ['create-tasks'] : [])],
      kind: 'schema.deliver_summary' as const,
      arguments: {
        accountId: input.accountId,
        sourceMessageId: input.sourceMessageId,
        subject: input.subject,
        summary: extraction.summary,
        // An Event Response's extracted events locate the Scheduled Event it
        // answers and create nothing, so only an invitation has events to state.
        events: extraction.kind === 'response' ? [] : extraction.events,
        noticeContactListId: input.rule.noticeContactListId ?? null,
      },
    },
  ];
};


/**
 * The Automation Inbox intake: reads new Source Messages from Gmail, selects
 * the Schema and Agent Rules that want them, extracts and plans, and hands each
 * plan to Rule Execution (ADR 0134, ADR 0168). Applying the plan is not this
 * module's business; reading the world and stating what should happen is.
 */
import { now } from './clock';

import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import { intakeOwed, latestMorning, morningNoticeSent, validateAttachmentIntake } from '@mail/domain';

import { aiConnection } from './ai';
import { AGENT_TRANSCRIPT_RETENTION_DAYS, AgentRunFailure, runAgent, writeAgentRunTranscript } from './agent-runs';
import { convertAttachmentsForEventExtraction, type ConvertedAttachment } from './attachment-conversion';
import { completeBaselineSkippedRepair, ensureBaselineSchemaRule } from './baseline-automation';
import { planSchemaCorrelations } from './calendar';
import { createDatabaseAccess } from './database-access';
import { settleSourceMessage } from './effects';
import { ruleExecutionFor, type PlannedRuleEffect, type RuleExecution } from './execution';
import { AutomationConfigurationError } from './health';
import { enabledAutomationInboxes, openInbox, recordInboxFailure, verifyInboxCredential, type AutomationInbox, type InboxSession } from './inbox';
import { accountKeyFor } from './keys';
import { mailboxTests, ruleRunPreviews } from './mailbox';
import { keepSourceMessageNotice, morningNoticeSentFor, sendMorningNotice } from './morning';
import { productionProviders, type Providers, type SourceAttachmentContent } from './providers';
import {
  activeSchemaRules,
  decodedBody,
  preparePrimarySchema,
  receivedAtOf,
  ruleMatches,
  schemaPlan,
  selectActiveRule,
  senderOf,
  sourceAttachmentSizes,
  sourceAttachments,
  subjectOf,
  type ActiveAgentRule,
  type ActiveRule,
  type RuleSource,
} from './source';
import { decideSourceMessageAdmission } from './source-message-admission';
import { controlDatabase, accountDatabase } from './storage/database';
import { accounts } from './storage/control-schema';
import {
  agentRules,
  agentRulePermittedLineLists,
  agentRulePermittedRecipientLists,
  agentRuns,
  connections,
  events,
  exceptions,
  googleConnections,
  listItems,
  prompts,
  sourceMessages,
} from './storage/account-schema';
import type { Bindings } from './types';

export interface AutomationSummary {
  scanned: number;
  created: number;
  skipped: number;
  exceptions: number;
}

/** What one intake or test holds while it works on an Account: the Inbox it opened and the Rule Execution it plans into. */
export interface AccountRun {
  env: Bindings;
  database: D1Database;
  accountId: string;
  providers: Providers;
  session: InboxSession;
  execution: RuleExecution;
}


const requireActiveAiConnection = async (database: D1Database): Promise<void> => {
  const connection = await accountDatabase(database).select({ id: connections.id }).from(connections)
    .where(and(eq(connections.kind, 'ai'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) throw new AutomationConfigurationError('自動化を実行する前に OpenAI 互換 API を設定してください。');
};

const raiseException = async (database: D1Database, sourceMessageId: string, code: string, message: string): Promise<void> => {
  await accountDatabase(database).insert(exceptions).values({
    id: crypto.randomUUID(), sourceMessageId, code, message, state: 'open', createdAt: now(),
  }).run();
};

/**
 * Runs every Agent Rule that selected the Source Message, one bounded model
 * turn each, and hands Rule Execution the actions the model planned. A failed
 * turn is one Automation Exception and is never retried (ADR 0111); whether it
 * failed is what the Source Message's final state has to say.
 */
const runMatchingAgentRules = async (run: AccountRun, input: {
  sourceMessageId: string;
  sender: string;
  subject: string;
  body: string;
  attachments: ConvertedAttachment[];
  rules: ActiveAgentRule[];
}): Promise<void> => {
  if (!input.rules.length) return;
  const db = accountDatabase(run.database);
  const connection = await aiConnection(run.env, run.accountId, run.database).catch(() => null);
  const accountKey = await accountKeyFor(run.env, run.accountId);
  for (const rule of input.rules) {
    const runId = crypto.randomUUID();
    const startedAt = now();
    const source = { id: input.sourceMessageId, sender: input.sender, subject: input.subject, body: input.body, attachments: input.attachments };
    let runResult: Awaited<ReturnType<typeof runAgent>> | null = null;
    let runError: string | null = null;
    let promptRevision = 0;
    try {
      const prompt = await db.select({ instructions: prompts.instructions, revision: prompts.currentRevision }).from(prompts)
        .where(eq(prompts.id, rule.promptId)).get();
      if (!prompt) throw new Error('Agent Rule Prompt was not found.');
      promptRevision = prompt.revision;
      if (!connection) throw new Error('Agent Rule requires an active AI Connection.');
      const [recipientRows, lineRows] = await Promise.all([
        rule.permittedRecipientListIds.length ? db.select({ destination: listItems.value }).from(listItems).where(and(inArray(listItems.listId, rule.permittedRecipientListIds), eq(listItems.enabled, true))).all() : [],
        rule.permittedLineListIds.length ? db.select({ destination: listItems.value }).from(listItems).where(and(inArray(listItems.listId, rule.permittedLineListIds), eq(listItems.enabled, true))).all() : [],
      ]);
      runResult = await runAgent({
        database: run.database,
        runId,
        agentRuleId: rule.id,
        model: { complete: run.providers.ai.completeAgentTurn },
        connection,
        prompt: prompt.instructions,
        source,
        executionMode: rule.executionMode,
        permittedRecipientDestinations: [...new Set(recipientRows.map(({ destination }) => destination))],
        permittedLineDestinations: [...new Set(lineRows.map(({ destination }) => destination))],
      });
      const planned = runResult.plannedActions;
      await run.execution.start({
        sourceMessageId: input.sourceMessageId,
        intent: { kind: 'live' },
        plan: async () => [{
          rule: { type: 'agent', id: rule.id, revision: rule.revision },
          executionMode: rule.executionMode,
          effects: planned.map((action, index) => agentEffect(action, `${action.tool}:${index}`)),
        }],
      });
    } catch (error) {
      if (error instanceof AgentRunFailure) runResult = error.result;
      runError = error instanceof Error ? error.message : 'Agent Rule run failed.';
    }
    const completedAt = now();
    try {
      const transcriptKey = await writeAgentRunTranscript({
        bucket: run.env.RECOVERY_RECEIPTS,
        accountKey,
        transcript: {
          runId,
          accountId: run.accountId,
          agentRuleId: rule.id,
          agentRuleRevision: rule.revision,
          promptId: rule.promptId,
          promptRevision,
          source,
          messages: runResult?.messages ?? [],
          finalOutput: runResult?.output ?? '',
          error: runError,
        },
      });
      await db.insert(agentRuns).values({
        id: runId,
        agentRuleId: rule.id,
        agentRuleRevision: rule.revision,
        promptId: rule.promptId,
        promptRevision,
        sourceMessageId: input.sourceMessageId,
        model: runResult?.model ?? connection?.model ?? 'unconfigured',
        startedAt,
        completedAt,
        outcome: runError ? 'failed' : 'succeeded',
        toolCallCount: runResult?.toolCallCount ?? 0,
        tokens: runResult?.tokens ?? 0,
        transcriptKey,
        expiresAt: new Date(Date.now() + AGENT_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString(),
      }).run();
    } catch (error) {
      runError = error instanceof Error ? error.message : 'Run Transcript persistence failed.';
    }
    if (runError) await raiseException(run.database, input.sourceMessageId, 'agent_rule_run_failed', runError);
  }
};

/** The typed Rule Effect one planned Agent action becomes. */
const agentEffect = (action: { tool: 'send_line_message' | 'create_scheduled_event' | 'send_email_summary' | 'create_task' | 'update_task'; arguments: Record<string, unknown> }, key: string): PlannedRuleEffect => {
  const args = action.arguments;
  const stringArg = (name: string): string | undefined => typeof args[name] === 'string' ? args[name] as string : undefined;
  switch (action.tool) {
    case 'send_line_message':
      return { key, dependsOn: [], kind: 'agent.send_line_message', arguments: { destination: stringArg('destination') ?? '', message: stringArg('message') ?? '' } };
    case 'send_email_summary':
      return { key, dependsOn: [], kind: 'agent.send_email_summary', arguments: { destination: stringArg('destination') ?? '', subject: stringArg('subject') ?? '', body: stringArg('body') ?? '' } };
    case 'create_scheduled_event':
      return {
        key,
        dependsOn: [],
        kind: 'agent.create_scheduled_event',
        arguments: {
          destination: stringArg('destination') ?? '',
          title: stringArg('title') ?? '',
          startsAt: stringArg('startsAt') ?? '',
          endsAt: stringArg('endsAt') ?? '',
          ...(typeof args.location === 'string' ? { location: args.location } : {}),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
        },
      };
    case 'create_task':
      return {
        key,
        dependsOn: [],
        kind: 'agent.create_task',
        arguments: {
          title: stringArg('title') ?? '',
          deadline: stringArg('deadline') ?? '',
          description: stringArg('description') ?? '',
          ...(args.assigneeContactId === undefined ? {} : { assigneeContactId: args.assigneeContactId as string | null }),
          ...(args.scheduledEventId === undefined ? {} : { scheduledEventId: args.scheduledEventId as string | null }),
        },
      };
    case 'update_task':
      return {
        key,
        dependsOn: [],
        kind: 'agent.update_task',
        arguments: {
          taskId: stringArg('taskId') ?? '',
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          ...(typeof args.deadline === 'string' ? { deadline: args.deadline } : {}),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...(typeof args.completed === 'boolean' ? { completed: args.completed } : {}),
          ...(args.assigneeContactId === undefined ? {} : { assigneeContactId: args.assigneeContactId as string | null }),
          ...(args.scheduledEventId === undefined ? {} : { scheduledEventId: args.scheduledEventId as string | null }),
        },
      };
  }
};

/** Keeps the Intake Notice for the next Morning Notice: the sender and the subject, and nothing the message said. */
const intakeNotice = async (run: AccountRun, input: { sourceMessageId: string; rule: ActiveRule | null; sender: string; subject: string }): Promise<void> => {
  if (!input.rule) return;
  await keepSourceMessageNotice({
    database: run.database,
    sourceMessageId: input.sourceMessageId,
    noticeContactListId: input.rule.noticeContactListId ?? null,
    heading: '取り込めなかったメール',
    body: `差出人: ${input.sender}\n件名: ${input.subject}`,
  });
};

const markSourceMessage = async (database: D1Database, sourceMessageId: string, state: 'skipped' | 'exception'): Promise<void> => {
  await accountDatabase(database).update(sourceMessages).set({ state, processedAt: now() })
    .where(eq(sourceMessages.id, sourceMessageId)).run();
};

/**
 * Takes one Gmail message in: admission, Source Message intake, rule selection,
 * extraction, and the plan. Answers whether it read the message from Gmail, which
 * is what an invocation's intake cap counts; one already taken in costs nothing.
 */
const processAccountMessage = async (
  run: AccountRun,
  gmailHistoryId: string,
  gmailMessageId: string,
  reprocessSkipped = false,
): Promise<boolean> => {
  const db = accountDatabase(run.database);
  const known = await db.select({ id: sourceMessages.id, state: sourceMessages.state, driveFolderId: sourceMessages.driveFolderId }).from(sourceMessages)
    .where(eq(sourceMessages.gmailMessageId, gmailMessageId)).get();
  if (known && !(reprocessSkipped && known.state === 'skipped')) return false;
  const message = await run.providers.google.gmail.readMessage(run.session.accessToken, gmailMessageId);
  // Gmail history reports transport and mailbox traffic alongside Source
  // Messages. Skip it before BYOK AI or other processing without changing the
  // message's labels, inbox membership, or read state in Gmail.
  if (decideSourceMessageAdmission(message).kind === 'ignore') return true;
  const subject = subjectOf(message.payload);
  const sender = senderOf(message.payload);
  const sourceMessageId = known?.id ?? crypto.randomUUID();
  const timestamp = now();
  if (known) {
    await db.update(sourceMessages).set({ gmailHistoryId, sender, subject, processedAt: timestamp, state: 'processing' })
      .where(eq(sourceMessages.id, sourceMessageId)).run();
  } else {
    await db.insert(sourceMessages).values({
      id: sourceMessageId, gmailMessageId, gmailHistoryId, sender, subject,
      receivedAt: timestamp, processedAt: timestamp, state: 'processing',
    }).run();
  }
  const body = decodedBody(message.payload) || (message.snippet ?? '');
  const [activeRules, activeAgentRuleRows] = await Promise.all([
    activeSchemaRules(run.database),
    db.select({ id: agentRules.id, priority: agentRules.priority, promptId: agentRules.promptId, revision: agentRules.currentRevision, selectionPolicy: agentRules.selectionPolicy, executionMode: agentRules.executionMode })
      .from(agentRules).where(eq(agentRules.status, 'active')).orderBy(agentRules.priority).all(),
  ]);
  const activeAgentRuleIds = activeAgentRuleRows.map(({ id }) => id);
  const [agentRecipientLists, agentLineLists] = activeAgentRuleIds.length ? await Promise.all([
    db.select().from(agentRulePermittedRecipientLists).where(inArray(agentRulePermittedRecipientLists.agentRuleId, activeAgentRuleIds)).all(),
    db.select().from(agentRulePermittedLineLists).where(inArray(agentRulePermittedLineLists.agentRuleId, activeAgentRuleIds)).all(),
  ]) : [[], []];
  const source: RuleSource = { sender, subject, body, ...(message.labelIds === undefined ? {} : { labels: message.labelIds }) };
  const rule = selectActiveRule(activeRules, source);
  const matchingAgentRules = activeAgentRuleRows.flatMap((row): ActiveAgentRule[] => {
    try {
      const candidate: ActiveAgentRule = {
        id: row.id, priority: row.priority, promptId: row.promptId, revision: row.revision,
        selectionPolicy: JSON.parse(row.selectionPolicy) as Record<string, unknown>, executionMode: row.executionMode,
        permittedRecipientListIds: agentRecipientLists.flatMap((reference) => reference.agentRuleId === row.id ? [reference.listId] : []),
        permittedLineListIds: agentLineLists.flatMap((reference) => reference.agentRuleId === row.id ? [reference.listId] : []),
      };
      return ruleMatches(candidate, source) ? [candidate] : [];
    } catch {
      return [];
    }
  }).sort((left, right) => right.priority - left.priority);
  if (!rule && !matchingAgentRules.length) {
    await markSourceMessage(run.database, sourceMessageId, 'skipped');
    return true;
  }
  const attachmentIntake = validateAttachmentIntake(sourceAttachmentSizes(message.payload));
  if (!attachmentIntake.accepted) {
    await raiseException(run.database, sourceMessageId, attachmentIntake.reason, 'Source Message attachments exceed the configured intake limit.');
    await intakeNotice(run, { sourceMessageId, rule, sender, subject });
    await markSourceMessage(run.database, sourceMessageId, 'exception');
    return true;
  }
  const attachments = sourceAttachments(message.payload);
  let attachmentContents: SourceAttachmentContent[];
  try {
    attachmentContents = await run.session.readAttachments(gmailMessageId, attachments);
  } catch (error) {
    await raiseException(run.database, sourceMessageId, 'gmail_attachment_download_failed', error instanceof Error ? error.message : 'Gmail attachment download failed.');
    await intakeNotice(run, { sourceMessageId, rule, sender, subject });
    await markSourceMessage(run.database, sourceMessageId, 'exception');
    return true;
  }
  let convertedAttachments: ConvertedAttachment[] | undefined;
  try {
    convertedAttachments = matchingAgentRules.length
      ? await convertAttachmentsForEventExtraction(attachmentContents, run.env.AI)
      : undefined;
  } catch (error) {
    await raiseException(run.database, sourceMessageId, 'source_attachment_conversion_failed', error instanceof Error ? error.message : 'Source Message attachment conversion failed.');
    await markSourceMessage(run.database, sourceMessageId, 'exception');
    return true;
  }
  await runMatchingAgentRules(run, {
    sourceMessageId, sender, subject, body,
    attachments: convertedAttachments ?? [],
    rules: matchingAgentRules,
  });
  if (!rule) {
    await settleSourceMessage(run.database, sourceMessageId, false);
    return true;
  }
  const receivedAt = receivedAtOf(message.internalDate);
  const preparation = await preparePrimarySchema({
    env: run.env,
    accountId: run.accountId,
    database: run.database,
    providers: run.providers,
    source,
    extractionSource: `${subject}\n${body}`,
    attachments: attachmentContents,
    ...(convertedAttachments === undefined ? {} : { convertedAttachments }),
    ...(receivedAt === undefined ? {} : { receivedAt }),
    rules: activeRules,
  });
  if (preparation.kind === 'ai_connection_missing') {
    await raiseException(run.database, sourceMessageId, 'ai_connection_missing', 'An active AI Connection is required to analyze incoming mail.');
    await markSourceMessage(run.database, sourceMessageId, 'exception');
    return true;
  }
  if (preparation.kind === 'invalid_extraction') {
    await raiseException(run.database, sourceMessageId, 'ai_event_details_invalid', 'The AI API could not produce safe Event Details.');
    await markSourceMessage(run.database, sourceMessageId, 'exception');
    return true;
  }
  if (preparation.kind === 'no_matching_rule') {
    await settleSourceMessage(run.database, sourceMessageId, false);
    return true;
  }
  const { extraction } = preparation;
  const correlations = await planSchemaCorrelations({
    env: run.env, accountId: run.accountId, database: run.database, providers: run.providers,
    accessToken: run.session.accessToken, extraction,
  });
  await run.execution.start({
    sourceMessageId,
    intent: { kind: 'live' },
    plan: async () => [{
      rule: { type: 'schema', id: preparation.rule.id, revision: preparation.rule.revision },
      executionMode: preparation.rule.executionMode,
      effects: schemaPlan({
        accountId: run.accountId,
        sourceMessageId,
        gmailMessageId,
        subject,
        receivedAt: receivedAt ?? timestamp,
        recordedFolderId: known?.driveFolderId ?? null,
        rule: preparation.rule,
        extraction,
        correlations,
        attachments,
      }),
    }],
  });
  return true;
};

const isGoogleNotFound = (error: unknown, path: string): boolean =>
  error instanceof Error && error.name === 'GoogleApiError' && (error as { status?: number }).status === 404
  && (error as { url?: string }).url?.includes(path) === true;

/**
 * How many Gmail messages one scheduled invocation reads, shared across every
 * Account (ADR 0176). A day of mail would otherwise be one invocation's worth
 * of D1 queries and subrequests; past the cap the read stops at a history record
 * boundary and the next tick carries on from there.
 */
export const INTAKE_READS_PER_TICK = 20;

/** What an invocation may still read before it leaves the rest to the next tick. */
export interface IntakeBudget {
  remaining: number;
}

/**
 * Reads one Automation Inbox forward from its stored history position.
 *
 * Without a budget it reads everything the history holds, as a run started by
 * hand does. With one, it stops before a read the budget cannot pay for, saves
 * the cursor at the last history record it finished, and reports itself
 * incomplete, so the Inbox still owes its intake and the next tick resumes it.
 * Only a read that reaches the end of the history counts as the intake.
 */
const runAccountInbox = async (
  run: AccountRun,
  reprocessSkipped = false,
  budget?: IntakeBudget,
): Promise<{ reprocessed: number; complete: boolean }> => {
  const { google } = run.providers;
  const { accessToken, inbox } = run.session;
  const db = accountDatabase(run.database);
  const exhausted = (): boolean => budget !== undefined && budget.remaining <= 0;
  const spend = (read: boolean): void => {
    if (budget && read) budget.remaining -= 1;
  };
  let reprocessed = 0;
  if (reprocessSkipped) {
    const skippedMessages = await db.select({
      id: sourceMessages.id,
      gmailMessageId: sourceMessages.gmailMessageId,
      gmailHistoryId: sourceMessages.gmailHistoryId,
    }).from(sourceMessages).where(eq(sourceMessages.state, 'skipped')).all();
    for (const skipped of skippedMessages) {
      if (exhausted()) return { reprocessed, complete: false };
      try {
        spend(await processAccountMessage(run, skipped.gmailHistoryId, skipped.gmailMessageId, true));
      } catch (error) {
        if (!isGoogleNotFound(error, `/messages/${encodeURIComponent(skipped.gmailMessageId)}`)) throw error;
        await db.update(sourceMessages).set({ state: 'processed', processedAt: now() })
          .where(eq(sourceMessages.id, skipped.id)).run();
      }
      reprocessed += 1;
    }
  }
  let pageToken: string | undefined;
  let historyId = inbox.gmailHistoryId;
  let finishedRecord: string | null = null;
  const stopAt = async (): Promise<{ reprocessed: number; complete: boolean }> => {
    // The records up to the last one finished are done; the Inbox still owes
    // its intake, so the next tick reads on from there.
    if (finishedRecord) {
      await db.update(googleConnections).set({ gmailHistoryId: finishedRecord, updatedAt: now() })
        .where(eq(googleConnections.id, inbox.id)).run();
    }
    return { reprocessed, complete: false };
  };
  do {
    let history;
    try {
      history = await google.gmail.listHistory(accessToken, { startHistoryId: inbox.gmailHistoryId, ...(pageToken ? { pageToken } : {}) });
    } catch (error) {
      if (!(error instanceof Error && error.name === 'GoogleApiError' && (error as { status?: number }).status === 404)) throw error;
      // Gmail keeps mailbox history for a limited window and answers 404 once
      // the stored cursor falls outside it. Re-anchoring to the mailbox's
      // current position loses the messages beyond that window, but leaving the
      // cursor in place would fail this run and every later one the same way.
      historyId = await google.gmail.currentHistoryId(accessToken);
      break;
    }
    for (const entry of history.history ?? []) {
      for (const message of entry.messagesAdded ?? []) {
        const messageId = message.message?.id;
        if (!messageId) continue;
        if (exhausted()) return stopAt();
        try {
          spend(await processAccountMessage(run, inbox.gmailHistoryId, messageId));
        } catch (error) {
          if (isGoogleNotFound(error, `/messages/${encodeURIComponent(messageId)}`)) continue;
          throw error;
        }
      }
      if (entry.id) finishedRecord = entry.id;
    }
    historyId = history.historyId ?? historyId;
    pageToken = history.nextPageToken;
  } while (pageToken);
  const syncedAt = now();
  await db.update(googleConnections)
    .set({ gmailHistoryId: historyId, lastSyncedAt: syncedAt, lastError: null, failingSince: null, alertedAt: null, updatedAt: syncedAt })
    .where(eq(googleConnections.id, inbox.id))
    .run();
  return { reprocessed, complete: true };
};

const automationCounts = async (database: D1Database): Promise<{ scanned: number; created: number; skipped: number; exceptions: number }> => {
  const db = accountDatabase(database);
  const [scanned, created, skipped, exceptional] = await Promise.all([
    db.select({ value: count() }).from(sourceMessages).get(),
    db.select({ value: count() }).from(events).where(eq(events.status, 'scheduled')).get(),
    db.select({ value: count() }).from(sourceMessages).where(eq(sourceMessages.state, 'skipped')).get(),
    db.select({ value: count() }).from(sourceMessages).where(eq(sourceMessages.state, 'exception')).get(),
  ]);
  return {
    scanned: scanned?.value ?? 0,
    created: created?.value ?? 0,
    skipped: skipped?.value ?? 0,
    exceptions: exceptional?.value ?? 0,
  };
};

const openAccountRun = async (input: {
  env: Bindings;
  database: D1Database;
  accountId: string;
  providers: Providers;
  inbox?: AutomationInbox;
}): Promise<AccountRun> => {
  const session = await openInbox({ ...input, google: input.providers.google });
  return {
    ...input,
    session,
    execution: ruleExecutionFor({ ...input, inbox: session }),
  };
};

const runAccountAutomation = async (input: {
  env: Bindings;
  accountId: string;
  database: D1Database;
  providers: Providers;
}): Promise<AutomationSummary> => {
  const db = accountDatabase(input.database);
  const inbox = (await enabledAutomationInboxes(input.database))[0];
  if (!inbox) throw new Error('有効な Automation Inbox が見つかりません。');
  await requireActiveAiConnection(input.database);
  const baseline = await ensureBaselineSchemaRule(db, input.accountId);
  const execution = ruleExecutionFor(input);
  await execution.expireApprovals();
  await execution.resumeDue();
  const before = await automationCounts(input.database);
  const run = await runAccountInbox(await openAccountRun({ ...input, inbox }), baseline.repairSkipped);
  await completeBaselineSkippedRepair(db);
  const after = await automationCounts(input.database);
  return {
    scanned: after.scanned - before.scanned + run.reprocessed,
    created: after.created - before.created,
    skipped: Math.max(0, after.skipped - before.skipped),
    exceptions: after.exceptions - before.exceptions,
  };
};

/**
 * The scheduled sweep of every active Account (ADR 0176): take in the mail each
 * Automation Inbox owes this Morning, within the invocation's read budget, then
 * let the Account's Morning Notice go out once its intake has finished.
 *
 * An Inbox that completed an intake since the Morning is not read again until
 * the next one, so a tick in the middle of the day only retries what failed or
 * ran out of budget, and sends nothing new.
 *
 * Rule Run upkeep — expiring approvals and resuming interrupted runs — keeps
 * the same rhythm: it runs while the Account's Morning is unfinished, not on
 * every tick, so resuming a run cannot race a run started by hand any more often
 * than the intake itself does.
 */
const runScheduledAccounts = async (env: Bindings, providers: Providers, at: string): Promise<void> => {
  const morning = latestMorning(at);
  const activeAccounts = await controlDatabase(env.CONTROL_DB).select({
    id: accounts.id,
    bindingName: accounts.bindingName,
    databaseId: accounts.databaseId,
  }).from(accounts).where(and(
    eq(accounts.status, 'active'),
    isNotNull(accounts.databaseId),
  )).orderBy(accounts.updatedAt).all();
  const databases = createDatabaseAccess(env);
  const budget: IntakeBudget = { remaining: INTAKE_READS_PER_TICK };
  for (const account of activeAccounts) {
    // One Account whose database or schema is unreachable must not end the
    // scheduled sweep before the Accounts after it have run.
    try {
      const database = (await databases.open({
        kind: 'organization',
        bindingName: account.bindingName,
        databaseId: account.databaseId,
      })).raw;
      const owed = (await enabledAutomationInboxes(database)).filter((inbox) => intakeOwed({ lastSyncedAt: inbox.lastSyncedAt, morning }));
      if (owed.length || !morningNoticeSent({ sentFor: await morningNoticeSentFor(database), morning })) {
        const execution = ruleExecutionFor({ env, database, accountId: account.id, providers });
        await execution.expireApprovals();
        await execution.resumeDue();
      }
      let intakeComplete = true;
      for (const inbox of owed) {
        if (budget.remaining <= 0) {
          intakeComplete = false;
          continue;
        }
        try {
          await requireActiveAiConnection(database);
          const baseline = await ensureBaselineSchemaRule(accountDatabase(database), account.id);
          const read = await runAccountInbox(await openAccountRun({ env, database, accountId: account.id, providers, inbox }), baseline.repairSkipped, budget);
          if (read.complete) await completeBaselineSkippedRepair(accountDatabase(database));
          else intakeComplete = false;
        } catch (error) {
          intakeComplete = false;
          await recordInboxFailure({ env, accountId: account.id, database, inbox, error, google: providers.google });
        }
      }
      await sendMorningNotice({ env, database, accountId: account.id, providers, at, intakeComplete });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'automation_organization_skipped',
        accountId: account.id,
        message: error instanceof Error ? error.message : 'Account automation could not start.',
      }));
    }
  }
};

/**
 * The Account Automation module's interface. HTTP and scheduled callers know
 * only the use-cases; which providers carry them is decided once, here.
 */
export const createAutomation = (env: Bindings, providers: Providers = productionProviders()) => ({
  runAccount: (input: { accountId: string; database: D1Database }): Promise<AutomationSummary> =>
    runAccountAutomation({ env, providers, ...input }),
  verifyAccountInboxCredential: (input: { accountId: string; database: D1Database }): Promise<void> =>
    verifyInboxCredential({ env, google: providers.google, ...input }),
  runEnabledAccounts: (at: string = now()): Promise<void> => runScheduledAccounts(env, providers, at),
  mailboxTest: mailboxTests(env, providers),
  ruleRuns: ruleRunPreviews(env, providers),
});

export type Automation = ReturnType<typeof createAutomation>;

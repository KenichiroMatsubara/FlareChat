import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const lists = sqliteTable('lists', {
  id: text('id').primaryKey(),
  accountId: text('organization_id').notNull(),
  kind: text('kind', { enum: ['source', 'recipient', 'line'] }).notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('lists_kind_check', sql`${table.kind} in ('source', 'recipient', 'line')`),
  index('lists_kind_idx').on(table.kind),
]);

export const listItems = sqliteTable('list_items', {
  id: text('id').primaryKey(),
  listId: text('list_id').notNull().references(() => lists.id, { onDelete: 'cascade' }),
  value: text('value').notNull(),
  label: text('label').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
}, (table) => [
  uniqueIndex('list_items_list_value_idx').on(table.listId, table.value),
  check('list_items_enabled_check', sql`${table.enabled} in (0, 1)`),
]);

export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  accountId: text('organization_id').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['draft', 'active', 'suspended', 'archived'] }).notNull(),
  executionMode: text('execution_mode', { enum: ['read_only', 'approval', 'unattended'] }).notNull().default('unattended'),
  sourceListId: text('source_list_id').references(() => lists.id),
  selectionPolicy: text('selection_policy').notNull().default('{}'),
  routingPolicy: text('routing_policy').notNull().default('{}'),
  /** The Contact List this Rule's Source Message Notice reaches (ADR 0162). */
  noticeContactListId: text('notice_contact_list_id').references(() => contactLists.id),
  priority: integer('priority').notNull().default(0),
  scheduleMinutes: integer('schedule_minutes').notNull().default(5),
  requireAttendance: integer('require_attendance', { mode: 'boolean' }).notNull().default(false),
  deadlineDaysBefore: integer('deadline_days_before'),
  currentRevision: integer('current_revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('rules_status_check', sql`${table.status} in ('draft', 'active', 'suspended', 'archived')`),
  check('rules_execution_mode_check', sql`${table.executionMode} in ('read_only', 'approval', 'unattended')`),
  check('rules_require_attendance_check', sql`${table.requireAttendance} in (0, 1)`),
  index('rules_status_idx').on(table.status),
]);

export const rulePermittedRecipientLists = sqliteTable('rule_permitted_recipient_lists', {
  ruleId: text('rule_id').notNull().references(() => rules.id, { onDelete: 'cascade' }),
  listId: text('list_id').notNull().references(() => lists.id),
}, (table) => [
  primaryKey({ columns: [table.ruleId, table.listId] }),
]);

export const rulePermittedLineLists = sqliteTable('rule_permitted_line_lists', {
  ruleId: text('rule_id').notNull().references(() => rules.id, { onDelete: 'cascade' }),
  listId: text('list_id').notNull().references(() => lists.id),
}, (table) => [
  primaryKey({ columns: [table.ruleId, table.listId] }),
]);

export const prompts = sqliteTable('prompts', {
  id: text('id').primaryKey(),
  accountId: text('organization_id').notNull(),
  name: text('name').notNull(),
  instructions: text('instructions').notNull(),
  currentRevision: integer('current_revision').notNull().default(1),
  published: integer('published', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('prompts_organization_name_idx').on(table.accountId, table.name),
]);

export const promptRevisions = sqliteTable('prompt_revisions', {
  promptId: text('prompt_id').notNull().references(() => prompts.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  instructions: text('instructions').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.promptId, table.revision] }),
]);

export const agentRules = sqliteTable('agent_rules', {
  id: text('id').primaryKey(),
  accountId: text('organization_id').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['draft', 'active', 'suspended', 'archived'] }).notNull(),
  executionMode: text('execution_mode', { enum: ['read_only', 'approval', 'unattended'] }).notNull().default('unattended'),
  promptId: text('prompt_id').notNull().references(() => prompts.id, { onDelete: 'restrict' }),
  selectionPolicy: text('selection_policy').notNull().default('{}'),
  priority: integer('priority').notNull().default(0),
  currentRevision: integer('current_revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('agent_rules_status_check', sql`${table.status} in ('draft', 'active', 'suspended', 'archived')`),
  check('agent_rules_execution_mode_check', sql`${table.executionMode} in ('read_only', 'approval', 'unattended')`),
  index('agent_rules_status_idx').on(table.status),
]);

export const agentRuleRevisions = sqliteTable('agent_rule_revisions', {
  id: text('id').primaryKey(),
  agentRuleId: text('agent_rule_id').notNull().references(() => agentRules.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  promptId: text('prompt_id').notNull().references(() => prompts.id, { onDelete: 'restrict' }),
  selectionPolicy: text('selection_policy').notNull(),
  executionMode: text('execution_mode', { enum: ['read_only', 'approval', 'unattended'] }).notNull().default('unattended'),
  permittedRecipientListIds: text('permitted_recipient_list_ids').notNull().default('[]'),
  permittedLineListIds: text('permitted_line_list_ids').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('agent_rule_revisions_rule_revision_idx').on(table.agentRuleId, table.revision),
  check('agent_rule_revisions_execution_mode_check', sql`${table.executionMode} in ('read_only', 'approval', 'unattended')`),
]);

export const agentRulePermittedRecipientLists = sqliteTable('agent_rule_permitted_recipient_lists', {
  agentRuleId: text('agent_rule_id').notNull().references(() => agentRules.id, { onDelete: 'cascade' }),
  listId: text('list_id').notNull().references(() => lists.id),
}, (table) => [primaryKey({ columns: [table.agentRuleId, table.listId] })]);

export const agentRulePermittedLineLists = sqliteTable('agent_rule_permitted_line_lists', {
  agentRuleId: text('agent_rule_id').notNull().references(() => agentRules.id, { onDelete: 'cascade' }),
  listId: text('list_id').notNull().references(() => lists.id),
}, (table) => [primaryKey({ columns: [table.agentRuleId, table.listId] })]);

export const ruleRevisions = sqliteTable('rule_revisions', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull().references(() => rules.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  executionMode: text('execution_mode', { enum: ['read_only', 'approval', 'unattended'] }).notNull().default('unattended'),
  selectionPolicy: text('selection_policy').notNull(),
  routingPolicy: text('routing_policy').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('rule_revisions_rule_revision_idx').on(table.ruleId, table.revision),
]);

export const ruleRuns = sqliteTable('rule_runs', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').references(() => rules.id, { onDelete: 'restrict' }),
  agentRuleId: text('agent_rule_id').references(() => agentRules.id, { onDelete: 'restrict' }),
  ruleRevision: integer('rule_revision').notNull(),
  sourceMessageId: text('source_message_id').references(() => sourceMessages.id, { onDelete: 'cascade' }),
  executionMode: text('execution_mode', { enum: ['read_only', 'approval', 'unattended'] }).notNull(),
  intent: text('intent', { enum: ['live', 'draft_preview', 'chat'] }).notNull(),
  status: text('status', { enum: ['planning', 'read_only', 'pending_approval', 'applying', 'completed', 'rejected', 'expired', 'failed'] }).notNull(),
  plannedAt: text('planned_at'),
  expiresAt: text('expires_at'),
  decidedAt: text('decided_at'),
  decidedBy: text('decided_by'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('rule_runs_owner_check', sql`(${table.intent} = 'chat' and ${table.ruleId} is null and ${table.agentRuleId} is null and ${table.sourceMessageId} is null) or (${table.intent} != 'chat' and (${table.ruleId} is null) != (${table.agentRuleId} is null) and ${table.sourceMessageId} is not null)`),
  check('rule_runs_mode_check', sql`${table.executionMode} in ('read_only', 'approval', 'unattended')`),
  check('rule_runs_intent_check', sql`${table.intent} in ('live', 'draft_preview', 'chat')`),
  check('rule_runs_status_check', sql`${table.status} in ('planning', 'read_only', 'pending_approval', 'applying', 'completed', 'rejected', 'expired', 'failed')`),
  index('rule_runs_status_idx').on(table.status, table.updatedAt),
]);

export const ruleEffects = sqliteTable('rule_effects', {
  id: text('id').primaryKey(),
  ruleRunId: text('rule_run_id').notNull().references(() => ruleRuns.id, { onDelete: 'cascade' }),
  effectKey: text('effect_key').notNull(),
  kind: text('kind').notNull(),
  arguments: text('arguments').notNull(),
  dependsOn: text('depends_on').notNull().default('[]'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: text('status', { enum: ['planned', 'pending', 'applying', 'succeeded', 'transient_failed', 'permanent_failed', 'blocked', 'rejected', 'expired'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  result: text('result'),
  error: text('error'),
  nextAttemptAt: text('next_attempt_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('rule_effects_run_key_idx').on(table.ruleRunId, table.effectKey),
  check('rule_effects_status_check', sql`${table.status} in ('planned', 'pending', 'applying', 'succeeded', 'transient_failed', 'permanent_failed', 'blocked', 'rejected', 'expired')`),
  check('rule_effects_attempts_check', sql`${table.attempts} >= 0`),
  index('rule_effects_run_idx').on(table.ruleRunId, table.createdAt),
  index('rule_effects_retry_idx').on(table.status, table.nextAttemptAt),
]);

export const sourceMessages = sqliteTable('source_messages', {
  id: text('id').primaryKey(),
  gmailMessageId: text('gmail_message_id').notNull().unique(),
  gmailHistoryId: text('gmail_history_id').notNull(),
  sender: text('sender').notNull(),
  subject: text('subject').notNull(),
  receivedAt: text('received_at').notNull(),
  processedAt: text('processed_at'),
  driveFolderId: text('drive_folder_id'),
  state: text('state', { enum: ['pending', 'processing', 'processed', 'skipped', 'exception'] }).notNull().default('pending'),
}, (table) => [
  check('source_messages_state_check', sql`${table.state} in ('pending', 'processing', 'processed', 'skipped', 'exception')`),
]);

export const agentRuns = sqliteTable('agent_runs', {
  id: text('id').primaryKey(),
  agentRuleId: text('agent_rule_id').notNull().references(() => agentRules.id, { onDelete: 'restrict' }),
  agentRuleRevision: integer('agent_rule_revision').notNull(),
  promptId: text('prompt_id').notNull().references(() => prompts.id, { onDelete: 'restrict' }),
  promptRevision: integer('prompt_revision').notNull(),
  sourceMessageId: text('source_message_id').notNull().references(() => sourceMessages.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at').notNull(),
  outcome: text('outcome', { enum: ['succeeded', 'failed'] }).notNull(),
  toolCallCount: integer('tool_call_count').notNull(),
  tokens: integer('tokens').notNull(),
  transcriptKey: text('transcript_key').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  check('agent_runs_outcome_check', sql`${table.outcome} in ('succeeded', 'failed')`),
  uniqueIndex('agent_runs_rule_source_idx').on(table.agentRuleId, table.sourceMessageId),
  index('agent_runs_started_idx').on(table.startedAt),
]);

export const proposedActions = sqliteTable('proposed_actions', {
  id: text('id').primaryKey(),
  agentRunId: text('agent_run_id').notNull(),
  agentRuleId: text('agent_rule_id').notNull(),
  tool: text('tool', { enum: ['send_line_message', 'create_scheduled_event', 'send_email_summary'] }).notNull(),
  arguments: text('arguments').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired', 'failed'] }).notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  decidedAt: text('decided_at'),
  decidedBy: text('decided_by'),
}, (table) => [
  check('proposed_actions_tool_check', sql`${table.tool} in ('send_line_message', 'create_scheduled_event', 'send_email_summary')`),
  check('proposed_actions_status_check', sql`${table.status} in ('pending', 'approved', 'rejected', 'expired', 'failed')`),
  index('proposed_actions_run_idx').on(table.agentRunId, table.createdAt),
]);

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  accountId: text('organization_id').notNull(),
  ruleId: text('rule_id').references(() => rules.id),
  agentRuleId: text('agent_rule_id').references(() => agentRules.id),
  sourceMessageId: text('source_message_id').references(() => sourceMessages.id),
  googleEventId: text('google_event_id'),
  title: text('title').notNull(),
  startsAt: text('starts_at').notNull(),
  endsAt: text('ends_at').notNull(),
  location: text('location').notNull().default(''),
  description: text('description').notNull().default(''),
  status: text('status', { enum: ['draft', 'scheduled', 'cancelled', 'exception'] }).notNull(),
  attendanceDeadline: text('attendance_deadline'),
  /** The Calendar Revision last observed for this event, held as an optimistic lock on the next merge. */
  calendarEtag: text('calendar_etag'),
  /**
   * The rendered description FlareChat last wrote to Google Calendar. It
   * differs from `description`, which holds the extracted Event Summary; the
   * difference between this and the live Calendar value is what identifies a
   * Manual Override.
   */
  calendarDescription: text('calendar_description').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('events_status_check', sql`${table.status} in ('draft', 'scheduled', 'cancelled', 'exception')`),
  check('events_owning_rule_check', sql`(${table.ruleId} is null) != (${table.agentRuleId} is null)`),
  index('events_start_idx').on(table.startsAt),
]);

export const eventOverrides = sqliteTable('event_overrides', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  actorIdentityId: text('actor_identity_id').notNull(),
  changesJson: text('changes_json').notNull(),
  reason: text('reason').notNull().default(''),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('event_overrides_event_idx').on(table.eventId, table.createdAt),
]);

/**
 * One declared attendance by somebody who is not a Contact. Keyed by the Event
 * Response that declared it so reprocessing and correction replace a party's
 * rows rather than accumulate beside them.
 */
export const guestRegistrations = sqliteTable('guest_registrations', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  sourceMessageId: text('source_message_id').notNull().references(() => sourceMessages.id),
  name: text('name').notNull(),
  affiliation: text('affiliation').notNull().default(''),
  attending: integer('attending', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('guest_registrations_event_idx').on(table.eventId),
  index('guest_registrations_source_idx').on(table.eventId, table.sourceMessageId),
]);

export const attendance = sqliteTable('attendance', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  contactId: text('member_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['unanswered', 'attending', 'not_attending'] }).notNull().default('unanswered'),
  comment: text('comment').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.contactId] }),
  check('attendance_status_check', sql`${table.status} in ('unanswered', 'attending', 'not_attending')`),
]);

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: text('payload').notNull(),
  state: text('state', { enum: ['pending', 'running', 'succeeded', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: text('available_at').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('jobs_state_check', sql`${table.state} in ('pending', 'running', 'succeeded', 'failed')`),
  index('jobs_due_idx').on(table.state, table.availableAt),
]);

export const exceptions = sqliteTable('exceptions', {
  id: text('id').primaryKey(),
  sourceMessageId: text('source_message_id').references(() => sourceMessages.id),
  code: text('code').notNull(),
  message: text('message').notNull(),
  state: text('state', { enum: ['open', 'resolved', 'retry_requested'] }).notNull().default('open'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
}, (table) => [
  check('exceptions_state_check', sql`${table.state} in ('open', 'resolved', 'retry_requested')`),
  index('exceptions_state_idx').on(table.state),
]);

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['line', 'ai', 'discord'] }).notNull(),
  label: text('label').notNull(),
  credential: text('credential').notNull(),
  status: text('status', { enum: ['active', 'disconnected'] }).notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('connections_kind_check', sql`${table.kind} in ('line', 'ai', 'discord')`),
  check('connections_status_check', sql`${table.status} in ('active', 'disconnected')`),
]);

export const googleConnections = sqliteTable('google_connections', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['automation_inbox'] }).notNull(),
  googleSubject: text('google_subject').notNull().unique(),
  inboxAddress: text('inbox_address').notNull().unique(),
  grantedScopes: text('granted_scopes').notNull(),
  tokenEnvelope: text('token_envelope').notNull(),
  gmailHistoryId: text('gmail_history_id').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  status: text('status', { enum: ['active', 'reauthentication_required', 'disconnected'] }).notNull(),
  lastSyncedAt: text('last_synced_at'),
  lastError: text('last_error'),
  /** Start of the current uninterrupted automation failure, cleared by the next successful run. */
  failingSince: text('failing_since'),
  /** Last moment the Administrators were told that automation stopped working. */
  alertedAt: text('alerted_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('google_connections_kind_check', sql`${table.kind} = 'automation_inbox'`),
  check('google_connections_enabled_check', sql`${table.enabled} in (0, 1)`),
  check('google_connections_status_check', sql`${table.status} in ('active', 'reauthentication_required', 'disconnected')`),
]);

export const deliveries = sqliteTable('deliveries', {
  id: text('id').primaryKey(),
  eventId: text('event_id').references(() => events.id),
  sourceMessageId: text('source_message_id').references(() => sourceMessages.id),
  channel: text('channel').notNull(),
  destination: text('destination').notNull(),
  outcome: text('outcome').notNull(),
  externalId: text('external_id'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('deliveries_source_message_idx').on(table.sourceMessageId, table.createdAt),
]);

export const automationWarnings = sqliteTable('automation_warnings', {
  id: text('id').primaryKey(),
  sourceMessageId: text('source_message_id').notNull().references(() => sourceMessages.id),
  code: text('code').notNull(),
  message: text('message').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('automation_warnings_source_idx').on(table.sourceMessageId, table.createdAt),
]);

/** An Account-defined responsibility used to route extracted Tasks. */
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  accountId: text('organization_id').notNull(),
  sourceMessageId: text('source_message_id').notNull().references(() => sourceMessages.id),
  sourceMessageSubject: text('source_message_subject').notNull(),
  title: text('title').notNull(),
  deadline: text('deadline').notNull(),
  assigneeContactId: text('assignee_member_id').references(() => contacts.id),
  assigneeName: text('assignee_name').notNull().default('未割り当て'),
  description: text('description').notNull(),
  remarks: text('remarks').notNull().default(''),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('tasks_completed_check', sql`${table.completed} in (0, 1)`),
  uniqueIndex('tasks_source_deadline_title_idx').on(table.sourceMessageId, table.deadline, table.title),
  index('tasks_order_idx').on(table.completed, table.deadline),
  index('tasks_assignee_idx').on(table.assigneeContactId),
]);

export const deliveryArchives = sqliteTable('delivery_archives', {
  id: text('id').primaryKey(),
  objectKey: text('object_key').notNull(),
  recordCount: integer('record_count').notNull(),
  archivedBefore: text('archived_before').notNull(),
  createdAt: text('created_at').notNull(),
});

export const contacts = sqliteTable('members', {
  id: text('id').primaryKey(),
  accountId: text('organization_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  state: text('state', { enum: ['active', 'inactive'] }).notNull().default('active'),
  /** What kind of Contact this is, in the Account's own words. */
  description: text('description').notNull().default(''),
  tags: text('tags').notNull().default('[]'),
  googleSubject: text('google_subject'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('members_state_check', sql`${table.state} in ('active', 'inactive')`),
  uniqueIndex('members_email_unique').on(table.email).where(sql`${table.email} <> ''`),
  uniqueIndex('members_google_subject_unique').on(table.googleSubject).where(sql`${table.googleSubject} is not null`),
]);

export const eventRecipients = sqliteTable('event_recipients', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  contactId: text('member_id').notNull().references(() => contacts.id),
  nameSnapshot: text('name_snapshot').notNull(),
  emailSnapshot: text('email_snapshot').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.contactId] }),
]);

export const lineDestinations = sqliteTable('line_destinations', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  destinationId: text('destination_id').notNull(),
  displayName: text('display_name').notNull().default(''),
  kind: text('kind', { enum: ['user', 'group', 'room'] }).notNull(),
  status: text('status', { enum: ['discovered', 'disabled'] }).notNull().default('discovered'),
  source: text('source', { enum: ['webhook', 'manual'] }).notNull().default('webhook'),
  discoveredAt: text('discovered_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('line_destinations_kind_check', sql`${table.kind} in ('user', 'group', 'room')`),
  check('line_destinations_status_check', sql`${table.status} in ('discovered', 'disabled')`),
  uniqueIndex('line_destinations_connection_destination_idx').on(table.connectionId, table.destinationId),
]);

export const contactLinkTokens = sqliteTable('member_link_tokens', {
  token: text('token').primaryKey(),
  contactId: text('member_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
});

/** The single-use link that first brings a Contact into the Contact Portal. */
export const portalInvitations = sqliteTable('portal_invitations', {
  token: text('token').primaryKey(),
  contactId: text('member_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('portal_invitations_member_idx').on(table.contactId, table.usedAt),
]);

export const contactLineDestinations = sqliteTable('member_line_destinations', {
  contactId: text('member_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  lineDestinationId: text('line_destination_id').notNull().references(() => lineDestinations.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.contactId, table.lineDestinationId] }),
  uniqueIndex('member_line_destinations_destination_unique').on(table.lineDestinationId),
]);

export const eventAttachments = sqliteTable('event_attachments', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  gmailAttachmentId: text('gmail_attachment_id').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  driveFileId: text('drive_file_id'),
  publicUrl: text('public_url'),
  outcome: text('outcome', { enum: ['succeeded', 'failed'] }).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  check('event_attachments_outcome_check', sql`${table.outcome} in ('succeeded', 'failed')`),
  uniqueIndex('event_attachments_event_gmail_idx').on(table.eventId, table.gmailAttachmentId),
  index('event_attachments_event_idx').on(table.eventId, table.createdAt),
]);

export type GoogleConnectionRecord = typeof googleConnections.$inferSelect;

/** Remote MCP Servers this Account has connected, with a static bearer token under ADR 0078 envelope encryption. */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  tokenEnvelope: text('token_envelope'),
  revision: text('revision', { enum: ['2026-07-28', '2025-06-18'] }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('mcp_servers_revision_check', sql`${table.revision} is null or ${table.revision} in ('2026-07-28', '2025-06-18')`),
  uniqueIndex('mcp_servers_name_idx').on(table.name),
]);

export const chatConversations = sqliteTable('chat_conversations', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('chat_conversations_recent_idx').on(table.updatedAt),
]);

/** One exchange of Operator Chat, recorded against the Rule Run that carried it (ADR 0146). */
export const chatTurns = sqliteTable('chat_turns', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => chatConversations.id, { onDelete: 'cascade' }),
  ruleRunId: text('rule_run_id').notNull().references(() => ruleRuns.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  request: text('request').notNull(),
  response: text('response'),
  status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('chat_turns_status_check', sql`${table.status} in ('running', 'completed', 'failed')`),
  unique().on(table.conversationId, table.position),
  index('chat_turns_conversation_idx').on(table.conversationId, table.position),
]);

/** A named set of Contacts (ADR 0147). Delivery resolves each Contact's handle from the Channel it sends on. */
export const contactLists = sqliteTable('contact_lists', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('contact_lists_name_idx').on(table.name),
]);

export const contactListMembers = sqliteTable('contact_list_members', {
  listId: text('list_id').notNull().references(() => contactLists.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.listId, table.contactId] }),
]);

/** The credential an outside agent presents, carrying one Tool Grant and one Contact List bound (ADR 0152). */
export const accessTokens = sqliteTable('access_tokens', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  contactListId: text('contact_list_id').notNull().references(() => contactLists.id, { onDelete: 'restrict' }),
  suppressionWindow: text('suppression_window', { enum: ['none', 'hour', 'day', 'week', 'forever'] }).notNull().default('day'),
  callsPerHour: integer('calls_per_hour').notNull().default(60),
  writesPerDay: integer('writes_per_day').notNull().default(100),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('access_tokens_window_check', sql`${table.suppressionWindow} in ('none', 'hour', 'day', 'week', 'forever')`),
  check('access_tokens_calls_check', sql`${table.callsPerHour} > 0`),
  check('access_tokens_writes_check', sql`${table.writesPerDay} > 0`),
  uniqueIndex('access_tokens_hash_idx').on(table.tokenHash),
]);

export const accessTokenTools = sqliteTable('access_token_tools', {
  tokenId: text('token_id').notNull().references(() => accessTokens.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
}, (table) => [
  primaryKey({ columns: [table.tokenId, table.tool] }),
]);

/** One admitted call, kept so a Token's own rate and write limits can be counted (ADR 0152). */
export const accessTokenCalls = sqliteTable('access_token_calls', {
  id: text('id').primaryKey(),
  tokenId: text('token_id').notNull().references(() => accessTokens.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  isWrite: integer('is_write', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (table) => [
  check('access_token_calls_write_check', sql`${table.isWrite} in (0, 1)`),
  index('access_token_calls_window_idx').on(table.tokenId, table.createdAt),
]);

/** One effect already performed, holding its repeat until the declared window passes (ADR 0141). */
export const suppressions = sqliteTable('suppressions', {
  key: text('key').primaryKey(),
  scope: text('scope').notNull(),
  tool: text('tool').notNull(),
  recordedAt: text('recorded_at').notNull(),
  expiresAt: text('expires_at'),
}, (table) => [
  index('suppressions_expiry_idx').on(table.expiresAt),
]);

/** A Trigger with no payload, thinking with a Prompt and acting through its Tool Grant (ADR 0140). */
export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  promptId: text('prompt_id').notNull().references(() => prompts.id, { onDelete: 'restrict' }),
  contactListId: text('contact_list_id').references(() => contactLists.id, { onDelete: 'restrict' }),
  schedule: text('schedule').notNull(),
  offsetMinutes: integer('offset_minutes').notNull().default(0),
  executionMode: text('execution_mode', { enum: ['read_only', 'approval', 'unattended'] }).notNull().default('unattended'),
  suppressionWindow: text('suppression_window', { enum: ['none', 'hour', 'day', 'week', 'forever'] }).notNull().default('day'),
  state: text('state', { enum: ['draft', 'active', 'suspended', 'archived'] }).notNull().default('draft'),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('automations_mode_check', sql`${table.executionMode} in ('read_only', 'approval', 'unattended')`),
  check('automations_state_check', sql`${table.state} in ('draft', 'active', 'suspended', 'archived')`),
  check('automations_window_check', sql`${table.suppressionWindow} in ('none', 'hour', 'day', 'week', 'forever')`),
  check('automations_offset_check', sql`${table.offsetMinutes} between -840 and 840`),
  uniqueIndex('automations_name_idx').on(table.name),
  index('automations_due_idx').on(table.state, table.nextRunAt),
]);

export const automationTools = sqliteTable('automation_tools', {
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
}, (table) => [
  primaryKey({ columns: [table.automationId, table.tool] }),
]);

export const automationRuns = sqliteTable('automation_runs', {
  id: text('id').primaryKey(),
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  ruleRunId: text('rule_run_id').notNull().references(() => ruleRuns.id, { onDelete: 'cascade' }),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
  output: text('output'),
  error: text('error'),
  toolCalls: integer('tool_calls').notNull().default(0),
}, (table) => [
  check('automation_runs_status_check', sql`${table.status} in ('running', 'completed', 'failed')`),
  index('automation_runs_recent_idx').on(table.automationId, table.startedAt),
]);

/**
 * Where a Contact is reachable on a Channel (ADR 0139). Discord lives here now;
 * LINE still lives in its own table until the migration that dissolves it, so
 * each Channel has exactly one source of truth rather than two.
 */
export const channelHandles = sqliteTable('channel_handles', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  channel: text('channel', { enum: ['discord'] }).notNull(),
  connectionId: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  replyTarget: text('reply_target'),
  kind: text('kind', { enum: ['single', 'shared'] }).notNull().default('single'),
  displayName: text('display_name').notNull().default(''),
  source: text('source', { enum: ['inbound', 'manual'] }).notNull().default('inbound'),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('channel_handles_channel_check', sql`${table.channel} in ('discord')`),
  check('channel_handles_kind_check', sql`${table.kind} in ('single', 'shared')`),
  check('channel_handles_source_check', sql`${table.source} in ('inbound', 'manual')`),
  check('channel_handles_primary_check', sql`${table.isPrimary} in (0, 1)`),
  uniqueIndex('channel_handles_identity_idx').on(table.channel, table.connectionId, table.externalId),
  index('channel_handles_contact_idx').on(table.contactId, table.channel),
]);

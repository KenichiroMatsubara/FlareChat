import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const lists = sqliteTable('lists', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
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
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['draft', 'active', 'suspended', 'archived'] }).notNull(),
  sourceListId: text('source_list_id').references(() => lists.id),
  selectionPolicy: text('selection_policy').notNull().default('{}'),
  routingPolicy: text('routing_policy').notNull().default('{}'),
  taskRoleIds: text('task_role_ids').notNull().default('[]'),
  priority: integer('priority').notNull().default(0),
  scheduleMinutes: integer('schedule_minutes').notNull().default(5),
  requireAttendance: integer('require_attendance', { mode: 'boolean' }).notNull().default(false),
  deadlineDaysBefore: integer('deadline_days_before'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('rules_status_check', sql`${table.status} in ('draft', 'active', 'suspended', 'archived')`),
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
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  instructions: text('instructions').notNull(),
  currentRevision: integer('current_revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('prompts_organization_name_idx').on(table.organizationId, table.name),
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
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'suspended', 'archived'] }).notNull(),
  executionMode: text('execution_mode', { enum: ['read_only', 'approval', 'unattended'] }).notNull().default('approval'),
  promptId: text('prompt_id').notNull().references(() => prompts.id, { onDelete: 'restrict' }),
  selectionPolicy: text('selection_policy').notNull().default('{}'),
  priority: integer('priority').notNull().default(0),
  currentRevision: integer('current_revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('agent_rules_status_check', sql`${table.status} in ('active', 'suspended', 'archived')`),
  check('agent_rules_execution_mode_check', sql`${table.executionMode} in ('read_only', 'approval', 'unattended')`),
  index('agent_rules_status_idx').on(table.status),
]);

export const agentRuleRevisions = sqliteTable('agent_rule_revisions', {
  id: text('id').primaryKey(),
  agentRuleId: text('agent_rule_id').notNull().references(() => agentRules.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  promptId: text('prompt_id').notNull().references(() => prompts.id, { onDelete: 'restrict' }),
  selectionPolicy: text('selection_policy').notNull(),
  executionMode: text('execution_mode', { enum: ['read_only', 'approval', 'unattended'] }).notNull().default('read_only'),
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
  selectionPolicy: text('selection_policy').notNull(),
  routingPolicy: text('routing_policy').notNull(),
  taskRoleIds: text('task_role_ids').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('rule_revisions_rule_revision_idx').on(table.ruleId, table.revision),
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
  tool: text('tool', { enum: ['send_line_message', 'create_scheduled_event'] }).notNull(),
  arguments: text('arguments').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired', 'failed'] }).notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  decidedAt: text('decided_at'),
  decidedBy: text('decided_by'),
}, (table) => [
  check('proposed_actions_tool_check', sql`${table.tool} in ('send_line_message', 'create_scheduled_event')`),
  check('proposed_actions_status_check', sql`${table.status} in ('pending', 'approved', 'rejected', 'expired', 'failed')`),
  index('proposed_actions_run_idx').on(table.agentRunId, table.createdAt),
]);

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
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

export const attendance = sqliteTable('attendance', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  recipientItemId: text('recipient_item_id').notNull().references(() => listItems.id),
  status: text('status', { enum: ['unanswered', 'attending', 'not_attending'] }).notNull().default('unanswered'),
  comment: text('comment').notNull().default(''),
  token: text('token').notNull().unique(),
  revokedAt: text('revoked_at'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.recipientItemId] }),
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
  kind: text('kind', { enum: ['line', 'ai'] }).notNull(),
  label: text('label').notNull(),
  credential: text('credential').notNull(),
  status: text('status', { enum: ['active', 'disconnected'] }).notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('connections_kind_check', sql`${table.kind} in ('line', 'ai')`),
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

/** An Organization-defined responsibility used to route extracted Tasks. */
export const operationalTaskRoles = sqliteTable('operational_task_roles', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** An Organization-local projection of the active member assigned an Operational Task Role. */
export const taskRoleAssignments = sqliteTable('task_role_assignments', {
  roleId: text('role_id').primaryKey().references(() => operationalTaskRoles.id, { onDelete: 'cascade' }),
  identityId: text('identity_id').notNull(),
  displayName: text('display_name').notNull(),
  assignedAt: text('assigned_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  sourceMessageId: text('source_message_id').notNull().references(() => sourceMessages.id),
  sourceMessageSubject: text('source_message_subject').notNull(),
  title: text('title').notNull(),
  deadline: text('deadline').notNull(),
  assigneeRoleId: text('assignee_role_id').notNull(),
  assigneeRoleName: text('assignee_role_name').notNull(),
  assigneeIdentityId: text('assignee_identity_id'),
  assigneeName: text('assignee_name').notNull().default('未割り当て'),
  description: text('description').notNull(),
  remarks: text('remarks').notNull().default(''),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('tasks_completed_check', sql`${table.completed} in (0, 1)`),
  uniqueIndex('tasks_source_role_deadline_title_idx').on(table.sourceMessageId, table.assigneeRoleId, table.deadline, table.title),
  index('tasks_order_idx').on(table.completed, table.deadline),
  index('tasks_assignee_idx').on(table.assigneeIdentityId),
]);

export const deliveryArchives = sqliteTable('delivery_archives', {
  id: text('id').primaryKey(),
  objectKey: text('object_key').notNull(),
  recordCount: integer('record_count').notNull(),
  archivedBefore: text('archived_before').notNull(),
  createdAt: text('created_at').notNull(),
});

export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  state: text('state', { enum: ['active', 'inactive'] }).notNull().default('active'),
  tags: text('tags').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('members_state_check', sql`${table.state} in ('active', 'inactive')`),
  uniqueIndex('members_email_unique').on(table.email).where(sql`${table.email} <> ''`),
]);

export const eventRecipients = sqliteTable('event_recipients', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  memberId: text('member_id').notNull().references(() => members.id),
  nameSnapshot: text('name_snapshot').notNull(),
  emailSnapshot: text('email_snapshot').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.memberId] }),
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

export const memberLinkTokens = sqliteTable('member_link_tokens', {
  token: text('token').primaryKey(),
  memberId: text('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
});

export const memberLineDestinations = sqliteTable('member_line_destinations', {
  memberId: text('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  lineDestinationId: text('line_destination_id').notNull().references(() => lineDestinations.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.memberId, table.lineDestinationId] }),
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

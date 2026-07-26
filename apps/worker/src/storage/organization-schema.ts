import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
]);

export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['draft', 'active', 'suspended', 'archived'] }).notNull(),
  sourceListId: text('source_list_id').references(() => lists.id),
  recipientListId: text('recipient_list_id').references(() => lists.id),
  lineListId: text('line_list_id').references(() => lists.id),
  selectionPolicy: text('selection_policy').notNull().default('{}'),
  routingPolicy: text('routing_policy').notNull().default('{}'),
  priority: integer('priority').notNull().default(0),
  scheduleMinutes: integer('schedule_minutes').notNull().default(5),
  requireAttendance: integer('require_attendance', { mode: 'boolean' }).notNull().default(false),
  deadlineDaysBefore: integer('deadline_days_before'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('rules_status_idx').on(table.status),
]);

export const ruleRevisions = sqliteTable('rule_revisions', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').notNull().references(() => rules.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  selectionPolicy: text('selection_policy').notNull(),
  routingPolicy: text('routing_policy').notNull(),
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
  state: text('state', { enum: ['pending', 'processing', 'processed', 'skipped', 'exception'] }).notNull().default('pending'),
});

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  ruleId: text('rule_id').references(() => rules.id),
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
});

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
});

export const deliveries = sqliteTable('deliveries', {
  id: text('id').primaryKey(),
  eventId: text('event_id').references(() => events.id),
  channel: text('channel').notNull(),
  destination: text('destination').notNull(),
  outcome: text('outcome').notNull(),
  externalId: text('external_id'),
  createdAt: text('created_at').notNull(),
});

export const deliveryArchives = sqliteTable('delivery_archives', {
  id: text('id').primaryKey(),
  objectKey: text('object_key').notNull(),
  recordCount: integer('record_count').notNull(),
  archivedBefore: text('archived_before').notNull(),
  createdAt: text('created_at').notNull(),
});

export const recipientProfiles = sqliteTable('recipient_profiles', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  state: text('state', { enum: ['active', 'inactive'] }).notNull().default('active'),
  tags: text('tags').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const eventRecipients = sqliteTable('event_recipients', {
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  recipientProfileId: text('recipient_profile_id').notNull().references(() => recipientProfiles.id),
  nameSnapshot: text('name_snapshot').notNull(),
  emailSnapshot: text('email_snapshot').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.recipientProfileId] }),
]);

export const lineDestinations = sqliteTable('line_destinations', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  destinationId: text('destination_id').notNull(),
  kind: text('kind', { enum: ['user', 'group', 'room'] }).notNull(),
  status: text('status', { enum: ['discovered', 'disabled'] }).notNull().default('discovered'),
  discoveredAt: text('discovered_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('line_destinations_connection_destination_idx').on(table.connectionId, table.destinationId),
]);

export const recipientLinkTokens = sqliteTable('recipient_link_tokens', {
  token: text('token').primaryKey(),
  recipientProfileId: text('recipient_profile_id').notNull().references(() => recipientProfiles.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
});

export const recipientLineDestinations = sqliteTable('recipient_line_destinations', {
  recipientProfileId: text('recipient_profile_id').notNull().references(() => recipientProfiles.id, { onDelete: 'cascade' }),
  lineDestinationId: text('line_destination_id').notNull().references(() => lineDestinations.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.recipientProfileId, table.lineDestinationId] }),
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
  uniqueIndex('event_attachments_event_gmail_idx').on(table.eventId, table.gmailAttachmentId),
  index('event_attachments_event_idx').on(table.eventId, table.createdAt),
]);

export type GoogleConnectionRecord = typeof googleConnections.$inferSelect;

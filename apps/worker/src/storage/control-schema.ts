import { sql } from 'drizzle-orm';
import { check, index, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['provisioning', 'active', 'suspended', 'failed'] }).notNull(),
  databaseId: text('database_id'),
  bindingName: text('binding_name').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('organizations_status_check', sql`${table.status} in ('provisioning', 'active', 'suspended', 'failed')`),
  index('organizations_status_idx').on(table.status),
]);

export const identities = sqliteTable('identities', {
  id: text('id').primaryKey(),
  googleSubject: text('google_subject').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const members = sqliteTable('members', {
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  identityId: text('identity_id').notNull().references(() => identities.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'operator', 'viewer'] }).notNull(),
  state: text('state', { enum: ['pending', 'active', 'suspended', 'removed'] }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.identityId] }),
  check('members_role_check', sql`${table.role} in ('owner', 'admin', 'operator', 'viewer')`),
  check('members_state_check', sql`${table.state} in ('pending', 'active', 'suspended', 'removed')`),
  index('members_identity_idx').on(table.identityId, table.state),
]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  identityId: text('identity_id').notNull().references(() => identities.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  revokedAt: text('revoked_at'),
}, (table) => [
  index('sessions_expiry_idx').on(table.expiresAt, table.revokedAt),
]);

export const organizationSetups = sqliteTable('organization_setups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  inboxAddress: text('inbox_address').notNull().unique(),
  googleSubject: text('google_subject').notNull().unique(),
  grantedScopes: text('granted_scopes').notNull(),
  credentialEnvelope: text('credential_envelope').notNull(),
  historyId: text('history_id').notNull(),
  ownerIdentityId: text('owner_identity_id').notNull().unique().references(() => identities.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('setups_expiry_idx').on(table.expiresAt),
]);

export const organizationProvisionings = sqliteTable('organization_provisionings', {
  organizationId: text('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  ownerIdentityId: text('owner_identity_id').notNull().unique().references(() => identities.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['provisioning', 'failed'] }).notNull(),
  phase: text('phase', {
    enum: ['allocating_database', 'applying_schema', 'storing_credentials', 'verifying_binding', 'activating_organization'],
  }),
  inboxAddress: text('inbox_address').notNull(),
  googleSubject: text('google_subject').notNull(),
  grantedScopes: text('granted_scopes').notNull(),
  credentialEnvelope: text('credential_envelope').notNull(),
  historyId: text('history_id').notNull(),
  databaseId: text('database_id'),
  bindingName: text('binding_name').notNull(),
  provisioningKey: text('provisioning_key').notNull().unique(),
  errorMessage: text('error_message'),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('organization_provisionings_state_check', sql`${table.state} in ('provisioning', 'failed')`),
  check('organization_provisionings_phase_check', sql`${table.phase} is null or ${table.phase} in ('allocating_database', 'applying_schema', 'storing_credentials', 'verifying_binding', 'activating_organization')`),
  index('provisionings_state_expiry_idx').on(table.state, table.expiresAt),
]);

export const automationInboxClaims = sqliteTable('automation_inbox_claims', {
  googleSubject: text('google_subject').primaryKey(),
  inboxAddress: text('inbox_address').notNull().unique(),
  setupId: text('setup_id').unique().references(() => organizationSetups.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').unique().references(() => organizations.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check(
    'automation_inbox_claims_owner_check',
    sql`(${table.setupId} is not null and ${table.organizationId} is null) or (${table.setupId} is null and ${table.organizationId} is not null)`,
  ),
]);

export const organizationKeys = sqliteTable('organization_keys', {
  organizationId: text('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  masterKeyVersion: text('master_key_version').notNull(),
  wrappedKeyEnvelope: text('wrapped_key_envelope').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const oauthFlows = sqliteTable('oauth_flows', {
  id: text('id').primaryKey(),
  intent: text('intent', { enum: ['login', 'organization_setup'] }).notNull(),
  stateHash: text('state_hash').notNull().unique(),
  pkceVerifierEnvelope: text('pkce_verifier_envelope').notNull(),
  returnOrigin: text('return_origin').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  check('oauth_flows_intent_check', sql`${table.intent} in ('login', 'organization_setup')`),
  index('oauth_flows_expiry_idx').on(table.expiresAt),
]);

export const geminiOauthStates = sqliteTable('gemini_oauth_states', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  identityId: text('identity_id').notNull().references(() => identities.id, { onDelete: 'cascade' }),
  stateHash: text('state_hash').notNull().unique(),
  pkceVerifierEnvelope: text('pkce_verifier_envelope').notNull(),
  configurationEnvelope: text('configuration_envelope').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const recoveryRequests = sqliteTable('recovery_requests', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  state: text('state', { enum: ['requested', 'executing', 'completed', 'failed'] }).notNull(),
  requestedByIdentityId: text('requested_by_identity_id').notNull().references(() => identities.id),
  executedByIdentityId: text('executed_by_identity_id').references(() => identities.id),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  executedAt: text('executed_at'),
}, (table) => [
  check('recovery_requests_state_check', sql`${table.state} in ('requested', 'executing', 'completed', 'failed')`),
  uniqueIndex('recovery_requests_organization_idempotency_idx').on(table.organizationId, table.idempotencyKey),
  index('recovery_requests_org_state_idx').on(table.organizationId, table.state, table.createdAt),
]);

export type OrganizationSetupRecord = typeof organizationSetups.$inferSelect;
export type OrganizationProvisioningRecord = typeof organizationProvisionings.$inferSelect;
export type OrganizationRecord = typeof organizations.$inferSelect;
export type SessionRecord = typeof sessions.$inferSelect & Pick<typeof identities.$inferSelect, 'email' | 'displayName'>;

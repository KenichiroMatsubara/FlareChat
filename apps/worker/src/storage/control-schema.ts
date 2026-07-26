import { index, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['provisioning', 'active', 'suspended', 'failed'] }).notNull(),
  databaseId: text('database_id'),
  bindingName: text('binding_name').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('organizations_status_idx').on(table.status),
]);

export const identities = sqliteTable('identities', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
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
  state: text('state', { enum: ['awaiting_google', 'awaiting_name', 'provisioning', 'active', 'expired', 'failed'] }).notNull(),
  oauthStateHash: text('oauth_state_hash').notNull(),
  pkceVerifierEnvelope: text('pkce_verifier_envelope').notNull(),
  inboxAddress: text('inbox_address').unique(),
  googleSubject: text('google_subject'),
  grantedScopes: text('granted_scopes'),
  credentialEnvelope: text('credential_envelope'),
  historyId: text('history_id'),
  ownerIdentityId: text('owner_identity_id').references(() => identities.id),
  organizationId: text('organization_id').unique().references(() => organizations.id),
  databaseId: text('database_id'),
  bindingName: text('binding_name'),
  provisioningKey: text('provisioning_key'),
  provisioningPhase: text('provisioning_phase', {
    enum: ['allocating_database', 'applying_schema', 'storing_credentials', 'verifying_binding', 'activating_organization'],
  }),
  errorMessage: text('error_message'),
  expiresAt: text('expires_at').notNull(),
  provisioningExpiresAt: text('provisioning_expires_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('setups_state_expiry_idx').on(table.state, table.expiresAt),
]);

export const organizationKeys = sqliteTable('organization_keys', {
  organizationId: text('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  masterKeyVersion: text('master_key_version').notNull(),
  wrappedKeyEnvelope: text('wrapped_key_envelope').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const googleLoginStates = sqliteTable('google_login_states', {
  id: text('id').primaryKey(),
  stateHash: text('state_hash').notNull().unique(),
  pkceVerifierEnvelope: text('pkce_verifier_envelope').notNull(),
  returnOrigin: text('return_origin').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('google_login_states_expiry_idx').on(table.expiresAt),
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
  uniqueIndex('recovery_requests_organization_idempotency_idx').on(table.organizationId, table.idempotencyKey),
  index('recovery_requests_org_state_idx').on(table.organizationId, table.state, table.createdAt),
]);

export type OrganizationSetupRecord = typeof organizationSetups.$inferSelect;
export type OrganizationRecord = typeof organizations.$inferSelect;
export type SessionRecord = typeof sessions.$inferSelect & Pick<typeof identities.$inferSelect, 'email' | 'displayName'>;

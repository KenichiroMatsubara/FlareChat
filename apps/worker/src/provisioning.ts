import { attachD1Binding, createD1Database, executeD1, verifyD1Schema } from './cloudflare';
import { createOrganizationKey, decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import type { Bindings, SetupRow } from './types';

const organizationSchema = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS list_items (id TEXT PRIMARY KEY, list_id TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(list_id, value));
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, source_list_id TEXT, recipient_list_id TEXT, line_list_id TEXT, selection_policy TEXT NOT NULL DEFAULT '{}', routing_policy TEXT NOT NULL DEFAULT '{}', priority INTEGER NOT NULL DEFAULT 0, schedule_minutes INTEGER NOT NULL DEFAULT 5, require_attendance INTEGER NOT NULL DEFAULT 0, deadline_days_before INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rule_revisions (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, revision INTEGER NOT NULL, selection_policy TEXT NOT NULL, routing_policy TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(rule_id, revision));
CREATE TABLE IF NOT EXISTS source_messages (id TEXT PRIMARY KEY, gmail_message_id TEXT NOT NULL UNIQUE, gmail_history_id TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT, state TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, rule_id TEXT, source_message_id TEXT, google_event_id TEXT, title TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, attendance_deadline TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event_overrides (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, actor_identity_id TEXT NOT NULL, changes_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attendance (event_id TEXT NOT NULL, recipient_item_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unanswered', comment TEXT NOT NULL DEFAULT '', token TEXT NOT NULL UNIQUE, revoked_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(event_id, recipient_item_id));
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exceptions (id TEXT PRIMARY KEY, source_message_id TEXT, code TEXT NOT NULL, message TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('line', 'ai')), label TEXT NOT NULL, credential TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS line_destinations (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, destination_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('user', 'group', 'room')), status TEXT NOT NULL DEFAULT 'discovered', discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(connection_id, destination_id));
CREATE TABLE IF NOT EXISTS recipient_link_tokens (token TEXT PRIMARY KEY, recipient_profile_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recipient_line_destinations (recipient_profile_id TEXT NOT NULL, line_destination_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(recipient_profile_id, line_destination_id));
CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, event_id TEXT, channel TEXT NOT NULL, destination TEXT NOT NULL, outcome TEXT NOT NULL, external_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recipient_profiles (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(email));
CREATE TABLE IF NOT EXISTS event_recipients (event_id TEXT NOT NULL, recipient_profile_id TEXT NOT NULL, name_snapshot TEXT NOT NULL, email_snapshot TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(event_id, recipient_profile_id));
CREATE TABLE IF NOT EXISTS google_connections (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind = 'automation_inbox'), google_subject TEXT NOT NULL UNIQUE, inbox_address TEXT NOT NULL UNIQUE, granted_scopes TEXT NOT NULL, token_envelope TEXT NOT NULL, gmail_history_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'reauthentication_required', 'disconnected')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
`;

const string = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const provisionSetup = async (env: Bindings, setup: SetupRow): Promise<void> => {
  if (!setup.organization_id || !setup.owner_identity_id || !setup.inbox_address || !setup.google_subject || !setup.granted_scopes || !setup.credential_envelope || !setup.history_id || !setup.binding_name) {
    throw new Error('Organization setup is incomplete.');
  }
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  let databaseId = setup.database_id;
  if (!databaseId) {
    databaseId = await createD1Database(env, `mail-organization-${setup.organization_id}`);
    await env.CONTROL_DB.prepare('UPDATE organization_setups SET database_id = ?, updated_at = ? WHERE id = ?')
      .bind(databaseId, new Date().toISOString(), setup.id).run();
  }
  for (const statement of organizationSchema.split(';').map((value) => value.trim()).filter(Boolean)) {
    await executeD1(env, databaseId, statement);
  }
  const keyRecord = await env.CONTROL_DB.prepare('SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = ?')
    .bind(setup.organization_id).first<{ master_key_version: string; wrapped_key_envelope: string }>();
  if (!keyRecord) throw new Error('Organization encryption key is missing.');
  const organizationKey = await unwrapOrganizationKey({ masterKeyVersion: keyRecord.master_key_version, envelope: JSON.parse(keyRecord.wrapped_key_envelope) }, key, setup.organization_id);
  const tokenSet = await decrypt(JSON.parse(setup.credential_envelope), key, `setup-credential:${setup.id}`);
  const tokenEnvelope = await encrypt(tokenSet, organizationKey, `google-connection:${setup.organization_id}:automation-inbox`);
  const now = new Date().toISOString();
  await executeD1(env, databaseId,
    `INSERT OR IGNORE INTO google_connections (id, kind, google_subject, inbox_address, granted_scopes, token_envelope, gmail_history_id, status, created_at, updated_at) VALUES (${string(crypto.randomUUID())}, 'automation_inbox', ${string(setup.google_subject)}, ${string(setup.inbox_address)}, ${string(setup.granted_scopes)}, ${string(JSON.stringify(tokenEnvelope))}, ${string(setup.history_id)}, 'active', ${string(now)}, ${string(now)});`);
  await attachD1Binding(env, setup.binding_name, databaseId);
  await verifyD1Schema(env, databaseId);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("UPDATE organizations SET database_id = ?, binding_name = ?, status = 'active', updated_at = ? WHERE id = ?").bind(databaseId, setup.binding_name, now, setup.organization_id),
    env.CONTROL_DB.prepare("UPDATE members SET state = 'active', updated_at = ? WHERE organization_id = ? AND identity_id = ?").bind(now, setup.organization_id, setup.owner_identity_id),
    env.CONTROL_DB.prepare("UPDATE organization_setups SET state = 'active', database_id = ?, credential_envelope = NULL, updated_at = ? WHERE id = ?").bind(databaseId, now, setup.id),
  ]);
};

export const createSetupOrganizationKey = async (env: Bindings, organizationId: string): Promise<void> => {
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  const wrapped = await createOrganizationKey(key, env.CREDENTIAL_MASTER_KEY_VERSION, organizationId);
  const now = new Date().toISOString();
  await env.CONTROL_DB.prepare('INSERT OR IGNORE INTO organization_keys (organization_id, master_key_version, wrapped_key_envelope, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(organizationId, wrapped.masterKeyVersion, JSON.stringify(wrapped.envelope), now, now).run();
};

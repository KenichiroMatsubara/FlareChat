export interface Bindings {
  CONTROL_DB: D1Database;
  ASSETS: Fetcher;
  APP_URL: string;
  WEB_ORIGIN: string;
  RP_ID: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  CREDENTIAL_MASTER_KEY: string;
  CREDENTIAL_MASTER_KEY_VERSION: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_WORKER_NAME: string;
  ACTIVE_ORGANIZATION_LIMIT: string;
}

export interface SetupRow {
  id: string;
  name: string;
  state: 'awaiting_google' | 'awaiting_passkey' | 'provisioning' | 'active' | 'expired' | 'failed';
  oauth_state_hash: string;
  pkce_verifier_envelope: string;
  passkey_challenge_hash: string | null;
  inbox_address: string | null;
  google_subject: string | null;
  granted_scopes: string | null;
  credential_envelope: string | null;
  history_id: string | null;
  owner_identity_id: string | null;
  organization_id: string | null;
  database_id: string | null;
  binding_name: string | null;
  provisioning_key: string | null;
  error_message: string | null;
  expires_at: string;
  provisioning_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PasskeyRow {
  id: string;
  identity_id: string;
  credential_id: string;
  public_key_jwk: string;
  sign_count: number;
}

export interface SessionRow {
  id: string;
  identity_id: string;
  email: string;
  display_name: string;
}

export interface GoogleAutomationRow {
  id: string;
  identity_id: string;
  google_subject: string;
  email: string;
  display_name: string;
  token_envelope: string;
  gmail_history_id: string;
  enabled: number;
  last_synced_at: string | null;
  last_error: string | null;
}

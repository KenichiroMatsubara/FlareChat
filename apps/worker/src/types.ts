import type { MarkdownConverter } from './attachment-conversion';

export interface Bindings {
  AI: MarkdownConverter;
  CONTROL_DB: D1Database;
  RECOVERY_RECEIPTS: R2Bucket;
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
}

export interface SessionRow {
  id: string;
  identity_id: string;
  email: string;
  display_name: string;
}

export interface OrganizationRow {
  id: string;
  name: string;
  status: 'provisioning' | 'active' | 'suspended' | 'failed';
  database_id: string | null;
  binding_name: string;
}

export interface ConnectionRow {
  id: string;
  kind: 'line' | 'ai';
  label: string;
  credential: string;
  status: 'active' | 'disconnected';
}

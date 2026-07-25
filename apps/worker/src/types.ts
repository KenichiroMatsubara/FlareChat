export interface Bindings {
  CONTROL_DB: D1Database;
  ORG_DB: D1Database;
  ASSETS: Fetcher;
  APP_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  AI_API_KEY: string;
  ACTIVE_ORGANIZATION_LIMIT: string;
}

export interface ListRow {
  id: string;
  organization_id: string;
  kind: 'source' | 'recipient' | 'line';
  name: string;
  description: string;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface RuleRow {
  id: string;
  organization_id: string;
  name: string;
  status: 'draft' | 'active' | 'suspended' | 'archived';
  source_list_id: string | null;
  recipient_list_id: string | null;
  line_list_id: string | null;
  schedule_minutes: number;
  require_attendance: number;
  deadline_days_before: number | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: string;
  organization_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  location: string;
  status: 'draft' | 'scheduled' | 'cancelled' | 'exception';
  source_subject: string | null;
  attendance_deadline: string | null;
  attending: number;
  not_attending: number;
  unanswered: number;
  updated_at: string;
}

export interface CountRow {
  count: number;
}

export interface SettingRow {
  value: string;
}

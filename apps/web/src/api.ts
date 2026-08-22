import type { AppState } from '@mail/domain';

interface ApiResult<T> {
  data: T;
}

interface ApiFailureDetails {
  message?: string;
  code?: string;
  category?: string;
  databaseKind?: 'control' | 'organization';
  databaseId?: string | null;
  bindingName?: string;
  currentMigration?: string;
  expectedMigration?: string;
  requestId?: string;
}

interface ApiFailure {
  error?: ApiFailureDetails;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly category: string | undefined;
  readonly databaseKind: 'control' | 'organization' | undefined;
  readonly databaseId: string | null | undefined;
  readonly bindingName: string | undefined;
  readonly currentMigration: string | undefined;
  readonly expectedMigration: string | undefined;
  readonly requestId: string | undefined;

  constructor(error: ApiFailureDetails, status: number) {
    const message = error.code === 'schema_not_ready'
      ? `データベースのマイグレーション状態が不正です（${error.databaseKind ?? 'unknown'}: 現在 ${error.currentMigration ?? '不明'} / 期待 ${error.expectedMigration ?? '不明'}、request ID: ${error.requestId ?? '不明'}）。`
      : error.message ?? 'サービスに接続できませんでした。時間をおいて画面を再読み込みしてください。';
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code;
    this.category = error.category;
    this.databaseKind = error.databaseKind;
    this.databaseId = error.databaseId;
    this.bindingName = error.bindingName;
    this.currentMigration = error.currentMigration;
    this.expectedMigration = error.expectedMigration;
    this.requestId = error.requestId;
  }
}

export interface AutomationStatus {
  email: string;
  displayName: string;
  enabled: boolean;
  status: 'active' | 'reauthentication_required' | 'disconnected';
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Set while scheduled runs keep failing; the Worker keeps retrying until it clears. */
  failingSince: string | null;
  created: number;
  skipped: number;
  exceptions: number;
}

export interface AutomationSummary {
  scanned: number;
  created: number;
  skipped: number;
  exceptions: number;
}

export type ContactAttendanceStatus = 'unanswered' | 'attending' | 'not_attending';

export interface ContactPortalEvent {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  registrationDeadline: string | null;
  status: ContactAttendanceStatus;
  comment: string;
  open: boolean;
}

export interface ContactPortalTask {
  taskId: string;
  title: string;
  deadline: string;
  assigneeName: string;
  sourceMessageSubject: string;
  description: string;
  remarks: string;
  completed: boolean;
  mine: boolean;
}

export interface ContactPortal {
  account: { accountId: string; name: string };
  contact: { contactId: string; name: string };
  events: ContactPortalEvent[];
  tasks: ContactPortalTask[];
}

export interface AccountMembership {
  accountId: string;
  name: string;
  status: string;
}

export interface AuthMe {
  email: string;
  displayName: string;
  accounts: AccountMembership[];
}

export interface AccountConnections {
  accountId: string;
  accountName: string;
  line: {
    channelAccessTokenConfigured: boolean;
    channelSecretConfigured: boolean;
    webhookUrl: string;
  };
  ai: {
    apiKeyConfigured: boolean;
    model: string;
    baseUrl: string;
  };
}

export interface AccountDashboard {
  activeRules: number;
  upcomingEvents: number;
  pendingJobs: number;
  exceptions: number;
  lastSyncedAt: string | null;
}

/** The Guest Registrations on one Scheduled Event, as an AccountIdentity reviews the roster. */
export interface GuestRegistrationRoster {
  eventId: string;
  title: string;
  startsAt: string;
  attendingCount: number;
  affiliations: Array<{ affiliation: string; attending: number }>;
  guests: Array<{ name: string; affiliation: string; attending: boolean }>;
}

export interface AccountRule {
  id: string;
  accountId: string;
  name: string;
  state: 'draft' | 'active' | 'suspended' | 'archived';
  executionMode: 'read_only' | 'approval' | 'unattended';
  revision: number;
  selectionPolicy: Record<string, unknown>;
  routingPolicy: Record<string, unknown>;
  /** The Contact List this Rule's Source Message Notice reaches, or null. */
  noticeContactListId: string | null;
  permittedRecipientListIds: string[];
  permittedLineListIds: string[];
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountRuleInput {
  name: string;
  state: 'draft' | 'active';
  executionMode?: 'read_only' | 'approval' | 'unattended';
  selectionPolicy?: Record<string, unknown>;
  routingPolicy?: Record<string, unknown>;
  noticeContactListId?: string | null;
  permittedRecipientListIds?: string[];
  permittedLineListIds?: string[];
  priority?: number;
}

export interface AccountPrompt {
  id: string;
  accountId: string;
  name: string;
  instructions: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountAgentRule {
  id: string;
  accountId: string;
  name: string;
  state: 'draft' | 'active' | 'suspended' | 'archived';
  executionMode: 'read_only' | 'approval' | 'unattended';
  promptId: string;
  selectionPolicy: Record<string, unknown>;
  permittedRecipientListIds: string[];
  permittedLineListIds: string[];
  priority: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunIndex {
  id: string;
  agentRuleId: string;
  agentRuleRevision: number;
  promptId: string;
  promptRevision: number;
  sourceMessageId: string;
  model: string;
  startedAt: string;
  completedAt: string;
  outcome: 'succeeded' | 'failed';
  toolCallCount: number;
  tokens: number;
  expiresAt: string;
}

export interface AgentRunTranscript {
  runId: string;
  source: { subject: string; body: string; attachments: Array<{ filename: string; text: string }> };
  messages: Array<{ role: string; content: string }>;
  finalOutput: string;
  error: string | null;
}

export interface RuleEffect {
  id: string;
  key: string;
  kind: string;
  arguments: Record<string, unknown>;
  dependsOn: string[];
  status: 'planned' | 'pending' | 'applying' | 'succeeded' | 'transient_failed' | 'permanent_failed' | 'blocked' | 'rejected' | 'expired';
  attempts: number;
  result: unknown | null;
  error: string | null;
}

export interface RuleRun {
  id: string;
  rule: { type: 'schema' | 'agent'; id: string; revision: number };
  sourceMessageId: string;
  sourceMessage: { subject: string; sender: string; receivedAt: string };
  executionMode: 'read_only' | 'approval' | 'unattended';
  intent: 'live' | 'draft_preview';
  status: 'planning' | 'read_only' | 'pending_approval' | 'applying' | 'completed' | 'rejected' | 'expired' | 'failed';
  expiresAt: string | null;
  effects: RuleEffect[];
}

export interface AccountTypedList {
  id: string;
  accountId: string;
  kind: 'source' | 'recipient' | 'line';
  name: string;
  description: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PresetSummary {
  id: string;
  name: string;
  description: string;
}

export interface PresetApplicationSummary {
  presetId: string;
  typedLists: number;
  prompts: number;
  schemaRules: number;
  agentRules: number;
}

export interface DeliveryAuditRecord {
  id: string;
  eventId: string | null;
  channel: string;
  destination: string;
  outcome: string;
  externalId: string | null;
  createdAt: string;
}

export interface MailboxTestMatch {
  id: string;
  subject: string;
  sender: string;
}

export interface MailboxTestPreview extends MailboxTestMatch {
  selectedRule: { id: string; revision: number };
  summary: string;
  events: Array<{
    title: string;
    startsAt: string;
    endsAt: string;
    timeZone: string;
    location: string;
    description: string;
    summary: string;
  }>;
  tasks: Array<{
    title: string;
    deadline: string;
    assigneeContactId: string;
    description: string;
  }>;
  confirmationToken: string;
  expiresAt: string;
}

export interface AccountTask {
  id: string; title: string; deadline: string; assigneeContactId: string | null; assigneeName: string; sourceMessageSubject: string; description: string; remarks: string; completed: boolean; completedAt: string | null;
}

/** Whether an Account sends reminders, and on which milestones. */
export interface ReminderSettings {
  enabled: boolean;
  days: number[];
}

/** One attendance reminder the fixed milestones will send, as the GUI previews it. */
export interface ScheduledAttendanceReminder {
  eventId: string;
  eventTitle: string;
  deadline: string;
  contactId: string;
  contactName: string;
  channel: string;
  destination: string;
  milestone: number;
  sendOn: string;
  text: string;
}

/** One reminder the configured milestones will send, as the GUI previews it. */
export interface ScheduledTaskReminder {
  taskId: string;
  title: string;
  deadline: string;
  contactId: string;
  contactName: string;
  channel: string;
  destination: string;
  milestone: number;
  sendOn: string;
  text: string;
}

export interface ContactLineDestination {
  id: string;
  destinationId: string;
  displayName: string;
  kind: 'user' | 'group' | 'room';
  status: 'discovered' | 'disabled';
  source: 'webhook' | 'manual';
}

export interface AccountContact {
  id: string;
  accountId: string;
  name: string;
  email: string;
  state: 'active' | 'inactive';
  /** What kind of Contact this is, in the Account's own words. */
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lineDestinations: ContactLineDestination[];
}

export interface AccountLineDestination extends ContactLineDestination {
  discoveredAt: string;
  contactId: string | null;
}

export interface AccountContactInput {
  name: string;
  email?: string;
  description?: string;
  tags?: string[];
  lineDestinationId?: string;
}

export interface ContactLineDestinationInput {
  destinationId: string;
  kind?: 'user' | 'group' | 'room';
  displayName?: string;
}

/** The OpenAI-compatible JSON body prepared for review; credentials are never included. */
export interface MailboxTestAiRequest extends MailboxTestMatch {
  request: Record<string, unknown>;
}

export interface MailboxTestEventCandidate {
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  location: string;
  description: string;
  summary: string;
}

/** An existing Scheduled Event as it stands in Google Calendar right now. */
export interface ScheduledEventFields {
  id: string;
  etag: string | null;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
}

export interface MailboxTestRefreshRequest {
  existing: ScheduledEventFields[];
  outOfWindow: ScheduledEventFields[];
  request: Record<string, unknown> | null;
}

export interface MailboxTestRefreshEntry {
  candidateIndex: number;
  candidate: MailboxTestEventCandidate;
  target: ScheduledEventFields | null;
  changedFields: string[];
  desired: {
    title: string;
    description: string;
    location: string;
    startsAt: string;
    endsAt: string;
    timeZone: string;
  } | null;
}

export interface MailboxTestRefreshPlan {
  entries: MailboxTestRefreshEntry[];
  unmatched: ScheduledEventFields[];
  outOfWindow: ScheduledEventFields[];
  pendingAttachments: string[];
  confirmationToken: string;
  expiresAt: string;
}

export interface MailboxTestRefreshOutcome {
  updated: string[];
  created: string[];
  conflicts: Array<{
    candidateIndex: number;
    googleEventId: string;
    etag: string | null;
    current: ScheduledEventFields;
    changedFields: string[];
    candidate: MailboxTestEventCandidate;
  }>;
  failures: Array<{ googleEventId: string | null; title: string; message: string }>;
  confirmationToken: string | null;
  expiresAt: string | null;
}

const responseBody = async <T>(response: Response): Promise<(ApiResult<T> & ApiFailure) | null> => {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as ApiResult<T> & ApiFailure; }
  catch { throw new Error('サービスから正しい応答を受け取れませんでした。URLを確認して画面を再読み込みしてください。'); }
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await responseBody<T>(response);
  if (!response.ok) throw new ApiError(body?.error ?? {}, response.status);
  if (!body) throw new Error('サービスから応答がありませんでした。画面を再読み込みしてください。');
  return body.data;
};

const currentAutomation = async (accountId: string): Promise<AutomationStatus | null> => {
  const response = await fetch(`/api/organizations/${encodeURIComponent(accountId)}/automation`, { credentials: 'include' });
  if (response.status === 401) return null;
  const body = await responseBody<AutomationStatus | null>(response);
  if (!response.ok) throw new Error(body?.error?.message ?? '状態を取得できませんでした。');
  if (!body) throw new Error('状態を取得できませんでした。');
  return body.data;
};

export const api = {
  bootstrap: (): Promise<AppState> => request('/api/bootstrap'),
  beginGoogleEntry: (intent: 'login' | 'organization_setup'): Promise<{ authorizationUrl: string }> =>
    request('/api/entry/google', { method: 'POST', body: JSON.stringify({ intent }) }),

  joinContactPortal: (accountId: string, token: string): Promise<{ contactId: string; name: string }> =>
    request(`/api/member-links/${encodeURIComponent(accountId)}/${encodeURIComponent(token)}`, { method: 'POST', body: '{}' }),

  contactPortal: (): Promise<ContactPortal> => request('/api/portal'),

  registerContactAttendance: (eventId: string, input: { status: ContactAttendanceStatus; comment: string }): Promise<{ eventId: string }> =>
    request(`/api/portal/events/${encodeURIComponent(eventId)}/attendance`, { method: 'PUT', body: JSON.stringify(input) }),

  updateContactTask: (taskId: string, input: { completed?: boolean; remarks?: string }): Promise<{ taskId: string }> =>
    request(`/api/portal/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  reauthorizeAutomationInbox: (accountId: string): Promise<{ authorizationUrl: string }> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/automation/reauthorize`, { method: 'POST' }),
  presets: (): Promise<PresetSummary[]> => request('/api/presets'),
  confirmOnboarding: (name: string, presetId?: string): Promise<{ accepted: boolean }> =>
    request('/api/onboarding/confirm', { method: 'POST', body: JSON.stringify({ name, ...(presetId ? { presetId } : {}) }) }),
  retryOnboarding: (): Promise<{ accepted: boolean }> => request('/api/onboarding/retry', { method: 'POST' }),
  cancelOnboarding: (): Promise<{ cancelled: boolean }> => request('/api/onboarding', { method: 'DELETE' }),
  currentAutomation,
  accountDashboard: (accountId: string): Promise<AccountDashboard> => request(`/api/organizations/${encodeURIComponent(accountId)}/dashboard`),
  accountGuestRegistrations: (accountId: string): Promise<GuestRegistrationRoster[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/guest-registrations`),
  accountRules: (accountId: string): Promise<AccountRule[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/rules`),
  accountPrompts: (accountId: string): Promise<AccountPrompt[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/prompts`),
  accountAgentRules: (accountId: string): Promise<AccountAgentRule[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/agent-rules`),
  accountAgentRuns: (accountId: string): Promise<AgentRunIndex[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/agent-runs`),
  agentRunTranscript: (accountId: string, runId: string): Promise<AgentRunTranscript> => request(`/api/organizations/${encodeURIComponent(accountId)}/agent-runs/${encodeURIComponent(runId)}/transcript`),
  accountLists: (accountId: string): Promise<AccountTypedList[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/lists`),
  applyAccountPreset: (accountId: string, presetId: string, conflictPolicy?: 'duplicate'): Promise<PresetApplicationSummary> => request(`/api/organizations/${encodeURIComponent(accountId)}/presets/${encodeURIComponent(presetId)}/apply`, {
    method: 'POST',
    body: JSON.stringify(conflictPolicy ? { conflictPolicy } : {}),
  }),
  accountDeliveryAudit: (accountId: string): Promise<DeliveryAuditRecord[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/audit/deliveries`),
  accountTasks: (accountId: string): Promise<AccountTask[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/tasks`),

  taskReminders: (accountId: string): Promise<ReminderSettings> => request(`/api/organizations/${encodeURIComponent(accountId)}/task-reminders`),

  saveTaskReminders: (accountId: string, input: { days?: readonly number[]; enabled?: boolean }): Promise<ReminderSettings> => request(`/api/organizations/${encodeURIComponent(accountId)}/task-reminders`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),

  scheduledTaskReminders: (accountId: string): Promise<ScheduledTaskReminder[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/task-reminders/schedule`),

  attendanceReminders: (accountId: string): Promise<ReminderSettings> => request(`/api/organizations/${encodeURIComponent(accountId)}/attendance-reminders`),

  saveAttendanceReminders: (accountId: string, enabled: boolean): Promise<ReminderSettings> => request(`/api/organizations/${encodeURIComponent(accountId)}/attendance-reminders`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  }),

  scheduledAttendanceReminders: (accountId: string): Promise<ScheduledAttendanceReminder[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/attendance-reminders/schedule`),

  accountAttachmentFolder: (accountId: string): Promise<{ path: string }> => request(`/api/organizations/${encodeURIComponent(accountId)}/attachment-folder`),

  saveAccountAttachmentFolder: (accountId: string, path: string): Promise<{ path: string }> => request(`/api/organizations/${encodeURIComponent(accountId)}/attachment-folder`, {
    method: 'PUT',
    body: JSON.stringify({ path }),
  }),

  accountResponseWindow: (accountId: string): Promise<{ days: number }> => request(`/api/organizations/${encodeURIComponent(accountId)}/response-window`),

  saveAccountResponseWindow: (accountId: string, days: number): Promise<{ days: number }> => request(`/api/organizations/${encodeURIComponent(accountId)}/response-window`, {
    method: 'PUT',
    body: JSON.stringify({ days }),
  }),

  accountContacts: (accountId: string): Promise<AccountContact[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/members`),
  accountLineDestinations: (accountId: string): Promise<AccountLineDestination[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/line-destinations`),
  createAccountContact: (accountId: string, input: AccountContactInput): Promise<AccountContact> => request(`/api/organizations/${encodeURIComponent(accountId)}/members`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  updateAccountContact: (
    accountId: string,
    contactId: string,
    input: Partial<Pick<AccountContact, 'name' | 'email' | 'tags' | 'state'>>,
  ): Promise<Partial<AccountContact> & { id: string }> => request(`/api/organizations/${encodeURIComponent(accountId)}/members/${encodeURIComponent(contactId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }),
  setContactLineDestination: (
    accountId: string,
    contactId: string,
    input: ContactLineDestinationInput,
  ): Promise<ContactLineDestination> => request(`/api/organizations/${encodeURIComponent(accountId)}/members/${encodeURIComponent(contactId)}/line-destination`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  removeContactLineDestination: (
    accountId: string,
    contactId: string,
    lineDestinationId: string,
  ): Promise<{ id: string; unlinked: boolean }> => request(`/api/organizations/${encodeURIComponent(accountId)}/members/${encodeURIComponent(contactId)}/line-destination/${encodeURIComponent(lineDestinationId)}`, {
    method: 'DELETE',
  }),
  registerLineDestination: (
    accountId: string,
    input: ContactLineDestinationInput,
  ): Promise<AccountLineDestination> => request(`/api/organizations/${encodeURIComponent(accountId)}/line-destinations`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  removeLineDestination: (
    accountId: string,
    lineDestinationId: string,
  ): Promise<{ id: string; removed: boolean }> => request(`/api/organizations/${encodeURIComponent(accountId)}/line-destinations/${encodeURIComponent(lineDestinationId)}`, {
    method: 'DELETE',
  }),
  updateAccountTask: (accountId: string, taskId: string, input: { completed?: boolean; remarks?: string; assigneeContactId?: string | null }): Promise<AccountTask> => request(`/api/organizations/${encodeURIComponent(accountId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  createAccountRule: (accountId: string, input: AccountRuleInput): Promise<AccountRule> => request(`/api/organizations/${encodeURIComponent(accountId)}/rules`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  updateAccountRule: (accountId: string, ruleId: string, input: Partial<Pick<AccountRule, 'state' | 'executionMode' | 'noticeContactListId' | 'permittedRecipientListIds' | 'permittedLineListIds'>>): Promise<Partial<AccountRule> & { id: string }> => request(`/api/organizations/${encodeURIComponent(accountId)}/rules/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }),
  createAccountPrompt: (accountId: string, input: { name: string; instructions: string }): Promise<AccountPrompt> => request(`/api/organizations/${encodeURIComponent(accountId)}/prompts`, { method: 'POST', body: JSON.stringify(input) }),
  updateAccountPrompt: (accountId: string, promptId: string, input: { name?: string; instructions?: string }): Promise<Partial<AccountPrompt> & { id: string }> => request(`/api/organizations/${encodeURIComponent(accountId)}/prompts/${encodeURIComponent(promptId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  removeAccountPrompt: (accountId: string, promptId: string): Promise<{ id: string; removed: boolean }> => request(`/api/organizations/${encodeURIComponent(accountId)}/prompts/${encodeURIComponent(promptId)}`, { method: 'DELETE' }),
  createAccountAgentRule: (accountId: string, input: { name: string; promptId: string; state: 'draft' | 'active'; executionMode?: 'read_only' | 'approval' | 'unattended'; selectionPolicy: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[]; priority?: number }): Promise<AccountAgentRule> => request(`/api/organizations/${encodeURIComponent(accountId)}/agent-rules`, { method: 'POST', body: JSON.stringify(input) }),
  updateAccountAgentRule: (accountId: string, agentRuleId: string, input: { state?: 'draft' | 'active' | 'suspended' | 'archived'; executionMode?: 'read_only' | 'approval' | 'unattended'; promptId?: string; selectionPolicy?: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[] }): Promise<AccountAgentRule> => request(`/api/organizations/${encodeURIComponent(accountId)}/agent-rules/${encodeURIComponent(agentRuleId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  accountRuleRuns: (accountId: string): Promise<RuleRun[]> => request(`/api/organizations/${encodeURIComponent(accountId)}/rule-runs`),
  decideRuleRun: (accountId: string, runId: string, decision: 'approve' | 'reject'): Promise<RuleRun> => request(`/api/organizations/${encodeURIComponent(accountId)}/rule-runs/${encodeURIComponent(runId)}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }),
  accountConnections: (accountId: string): Promise<AccountConnections> => request(`/api/organizations/${encodeURIComponent(accountId)}/connections`),
  saveAccountLineConnection: (accountId: string, input: {
    channelAccessToken?: string | undefined;
    channelSecret?: string | undefined;
  }): Promise<AccountConnections['line']> => request(`/api/organizations/${encodeURIComponent(accountId)}/connections/line`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  saveAccountAiConnection: (accountId: string, input: {
    apiKey?: string | undefined;
    model?: string | undefined;
    baseUrl?: string | undefined;
  }): Promise<AccountConnections['ai']> => request(`/api/organizations/${encodeURIComponent(accountId)}/connections/ai`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  testAiConnection: (accountId: string, prompt: string): Promise<{ text: string; model: string }> => request(`/api/organizations/${encodeURIComponent(accountId)}/connections/ai/test`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  }),
  searchMailboxForTest: (accountId: string, subject: string): Promise<{ messages: MailboxTestMatch[] }> => request(`/api/organizations/${encodeURIComponent(accountId)}/mail-tests/search`, {
    method: 'POST',
    body: JSON.stringify({ subject }),
  }),
  prepareMailboxTestAiRequest: (accountId: string, messageId: string): Promise<MailboxTestAiRequest> => request(`/api/organizations/${encodeURIComponent(accountId)}/mail-tests/${encodeURIComponent(messageId)}/ai-request`, {
    method: 'POST',
  }),
  previewMailboxTestEvent: (accountId: string, messageId: string): Promise<MailboxTestPreview> => request(`/api/organizations/${encodeURIComponent(accountId)}/mail-tests/${encodeURIComponent(messageId)}/preview`, {
    method: 'POST',
  }),
  previewDraftRuleEvent: (accountId: string, messageId: string, ruleId: string): Promise<MailboxTestPreview> => request(`/api/organizations/${encodeURIComponent(accountId)}/mail-tests/${encodeURIComponent(messageId)}/draft-preview`, {
    method: 'POST',
    body: JSON.stringify({ ruleId }),
  }),
  createMailboxTestCalendarEvents: (accountId: string, confirmationToken: string): Promise<{ eventIds: string[] }> => request(`/api/organizations/${encodeURIComponent(accountId)}/mail-tests/calendar`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken }),
  }),
  startMailboxTestRuleRun: (accountId: string, confirmationToken: string, ruleId: string): Promise<RuleRun> => request(`/api/organizations/${encodeURIComponent(accountId)}/mail-tests/rule-run`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken, ruleId }),
  }),
  prepareMailboxTestRefreshRequest: (accountId: string, messageId: string, confirmationToken: string): Promise<MailboxTestRefreshRequest> => request(`/api/organizations/${encodeURIComponent(accountId)}/mail-tests/${encodeURIComponent(messageId)}/refresh-request`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken }),
  }),
  planMailboxTestRefresh: (accountId: string, messageId: string, confirmationToken: string): Promise<MailboxTestRefreshPlan> => request(`/api/organizations/${encodeURIComponent(accountId)}/mail-tests/${encodeURIComponent(messageId)}/refresh-plan`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken }),
  }),
  applyMailboxTestRefresh: (accountId: string, confirmationToken: string, candidateIndexes: number[]): Promise<MailboxTestRefreshOutcome> => request(`/api/organizations/${encodeURIComponent(accountId)}/mail-tests/refresh`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken, candidateIndexes }),
  }),
  runAutomation: (accountId: string): Promise<AutomationSummary> => request(`/api/organizations/${encodeURIComponent(accountId)}/automation/run`, { method: 'POST' }),
  setEnabled: (accountId: string, enabled: boolean): Promise<{ enabled: boolean }> => request(`/api/organizations/${encodeURIComponent(accountId)}/automation/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  logout: (): Promise<{ loggedOut: boolean }> => request('/api/auth/logout', { method: 'POST' }),
  mcpServers: (accountId: string): Promise<McpServerView[]> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/mcp-servers`),
  saveMcpServer: (accountId: string, id: string, input: { name: string; url: string; token: string | null }): Promise<{ id: string }> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/mcp-servers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  removeMcpServer: (accountId: string, id: string): Promise<{ id: string }> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  chatConversations: (accountId: string): Promise<ChatConversationView[]> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/chat`),
  chatTurns: (accountId: string, conversationId: string): Promise<ChatTurnView[]> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/chat/${encodeURIComponent(conversationId)}`),
  sendChatMessage: (accountId: string, input: { conversationId: string | null; message: string }): Promise<ChatReply> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/chat`, { method: 'POST', body: JSON.stringify(input) }),
  contactLists: (accountId: string): Promise<ContactListView[]> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/contact-lists`),
  saveContactList: (accountId: string, id: string, input: { name: string; contactIds: string[] }): Promise<{ id: string }> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/contact-lists/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  accessTokens: (accountId: string): Promise<AccessTokenView[]> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/access-tokens`),
  issueAccessToken: (accountId: string, input: { name: string; contactListId: string; tools: string[]; suppressionWindow: string }): Promise<IssuedAccessToken> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/access-tokens`, { method: 'POST', body: JSON.stringify(input) }),
  revokeAccessToken: (accountId: string, id: string): Promise<{ id: string }> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/access-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  automations: (accountId: string): Promise<AutomationView[]> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/automations`),
  saveAutomation: (accountId: string, id: string, input: AutomationInput): Promise<{ id: string; nextRunAt: string | null }> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/automations/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  removeAutomation: (accountId: string, id: string): Promise<{ id: string }> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/automations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  automationRuns: (accountId: string, id: string): Promise<AutomationRunView[]> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/automations/${encodeURIComponent(id)}/runs`),
  saveDiscordConnection: (accountId: string, input: { botToken: string; applicationPublicKey: string }): Promise<{ configured: boolean; interactionsUrl: string }> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/connections/discord`, { method: 'PUT', body: JSON.stringify(input) }),
  channelTestTargets: (accountId: string): Promise<ChannelTestTarget[]> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/channel-tests/targets`),
  sendChannelTest: (accountId: string, input: { contactId: string; channel: string; texts: string[] }): Promise<ChannelTestDelivery> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/channel-tests`, { method: 'POST', body: JSON.stringify(input) }),
  listMcpServerTools: (accountId: string, serverId: string): Promise<{ server: string; tools: McpServerToolView[] }> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/mcp-servers/${encodeURIComponent(serverId)}/tests`, { method: 'POST', body: JSON.stringify({}) }),
  callMcpServerTool: (accountId: string, serverId: string, input: { tool: string; arguments: Record<string, unknown> }): Promise<McpServerToolResult> =>
    request(`/api/organizations/${encodeURIComponent(accountId)}/mcp-servers/${encodeURIComponent(serverId)}/tests`, { method: 'POST', body: JSON.stringify(input) }),
};

/** One Contact a test message can actually be sent to, and where. */
export interface ChannelTestTarget {
  id: string;
  name: string;
  email: string;
  state: string;
  channels: string[];
}

export interface ChannelTestDelivery {
  delivered: boolean;
  channel: string;
  contactId: string;
  destination: string;
  /** How many messages were meant to arrive, and how many provider requests carried them. */
  messages: number;
  requests: number;
  externalId: string | null;
  sentAt: string;
}

export interface McpServerToolView {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerToolResult {
  server: string;
  tool: string;
  isError: boolean;
  text: string;
}

export interface AutomationInput {
  name: string;
  promptId: string;
  contactListId: string | null;
  schedule: string;
  offsetMinutes: number;
  executionMode: string;
  suppressionWindow: string;
  state: string;
  tools: string[];
}

export interface AutomationView extends AutomationInput {
  id: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface AutomationRunView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  output: string | null;
  error: string | null;
  toolCalls: number;
}

export interface ContactListView {
  id: string;
  name: string;
  description: string;
  contactIds: string[];
}

export interface AccessTokenView {
  id: string;
  name: string;
  contactListId: string;
  suppressionWindow: string;
  callsPerHour: number;
  writesPerDay: number;
  lastUsedAt: string | null;
  tools: string[];
}

export interface IssuedAccessToken {
  id: string;
  name: string;
  tools: string[];
  token: string;
  url: string;
}

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  revision: string | null;
  authenticated: boolean;
  updatedAt: string;
}

export interface ChatConversationView {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatTurnView {
  id: string;
  position: number;
  request: string;
  response: string | null;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
  ruleRunId: string;
}

export interface ChatReply {
  conversationId: string;
  turnId: string;
  ruleRunId: string;
  response: string;
  toolCallCount: number;
  unreachableServers: Array<{ server: string; error: string }>;
}

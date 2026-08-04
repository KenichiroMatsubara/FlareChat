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

export type MemberAttendanceStatus = 'unanswered' | 'attending' | 'not_attending';

export interface MemberPortalEvent {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  registrationDeadline: string | null;
  status: MemberAttendanceStatus;
  comment: string;
  open: boolean;
}

export interface MemberPortalTask {
  taskId: string;
  title: string;
  deadline: string;
  assigneeRoleName: string;
  assigneeName: string;
  sourceMessageSubject: string;
  description: string;
  remarks: string;
  completed: boolean;
  mine: boolean;
}

export interface MemberPortal {
  organization: { organizationId: string; name: string };
  member: { memberId: string; name: string };
  events: MemberPortalEvent[];
  tasks: MemberPortalTask[];
}

export interface OrganizationMembership {
  organizationId: string;
  name: string;
  status: string;
}

export interface AuthMe {
  email: string;
  displayName: string;
  organizations: OrganizationMembership[];
}

export interface OrganizationConnections {
  organizationId: string;
  organizationName: string;
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

export interface OrganizationDashboard {
  activeRules: number;
  upcomingEvents: number;
  pendingJobs: number;
  exceptions: number;
  lastSyncedAt: string | null;
}

export interface OrganizationRule {
  id: string;
  organizationId: string;
  name: string;
  state: 'draft' | 'active' | 'suspended' | 'archived';
  selectionPolicy: Record<string, unknown>;
  routingPolicy: Record<string, unknown>;
  taskRoleIds: string[];
  permittedRecipientListIds: string[];
  permittedLineListIds: string[];
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationRuleInput {
  name: string;
  state: 'draft' | 'active';
  selectionPolicy?: Record<string, unknown>;
  routingPolicy?: Record<string, unknown>;
  taskRoleIds?: string[];
  permittedRecipientListIds?: string[];
  permittedLineListIds?: string[];
  priority?: number;
}

export interface OrganizationPrompt {
  id: string;
  organizationId: string;
  name: string;
  instructions: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationAgentRule {
  id: string;
  organizationId: string;
  name: string;
  state: 'active' | 'suspended' | 'archived';
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

export interface ProposedAction {
  id: string;
  runId: string;
  tool: 'send_line_message' | 'create_scheduled_event';
  arguments: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'failed';
  expiresAt: string;
}

export interface OrganizationTypedList {
  id: string;
  organizationId: string;
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
  operationalTaskRoles: number;
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
    assigneeRoleId: string;
    description: string;
  }>;
  confirmationToken: string;
  expiresAt: string;
}

export interface OrganizationTask {
  id: string; title: string; deadline: string; assigneeRoleId: string; assigneeRoleName: string; assigneeMemberId: string | null; assigneeName: string; sourceMessageSubject: string; description: string; remarks: string; completed: boolean; completedAt: string | null;
}

export interface MemberLineDestination {
  id: string;
  destinationId: string;
  displayName: string;
  kind: 'user' | 'group' | 'room';
  status: 'discovered' | 'disabled';
  source: 'webhook' | 'manual';
}

export interface OrganizationMember {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  state: 'active' | 'inactive';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lineDestinations: MemberLineDestination[];
}

export interface OrganizationLineDestination extends MemberLineDestination {
  discoveredAt: string;
  memberId: string | null;
}

export interface OrganizationMemberInput {
  name: string;
  email?: string;
  tags?: string[];
  lineDestinationId?: string;
}

export interface MemberLineDestinationInput {
  destinationId: string;
  kind?: 'user' | 'group' | 'room';
  displayName?: string;
}

/** Whether the open Tasks still have to be reviewed against a changed role set. */
export interface TaskReassignmentReview {
  rolesChangedAt: string | null;
  reviewedAt: string | null;
  pending: boolean;
  openTasks: number;
}

export interface TaskAssignmentProposal {
  taskId: string;
  title: string;
  deadline: string;
  sourceMessageSubject: string;
  currentRoleId: string;
  currentRoleName: string;
  proposedRoleId: string;
  proposedRoleName: string;
  reason: string;
  changed: boolean;
}

export interface OperationalTaskRole { id: string; displayName: string; description: string; }
export interface TaskRoleAssignment { roleId: string; memberId: string; displayName: string; }
export interface TaskRoleConfiguration { members: Array<{ memberId: string; displayName: string }>; roles: OperationalTaskRole[]; assignments: TaskRoleAssignment[]; }

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

const currentAutomation = async (organizationId: string): Promise<AutomationStatus | null> => {
  const response = await fetch(`/api/organizations/${encodeURIComponent(organizationId)}/automation`, { credentials: 'include' });
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

  joinMemberPortal: (organizationId: string, token: string): Promise<{ memberId: string; name: string }> =>
    request(`/api/member-links/${encodeURIComponent(organizationId)}/${encodeURIComponent(token)}`, { method: 'POST', body: '{}' }),

  memberPortal: (): Promise<MemberPortal> => request('/api/portal'),

  registerMemberAttendance: (eventId: string, input: { status: MemberAttendanceStatus; comment: string }): Promise<{ eventId: string }> =>
    request(`/api/portal/events/${encodeURIComponent(eventId)}/attendance`, { method: 'PUT', body: JSON.stringify(input) }),

  updateMemberTask: (taskId: string, input: { completed?: boolean; remarks?: string }): Promise<{ taskId: string }> =>
    request(`/api/portal/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  reauthorizeAutomationInbox: (organizationId: string): Promise<{ authorizationUrl: string }> =>
    request(`/api/organizations/${encodeURIComponent(organizationId)}/automation/reauthorize`, { method: 'POST' }),
  presets: (): Promise<PresetSummary[]> => request('/api/presets'),
  confirmOnboarding: (name: string, presetId?: string): Promise<{ accepted: boolean }> =>
    request('/api/onboarding/confirm', { method: 'POST', body: JSON.stringify({ name, ...(presetId ? { presetId } : {}) }) }),
  retryOnboarding: (): Promise<{ accepted: boolean }> => request('/api/onboarding/retry', { method: 'POST' }),
  cancelOnboarding: (): Promise<{ cancelled: boolean }> => request('/api/onboarding', { method: 'DELETE' }),
  currentAutomation,
  organizationDashboard: (organizationId: string): Promise<OrganizationDashboard> => request(`/api/organizations/${encodeURIComponent(organizationId)}/dashboard`),
  organizationRules: (organizationId: string): Promise<OrganizationRule[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/rules`),
  organizationPrompts: (organizationId: string): Promise<OrganizationPrompt[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/prompts`),
  organizationAgentRules: (organizationId: string): Promise<OrganizationAgentRule[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/agent-rules`),
  organizationAgentRuns: (organizationId: string): Promise<AgentRunIndex[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/agent-runs`),
  agentRunTranscript: (organizationId: string, runId: string): Promise<AgentRunTranscript> => request(`/api/organizations/${encodeURIComponent(organizationId)}/agent-runs/${encodeURIComponent(runId)}/transcript`),
  organizationLists: (organizationId: string): Promise<OrganizationTypedList[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/lists`),
  applyOrganizationPreset: (organizationId: string, presetId: string, conflictPolicy?: 'duplicate'): Promise<PresetApplicationSummary> => request(`/api/organizations/${encodeURIComponent(organizationId)}/presets/${encodeURIComponent(presetId)}/apply`, {
    method: 'POST',
    body: JSON.stringify(conflictPolicy ? { conflictPolicy } : {}),
  }),
  organizationDeliveryAudit: (organizationId: string): Promise<DeliveryAuditRecord[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/audit/deliveries`),
  organizationTasks: (organizationId: string): Promise<OrganizationTask[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/tasks`),
  organizationAttachmentFolder: (organizationId: string): Promise<{ path: string }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/attachment-folder`),

  saveOrganizationAttachmentFolder: (organizationId: string, path: string): Promise<{ path: string }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/attachment-folder`, {
    method: 'PUT',
    body: JSON.stringify({ path }),
  }),

  organizationMembers: (organizationId: string): Promise<OrganizationMember[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/members`),
  organizationLineDestinations: (organizationId: string): Promise<OrganizationLineDestination[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/line-destinations`),
  createOrganizationMember: (organizationId: string, input: OrganizationMemberInput): Promise<OrganizationMember> => request(`/api/organizations/${encodeURIComponent(organizationId)}/members`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  updateOrganizationMember: (
    organizationId: string,
    memberId: string,
    input: Partial<Pick<OrganizationMember, 'name' | 'email' | 'tags' | 'state'>>,
  ): Promise<Partial<OrganizationMember> & { id: string }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }),
  setMemberLineDestination: (
    organizationId: string,
    memberId: string,
    input: MemberLineDestinationInput,
  ): Promise<MemberLineDestination> => request(`/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}/line-destination`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  removeMemberLineDestination: (
    organizationId: string,
    memberId: string,
    lineDestinationId: string,
  ): Promise<{ id: string; unlinked: boolean }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}/line-destination/${encodeURIComponent(lineDestinationId)}`, {
    method: 'DELETE',
  }),
  registerLineDestination: (
    organizationId: string,
    input: MemberLineDestinationInput,
  ): Promise<OrganizationLineDestination> => request(`/api/organizations/${encodeURIComponent(organizationId)}/line-destinations`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  removeLineDestination: (
    organizationId: string,
    lineDestinationId: string,
  ): Promise<{ id: string; removed: boolean }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/line-destinations/${encodeURIComponent(lineDestinationId)}`, {
    method: 'DELETE',
  }),
  organizationTaskRoles: (organizationId: string): Promise<TaskRoleConfiguration> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-roles`),
  createOrganizationTaskRole: (organizationId: string, input: { displayName: string; description: string }): Promise<OperationalTaskRole> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-roles`, { method: 'POST', body: JSON.stringify(input) }),
  updateOrganizationTaskRole: (organizationId: string, roleId: string, input: { displayName?: string; description?: string }): Promise<OperationalTaskRole> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-roles/${encodeURIComponent(roleId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  removeOrganizationTaskRole: (organizationId: string, roleId: string): Promise<{ id: string; removed: boolean }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' }),
  assignOrganizationTaskRole: (organizationId: string, roleId: string, memberId: string): Promise<TaskRoleAssignment> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-roles/${encodeURIComponent(roleId)}/assignment`, { method: 'PUT', body: JSON.stringify({ memberId }) }),
  updateOrganizationTask: (organizationId: string, taskId: string, input: { completed?: boolean; remarks?: string }): Promise<OrganizationTask> => request(`/api/organizations/${encodeURIComponent(organizationId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  organizationTaskReassignment: (organizationId: string): Promise<TaskReassignmentReview> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-reassignments`),
  suggestOrganizationTaskReassignments: (organizationId: string): Promise<{ proposals: TaskAssignmentProposal[]; review: TaskReassignmentReview }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-reassignments/suggestions`, { method: 'POST', body: JSON.stringify({}) }),
  applyOrganizationTaskReassignments: (organizationId: string, assignments: Array<{ taskId: string; roleId: string }>): Promise<{ tasks: OrganizationTask[]; skipped: string[]; review: TaskReassignmentReview }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-reassignments`, { method: 'POST', body: JSON.stringify({ assignments }) }),
  createOrganizationRule: (organizationId: string, input: OrganizationRuleInput): Promise<OrganizationRule> => request(`/api/organizations/${encodeURIComponent(organizationId)}/rules`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  updateOrganizationRule: (organizationId: string, ruleId: string, input: Pick<OrganizationRuleInput, 'permittedRecipientListIds' | 'permittedLineListIds'>): Promise<Partial<OrganizationRule> & { id: string }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/rules/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }),
  createOrganizationPrompt: (organizationId: string, input: { name: string; instructions: string }): Promise<OrganizationPrompt> => request(`/api/organizations/${encodeURIComponent(organizationId)}/prompts`, { method: 'POST', body: JSON.stringify(input) }),
  updateOrganizationPrompt: (organizationId: string, promptId: string, input: { name?: string; instructions?: string }): Promise<Partial<OrganizationPrompt> & { id: string }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/prompts/${encodeURIComponent(promptId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  removeOrganizationPrompt: (organizationId: string, promptId: string): Promise<{ id: string; removed: boolean }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/prompts/${encodeURIComponent(promptId)}`, { method: 'DELETE' }),
  createOrganizationAgentRule: (organizationId: string, input: { name: string; promptId: string; state: 'active' | 'suspended'; executionMode?: 'read_only' | 'approval' | 'unattended'; selectionPolicy: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[]; priority?: number }): Promise<OrganizationAgentRule> => request(`/api/organizations/${encodeURIComponent(organizationId)}/agent-rules`, { method: 'POST', body: JSON.stringify(input) }),
  updateOrganizationAgentRule: (organizationId: string, agentRuleId: string, input: { state?: 'active' | 'suspended' | 'archived'; executionMode?: 'read_only' | 'approval' | 'unattended'; promptId?: string; selectionPolicy?: Record<string, unknown>; permittedRecipientListIds?: string[]; permittedLineListIds?: string[] }): Promise<OrganizationAgentRule> => request(`/api/organizations/${encodeURIComponent(organizationId)}/agent-rules/${encodeURIComponent(agentRuleId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  agentProposedActions: (organizationId: string, runId: string): Promise<ProposedAction[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/agent-runs/${encodeURIComponent(runId)}/proposed-actions`),
  decideProposedAction: (organizationId: string, actionId: string, decision: 'approve' | 'reject'): Promise<ProposedAction> => request(`/api/organizations/${encodeURIComponent(organizationId)}/proposed-actions/${encodeURIComponent(actionId)}/${decision}`, { method: 'POST', body: '{}' }),
  decideProposedActionBatch: (organizationId: string, runId: string, decision: 'approve' | 'reject'): Promise<ProposedAction[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/agent-runs/${encodeURIComponent(runId)}/proposed-actions/${decision}`, { method: 'POST', body: '{}' }),
  organizationConnections: (organizationId: string): Promise<OrganizationConnections> => request(`/api/organizations/${encodeURIComponent(organizationId)}/connections`),
  saveOrganizationLineConnection: (organizationId: string, input: {
    channelAccessToken?: string | undefined;
    channelSecret?: string | undefined;
  }): Promise<OrganizationConnections['line']> => request(`/api/organizations/${encodeURIComponent(organizationId)}/connections/line`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  saveOrganizationAiConnection: (organizationId: string, input: {
    apiKey?: string | undefined;
    model?: string | undefined;
    baseUrl?: string | undefined;
  }): Promise<OrganizationConnections['ai']> => request(`/api/organizations/${encodeURIComponent(organizationId)}/connections/ai`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  testAiConnection: (organizationId: string, prompt: string): Promise<{ text: string; model: string }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/connections/ai/test`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  }),
  searchMailboxForTest: (organizationId: string, subject: string): Promise<{ messages: MailboxTestMatch[] }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/mail-tests/search`, {
    method: 'POST',
    body: JSON.stringify({ subject }),
  }),
  prepareMailboxTestAiRequest: (organizationId: string, messageId: string): Promise<MailboxTestAiRequest> => request(`/api/organizations/${encodeURIComponent(organizationId)}/mail-tests/${encodeURIComponent(messageId)}/ai-request`, {
    method: 'POST',
  }),
  previewMailboxTestEvent: (organizationId: string, messageId: string): Promise<MailboxTestPreview> => request(`/api/organizations/${encodeURIComponent(organizationId)}/mail-tests/${encodeURIComponent(messageId)}/preview`, {
    method: 'POST',
  }),
  createMailboxTestCalendarEvent: (organizationId: string, confirmationToken: string): Promise<{ eventIds: string[] }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/mail-tests/calendar`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken }),
  }),
  prepareMailboxTestRefreshRequest: (organizationId: string, messageId: string, confirmationToken: string): Promise<MailboxTestRefreshRequest> => request(`/api/organizations/${encodeURIComponent(organizationId)}/mail-tests/${encodeURIComponent(messageId)}/refresh-request`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken }),
  }),
  planMailboxTestRefresh: (organizationId: string, messageId: string, confirmationToken: string): Promise<MailboxTestRefreshPlan> => request(`/api/organizations/${encodeURIComponent(organizationId)}/mail-tests/${encodeURIComponent(messageId)}/refresh-plan`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken }),
  }),
  applyMailboxTestRefresh: (organizationId: string, confirmationToken: string, candidateIndexes: number[]): Promise<MailboxTestRefreshOutcome> => request(`/api/organizations/${encodeURIComponent(organizationId)}/mail-tests/refresh`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken, candidateIndexes }),
  }),
  runAutomation: (organizationId: string): Promise<AutomationSummary> => request(`/api/organizations/${encodeURIComponent(organizationId)}/automation/run`, { method: 'POST' }),
  setEnabled: (organizationId: string, enabled: boolean): Promise<{ enabled: boolean }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/automation/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  logout: (): Promise<{ loggedOut: boolean }> => request('/api/auth/logout', { method: 'POST' }),
};

import type { AppState } from '@mail/domain';

interface ApiResult<T> {
  data: T;
}

interface ApiFailure {
  error?: { message?: string };
}

export interface AutomationStatus {
  email: string;
  displayName: string;
  enabled: boolean;
  status: 'active' | 'reauthentication_required' | 'disconnected';
  lastSyncedAt: string | null;
  lastError: string | null;
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

export interface OrganizationMembership {
  organizationId: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
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
  id: string; title: string; deadline: string; assigneeRoleId: string; assigneeRoleName: string; assigneeIdentityId: string | null; assigneeName: string; sourceMessageSubject: string; description: string; remarks: string; completed: boolean; completedAt: string | null;
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

export interface OperationalTaskRole { id: string; displayName: string; description: string; }
export interface TaskRoleAssignment { roleId: string; identityId: string; displayName: string; }
export interface TaskRoleConfiguration { members: Array<{ identityId: string; displayName: string }>; roles: OperationalTaskRole[]; assignments: TaskRoleAssignment[]; }

/** The OpenAI-compatible JSON body prepared for review; credentials are never included. */
export interface MailboxTestAiRequest extends MailboxTestMatch {
  request: Record<string, unknown>;
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
  if (!response.ok) throw new Error(body?.error?.message ?? 'サービスに接続できませんでした。時間をおいて画面を再読み込みしてください。');
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
  assignOrganizationTaskRole: (organizationId: string, roleId: string, identityId: string): Promise<TaskRoleAssignment> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-roles/${encodeURIComponent(roleId)}/assignment`, { method: 'PUT', body: JSON.stringify({ identityId }) }),
  updateOrganizationTask: (organizationId: string, taskId: string, input: { completed?: boolean; remarks?: string }): Promise<OrganizationTask> => request(`/api/organizations/${encodeURIComponent(organizationId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
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
  runAutomation: (organizationId: string): Promise<AutomationSummary> => request(`/api/organizations/${encodeURIComponent(organizationId)}/automation/run`, { method: 'POST' }),
  setEnabled: (organizationId: string, enabled: boolean): Promise<{ enabled: boolean }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/automation/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  logout: (): Promise<{ loggedOut: boolean }> => request('/api/auth/logout', { method: 'POST' }),
};

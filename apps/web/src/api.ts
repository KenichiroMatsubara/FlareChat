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
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationRuleInput {
  name: string;
  state: 'draft' | 'active';
  selectionPolicy?: Record<string, unknown>;
  routingPolicy?: Record<string, unknown>;
  priority?: number;
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
  events: Array<{
    title: string;
    startsAt: string;
    endsAt: string;
    timeZone: string;
    location: string;
    description: string;
  }>;
  tasks: Array<{
    title: string;
    deadline: string;
    assigneeRole: 'organizer' | 'treasurer';
    description: string;
  }>;
  confirmationToken: string;
  expiresAt: string;
}

export interface OrganizationTask {
  id: string; title: string; deadline: string; assigneeRole: 'organizer' | 'treasurer'; assigneeIdentityId: string | null; assigneeName: string; sourceMessageSubject: string; description: string; remarks: string; completed: boolean; completedAt: string | null;
}

export interface TaskRoleAssignment { role: 'organizer' | 'treasurer'; identityId: string; displayName: string; }
export interface TaskRoleConfiguration { members: Array<{ identityId: string; displayName: string }>; assignments: TaskRoleAssignment[]; }

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
  confirmOnboarding: (name: string): Promise<{ accepted: boolean }> =>
    request('/api/onboarding/confirm', { method: 'POST', body: JSON.stringify({ name }) }),
  retryOnboarding: (): Promise<{ accepted: boolean }> => request('/api/onboarding/retry', { method: 'POST' }),
  cancelOnboarding: (): Promise<{ cancelled: boolean }> => request('/api/onboarding', { method: 'DELETE' }),
  currentAutomation,
  organizationDashboard: (organizationId: string): Promise<OrganizationDashboard> => request(`/api/organizations/${encodeURIComponent(organizationId)}/dashboard`),
  organizationRules: (organizationId: string): Promise<OrganizationRule[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/rules`),
  organizationDeliveryAudit: (organizationId: string): Promise<DeliveryAuditRecord[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/audit/deliveries`),
  organizationTasks: (organizationId: string): Promise<OrganizationTask[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/tasks`),
  organizationTaskRoles: (organizationId: string): Promise<TaskRoleConfiguration> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-roles`),
  assignOrganizationTaskRole: (organizationId: string, role: 'organizer' | 'treasurer', identityId: string): Promise<TaskRoleAssignment> => request(`/api/organizations/${encodeURIComponent(organizationId)}/task-roles/${role}`, { method: 'PUT', body: JSON.stringify({ identityId }) }),
  updateOrganizationTask: (organizationId: string, taskId: string, input: { completed?: boolean; remarks?: string }): Promise<OrganizationTask> => request(`/api/organizations/${encodeURIComponent(organizationId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  createOrganizationRule: (organizationId: string, input: OrganizationRuleInput): Promise<OrganizationRule> => request(`/api/organizations/${encodeURIComponent(organizationId)}/rules`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  organizationConnections: (organizationId: string): Promise<OrganizationConnections> => request(`/api/organizations/${encodeURIComponent(organizationId)}/connections`),
  saveOrganizationConnections: (organizationId: string, input: {
    line: { channelAccessToken?: string | undefined; channelSecret?: string | undefined };
    ai: {
      apiKey?: string | undefined;
      model?: string | undefined;
      baseUrl?: string | undefined;
    };
  }): Promise<OrganizationConnections> => request(`/api/organizations/${encodeURIComponent(organizationId)}/connections`, {
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

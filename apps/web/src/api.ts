import type { OrganizationSetup, PasskeyCreationOptions } from '@mail/domain';

interface ApiResult<T> {
  data: T;
}

export interface AutomationStatus {
  email: string;
  displayName: string;
  enabled: boolean;
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
    provider: string;
    model: string;
    baseUrl: string;
    authMode: string;
    gcpProjectId: string;
    gcpLocation: string;
    oauthConfigured: boolean;
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

export interface PasskeyAuthenticationOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: 'required';
  allowCredentials: Array<{ type: 'public-key'; id: string }>;
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = (await response.json()) as ApiResult<T> & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? '操作に失敗しました。');
  return body.data;
};

const currentAutomation = async (): Promise<AutomationStatus | null> => {
  const response = await fetch('/api/automation', { credentials: 'include' });
  if (response.status === 401) return null;
  const body = (await response.json()) as ApiResult<AutomationStatus | null> & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? '状態を取得できませんでした。');
  return body.data;
};

const currentMember = async (): Promise<AuthMe | null> => {
  const response = await fetch('/api/auth/me', { credentials: 'include' });
  if (response.status === 401) return null;
  const body = (await response.json()) as ApiResult<AuthMe> & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? 'ユーザー情報を取得できませんでした。');
  return body.data;
};

export const api = {
  startOrganizationSetup: (name: string): Promise<{ authorizationUrl: string }> => request('/api/setup', { method: 'POST', body: JSON.stringify({ name }) }),
  currentOrganizationSetup: (): Promise<OrganizationSetup | null> => request('/api/setup/current'),
  setupPasskeyOptions: (ownerEmail: string): Promise<PasskeyCreationOptions> => request('/api/setup/passkey/options', { method: 'POST', body: JSON.stringify({ ownerEmail }) }),
  verifySetupPasskey: (credential: unknown): Promise<OrganizationSetup> => request('/api/setup/passkey/verify', { method: 'POST', body: JSON.stringify(credential) }),
  googleLogin: (): Promise<{ authorizationUrl: string }> => request('/api/auth/google', { method: 'POST' }),
  passkeyOptions: (email: string): Promise<PasskeyAuthenticationOptions> => request('/api/auth/passkey/options', { method: 'POST', body: JSON.stringify({ email }) }),
  verifyPasskey: (credential: unknown): Promise<{ authenticated: boolean }> => request('/api/auth/passkey/verify', { method: 'POST', body: JSON.stringify(credential) }),
  currentAutomation,
  currentMember,
  organizationDashboard: (organizationId: string): Promise<OrganizationDashboard> => request(`/api/organizations/${encodeURIComponent(organizationId)}/dashboard`),
  organizationRules: (organizationId: string): Promise<OrganizationRule[]> => request(`/api/organizations/${encodeURIComponent(organizationId)}/rules`),
  createOrganizationRule: (organizationId: string, input: { name: string; state: 'draft' | 'active' }): Promise<OrganizationRule> => request(`/api/organizations/${encodeURIComponent(organizationId)}/rules`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  organizationConnections: (organizationId: string): Promise<OrganizationConnections> => request(`/api/organizations/${encodeURIComponent(organizationId)}/connections`),
  saveOrganizationConnections: (organizationId: string, input: {
    line: { channelAccessToken?: string | undefined; channelSecret?: string | undefined };
    ai: {
      provider?: string | undefined;
      apiKey?: string | undefined;
      model?: string | undefined;
      baseUrl?: string | undefined;
      authMode?: string | undefined;
      gcpProjectId?: string | undefined;
      gcpLocation?: string | undefined;
    };
  }): Promise<OrganizationConnections> => request(`/api/organizations/${encodeURIComponent(organizationId)}/connections`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),
  testGeminiConnection: (organizationId: string, prompt: string): Promise<{ text: string; model: string }> => request(`/api/organizations/${encodeURIComponent(organizationId)}/connections/gemini/test`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  }),
  runAutomation: (): Promise<AutomationSummary> => request('/api/automation/run', { method: 'POST' }),
  setEnabled: (enabled: boolean): Promise<{ enabled: boolean }> => request('/api/automation/enabled', { method: 'POST', body: JSON.stringify({ enabled }) }),
  logout: (): Promise<{ loggedOut: boolean }> => request('/api/auth/logout', { method: 'POST' }),
};

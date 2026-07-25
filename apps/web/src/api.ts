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

export const api = {
  googleLogin: (): Promise<{ authorizationUrl: string }> => request('/api/auth/google', { method: 'POST' }),
  currentAutomation,
  runAutomation: (): Promise<AutomationSummary> => request('/api/automation/run', { method: 'POST' }),
  setEnabled: (enabled: boolean): Promise<{ enabled: boolean }> => request('/api/automation/enabled', { method: 'POST', body: JSON.stringify({ enabled }) }),
  logout: (): Promise<{ loggedOut: boolean }> => request('/api/auth/logout', { method: 'POST' }),
};

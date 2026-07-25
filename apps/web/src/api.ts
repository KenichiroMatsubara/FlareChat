import type {
  ApiResult,
  AutomationRule,
  Dashboard,
  ListItem,
  ListKind,
  Organization,
  ScheduledEvent,
  TypedList,
} from '@mail/domain';

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = (await response.json()) as ApiResult<T> & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? '操作に失敗しました。');
  return body.data;
};

export const api = {
  organizations: (): Promise<Organization[]> => request('/api/organizations'),
  createOrganization: (name: string, inboxAddress: string): Promise<Organization> =>
    request('/api/organizations', {
      method: 'POST',
      body: JSON.stringify({ name, inboxAddress }),
    }),
  dashboard: (organizationId: string): Promise<Dashboard> =>
    request(`/api/dashboard/${organizationId}`),
  lists: (organizationId: string): Promise<TypedList[]> =>
    request(`/api/lists/${organizationId}`),
  createList: (
    organizationId: string,
    kind: ListKind,
    name: string,
    description: string,
  ): Promise<TypedList> =>
    request('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ organizationId, kind, name, description }),
    }),
  deleteList: (id: string): Promise<{ deleted: boolean }> =>
    request(`/api/lists/${id}`, { method: 'DELETE' }),
  items: (listId: string): Promise<ListItem[]> => request(`/api/lists/${listId}/items`),
  createItem: (listId: string, value: string, label: string): Promise<ListItem> =>
    request(`/api/lists/${listId}/items`, {
      method: 'POST',
      body: JSON.stringify({ value, label }),
    }),
  deleteItem: (id: string): Promise<{ deleted: boolean }> =>
    request(`/api/items/${id}`, { method: 'DELETE' }),
  rules: (organizationId: string): Promise<AutomationRule[]> =>
    request(`/api/rules/${organizationId}`),
  createRule: (input: {
    organizationId: string;
    name: string;
    sourceListId: string | null;
    recipientListId: string | null;
    lineListId: string | null;
    scheduleMinutes: number;
    requireAttendance: boolean;
    deadlineDaysBefore: number | null;
  }): Promise<AutomationRule> =>
    request('/api/rules', { method: 'POST', body: JSON.stringify(input) }),
  ruleStatus: (id: string, status: AutomationRule['status']): Promise<{ updated: boolean }> =>
    request(`/api/rules/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  events: (organizationId: string): Promise<ScheduledEvent[]> =>
    request(`/api/events/${organizationId}`),
  run: (organizationId: string): Promise<{ jobId: string }> =>
    request(`/api/automation/${organizationId}/run`, { method: 'POST' }),
  exceptions: (): Promise<ExceptionRow[]> => request('/api/exceptions'),
};

export interface ExceptionRow {
  id: string;
  code: string;
  message: string;
  state: string;
  created_at: string;
}

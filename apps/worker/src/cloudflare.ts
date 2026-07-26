import type { Bindings } from './types';

interface CloudflareResponse<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
}

interface D1DatabaseResult {
  uuid?: string;
}

export interface D1QueryResult<T> {
  success?: boolean;
  results?: T[];
  meta?: Record<string, number | boolean | string | null>;
}

interface WorkerSettings {
  bindings?: Array<Record<string, unknown>>;
}

const api = async <T>(env: Bindings, path: string, init?: RequestInit): Promise<T> => {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Cloudflare D1 credentials are not configured.');
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await response.json() as CloudflareResponse<T>;
  if (!response.ok || !body.success || body.result === undefined) {
    throw new Error(body.errors?.[0]?.message ?? 'Cloudflare control-plane request failed.');
  }
  return body.result;
};

export const createD1Database = async (env: Bindings, name: string): Promise<string> => {
  const result = await api<D1DatabaseResult>(env, '/d1/database', {
    method: 'POST',
    body: JSON.stringify({ name, primary_location_hint: 'apac', read_replication: { mode: 'disabled' } }),
  });
  if (!result.uuid) throw new Error('Cloudflare did not return a D1 database identifier.');
  return result.uuid;
};

export const executeD1 = async (env: Bindings, databaseId: string, sql: string): Promise<void> => {
  await api<unknown>(env, `/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
};

export const queryD1 = async <T>(env: Bindings, databaseId: string, sql: string, params: unknown[]): Promise<D1QueryResult<T>> => {
  const result = await api<D1QueryResult<T>[]>(env, `/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql, params }),
  });
  const query = result[0];
  if (!query?.success) throw new Error('Organization D1 query failed.');
  return query;
};

export const attachD1Binding = async (
  env: Bindings,
  bindingName: string,
  databaseId: string,
): Promise<void> => {
  if (!env.CLOUDFLARE_WORKER_NAME) throw new Error('Cloudflare Worker name is not configured.');
  const script = encodeURIComponent(env.CLOUDFLARE_WORKER_NAME);
  const settings = await api<WorkerSettings>(env, `/workers/scripts/${script}/settings`);
  const bindings = (settings.bindings ?? []).filter((binding) => binding.name !== bindingName);
  bindings.push({ name: bindingName, type: 'd1', database_id: databaseId });
  await api<WorkerSettings>(env, `/workers/scripts/${script}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ bindings }),
  });
};

export const verifyD1Schema = async (env: Bindings, databaseId: string): Promise<void> => {
  await executeD1(env, databaseId, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'google_connections'");
};

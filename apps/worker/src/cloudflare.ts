import type { Bindings } from './types';

interface CloudflareResponse<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
}

interface D1DatabaseResult {
  uuid?: string;
  name?: string;
}

interface D1QueryResult<T> {
  success?: boolean;
  results?: T[];
  meta?: Record<string, number | boolean | string | null>;
}

interface D1Query {
  sql: string;
  params: unknown[];
}

interface WorkerSettings {
  bindings?: Array<{ name?: unknown }>;
}

type WorkerBindingUpdate =
  | { name: string; type: 'inherit' }
  | { name: string; type: 'd1'; database_id: string };

interface RemoteQuery {
  sql: string;
  params: unknown[];
}

export type CloudflareFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareControlPlane {
  ensureDatabase(name: string): Promise<string>;
  openDatabase(databaseId: string): D1Database;
  attachDatabase(bindingName: string, databaseId: string): Promise<void>;
}

const REMOTE_QUERY = Symbol('remote-query');

/**
 * Owns Cloudflare control-plane transport details. Callers use D1 operations
 * and never select URLs, authentication headers, or request encodings.
 */
export const cloudflareControlPlane = (
  env: Bindings,
  fetcher: CloudflareFetch = fetch,
): CloudflareControlPlane => {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Cloudflare D1 credentials are not configured.');
  }

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`,
      { ...init, headers },
    );
    const body = await response.json() as CloudflareResponse<T>;
    if (!response.ok || !body.success || body.result === undefined) {
      throw new Error(body.errors?.[0]?.message ?? 'Cloudflare control-plane request failed.');
    }
    return body.result;
  };

  const jsonRequest = <T>(
    path: string,
    method: 'POST',
    body: unknown,
  ): Promise<T> => request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const queryDatabase = async <T>(
    databaseId: string,
    sql: string,
    params: unknown[],
  ): Promise<D1QueryResult<T>> => {
    const result = await jsonRequest<D1QueryResult<T>[]>(
      `/d1/database/${databaseId}/query`,
      'POST',
      { sql, params },
    );
    const query = result[0];
    if (!query?.success) throw new Error('Organization D1 query failed.');
    return query;
  };

  const queryDatabaseBatch = async <T>(
    databaseId: string,
    queries: D1Query[],
  ): Promise<D1QueryResult<T>[]> => {
    const results = await jsonRequest<D1QueryResult<T>[]>(
      `/d1/database/${databaseId}/query`,
      'POST',
      { batch: queries },
    );
    if (results.some((result) => !result.success)) throw new Error('Organization D1 batch failed.');
    return results;
  };

  const remoteStatement = (
    databaseId: string,
    sql: string,
    params: unknown[] = [],
  ): D1PreparedStatement => {
    const execute = async (): Promise<{
      results: unknown[];
      meta: Record<string, number | boolean | string | null>;
    }> => {
      const result = await queryDatabase<unknown>(databaseId, sql, params);
      return { results: result.results ?? [], meta: result.meta ?? {} };
    };
    return {
      [REMOTE_QUERY]: { sql, params },
      bind: (...values: unknown[]) => remoteStatement(databaseId, sql, values),
      first: async <T>(column?: string): Promise<T | null> => {
        const row = (await execute()).results[0];
        if (!row || typeof row !== 'object') return null;
        return (column ? (row as Record<string, T>)[column] : row) as T;
      },
      all: async <T>(): Promise<D1Result<T>> => {
        const result = await execute();
        return { success: true, results: result.results as T[], meta: result.meta as D1Result<T>['meta'] };
      },
      run: async <T>(): Promise<D1Result<T>> => {
        const result = await execute();
        return { success: true, results: result.results as T[], meta: result.meta as D1Result<T>['meta'] };
      },
      raw: async <T>(): Promise<T[][]> => (await execute()).results as T[][],
    } as unknown as D1PreparedStatement;
  };

  const openDatabase = (databaseId: string): D1Database => ({
    prepare: (sql: string) => remoteStatement(databaseId, sql),
    batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      const queries = statements.map((statement) => {
        const query = (statement as unknown as { [REMOTE_QUERY]?: RemoteQuery })[REMOTE_QUERY];
        if (!query) throw new Error('Remote Organization D1 received an unsupported prepared statement.');
        return query;
      });
      const results = await queryDatabaseBatch<T>(databaseId, queries);
      return results.map((result) => ({
        success: true,
        results: result.results ?? [],
        meta: (result.meta ?? {}) as D1Result<T>['meta'],
      }));
    },
  } as unknown as D1Database);

  const createDatabase = async (name: string): Promise<string> => {
    const result = await jsonRequest<D1DatabaseResult>('/d1/database', 'POST', {
      name,
      primary_location_hint: 'apac',
      read_replication: { mode: 'disabled' },
    });
    if (!result.uuid) throw new Error('Cloudflare did not return a D1 database identifier.');
    return result.uuid;
  };

  const findDatabase = async (name: string): Promise<string | null> => {
    const databases = await request<D1DatabaseResult[]>(
      `/d1/database?name=${encodeURIComponent(name)}&per_page=100`,
    );
    const matches = databases.filter((database) => database.name === name && database.uuid);
    if (matches.length > 1) {
      throw new Error(`Multiple Cloudflare D1 databases have the deterministic name ${name}.`);
    }
    return matches[0]?.uuid ?? null;
  };

  const ensureDatabase = async (name: string): Promise<string> => {
    const existing = await findDatabase(name);
    if (existing) return existing;
    try {
      return await createDatabase(name);
    } catch (error) {
      // A concurrent retry may have created the deterministic database after
      // our lookup. Resolve it by name before surfacing the create failure.
      const raced = await findDatabase(name);
      if (raced) return raced;
      throw error;
    }
  };

  const attachDatabase = async (bindingName: string, databaseId: string): Promise<void> => {
    if (!env.CLOUDFLARE_WORKER_NAME) throw new Error('Cloudflare Worker name is not configured.');
    const script = encodeURIComponent(env.CLOUDFLARE_WORKER_NAME);
    const settings = await request<WorkerSettings>(`/workers/scripts/${script}/settings`);
    const bindings: WorkerBindingUpdate[] = (settings.bindings ?? [])
      .map(({ name }) => name)
      .filter((name): name is string => typeof name === 'string' && name !== bindingName)
      .map((name) => ({ name, type: 'inherit' as const }));
    bindings.push({
      name: bindingName,
      type: 'd1',
      database_id: databaseId,
    });
    const form = new FormData();
    form.set('settings', JSON.stringify({ bindings }));
    await request<WorkerSettings>(`/workers/scripts/${script}/settings`, {
      method: 'PATCH',
      body: form,
    });
  };

  return {
    ensureDatabase,
    openDatabase,
    attachDatabase,
  };
};

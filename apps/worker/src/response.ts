import { Hono, type Context } from 'hono';

import { isRefusal } from './refusal';
import { SchemaReadinessError } from './schema-lifecycle';
import type { Bindings } from './types';

export const json = <T>(context: Context, data: T, status: 200 | 201 = 200): Response =>
  context.json({ data }, status);

/**
 * The one place a thrown refusal becomes a response (ADR 0169). A refusal
 * answers with its status and code; a schema that is not ready answers 503
 * with what an operator needs; anything else is unexpected and says so.
 */
export const respondToError = (error: Error, context: Context<{ Bindings: Bindings }>): Response => {
  if (isRefusal(error)) return context.json({ error: { code: error.code, message: error.message } }, error.status);
  const requestId = context.req.header('cf-ray') ?? crypto.randomUUID();
  if (error instanceof SchemaReadinessError) {
    console.error(JSON.stringify({
      event: 'schema_not_ready',
      requestId,
      category: error.category,
      databaseKind: error.kind,
      databaseId: error.databaseId,
      bindingName: error.bindingName,
      currentMigration: error.currentMigration,
      expectedMigration: error.expectedMigration,
      message: error.message,
    }));
    return context.json({
      error: {
        code: 'schema_not_ready',
        message: error.message,
        category: error.category,
        databaseKind: error.kind,
        databaseId: error.databaseId,
        bindingName: error.bindingName,
        currentMigration: error.currentMigration,
        expectedMigration: error.expectedMigration,
        requestId,
      },
    }, 503);
  }
  console.error(error);
  return context.json({ error: { code: 'unexpected', message: 'サーバーで予期しないエラーが発生しました。' } }, 500);
};

/** One resource's routes, answering refusals the same way whether mounted or reached directly. */
export const resource = (): Hono<{ Bindings: Bindings }> => {
  const routes = new Hono<{ Bindings: Bindings }>();
  routes.onError(respondToError);
  return routes;
};

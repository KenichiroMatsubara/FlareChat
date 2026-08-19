import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';

import { failure, json } from '../response';
import { createRequestContext } from './request-context';
import type { Bindings } from '../types';
import { accountDatabase } from '../storage/database';
import { listItems, lists } from '../storage/account-schema';

export const typedListRoutes = new Hono<{ Bindings: Bindings }>();
const now = (): string => new Date().toISOString();

typedListRoutes.get('/organizations/:accountId/lists', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const rows = await accountDatabase(access.database).select().from(lists).orderBy(asc(lists.name)).all();
    return json(context, rows.map((row) => ({ ...row, accountId: access.account.id })));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Typed Lists could not be loaded.', 403);
  }
});

typedListRoutes.post('/organizations/:accountId/lists', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ kind?: string; name?: string; description?: string }>();
    const kind = input.kind?.trim() as 'source' | 'recipient' | 'line' | undefined;
    const name = input.name?.trim();
    if (!kind || !['source', 'recipient', 'line'].includes(kind)) return failure(context, 'Unsupported Typed List kind.');
    if (!name) return failure(context, 'Typed List name is required.');
    const timestamp = now();
    const row = { id: crypto.randomUUID(), accountId: access.account.id, kind, name, description: input.description?.trim() ?? '', createdAt: timestamp, updatedAt: timestamp };
    await accountDatabase(access.database).insert(lists).values(row).run();
    return json(context, row, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Typed List could not be created.', 409);
  }
});

typedListRoutes.post('/organizations/:accountId/lists/:listId/items', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ value?: string; label?: string }>();
    const value = input.value?.trim();
    if (!value) return failure(context, 'List Item value is required.');
    const row = { id: crypto.randomUUID(), listId: context.req.param('listId'), value, label: input.label?.trim() ?? '', enabled: true };
    await accountDatabase(access.database).insert(listItems).values(row).run();
    return json(context, row, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'List Item could not be created.', 409);
  }
});

typedListRoutes.patch('/organizations/:accountId/lists/:listId/items/:itemId', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ enabled?: boolean }>();
    if (typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const updated = await accountDatabase(access.database).update(listItems).set({ enabled: input.enabled })
      .where(and(eq(listItems.id, context.req.param('itemId')), eq(listItems.listId, context.req.param('listId')))).returning({ id: listItems.id }).get();
    if (!updated) return failure(context, 'List Item was not found.', 404);
    return json(context, { id: context.req.param('itemId'), enabled: input.enabled });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'List Item could not be updated.', 409);
  }
});

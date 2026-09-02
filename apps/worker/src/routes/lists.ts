import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ContactList, TypedList } from '@mail/domain';

import { now } from '../clock';
import { invalid, notFound } from '../refusal';
import { resource } from '../response';
import { contactListMembers, contactLists, listItems, lists } from '../storage/account-schema';
import { accountRoute, created, type Created } from './account';

/** Typed Lists (source, recipient, line) and Contact Lists. */
export const listRoutes = resource();

type ListKind = 'source' | 'recipient' | 'line';
const LIST_KINDS: readonly ListKind[] = ['source', 'recipient', 'line'];

listRoutes.get('/organizations/:accountId/lists', accountRoute(async ({ db, accountId }): Promise<TypedList[]> => {
  const rows = await db.select().from(lists).orderBy(asc(lists.name)).all();
  return rows.map((row) => ({ ...row, accountId }));
}));

listRoutes.post('/organizations/:accountId/lists', accountRoute<{ kind?: string; name?: string; description?: string }>(async ({ db, accountId, body }): Promise<Created<TypedList>> => {
  const kind = body.kind?.trim() as ListKind | undefined;
  const name = body.name?.trim();
  if (!kind || !LIST_KINDS.includes(kind)) throw invalid('Unsupported Typed List kind.');
  if (!name) throw invalid('Typed List name is required.');
  const timestamp = now();
  const row = { id: crypto.randomUUID(), accountId, kind, name, description: body.description?.trim() ?? '', createdAt: timestamp, updatedAt: timestamp };
  await db.insert(lists).values(row).run();
  return created(row);
}));

listRoutes.post('/organizations/:accountId/lists/:listId/items', accountRoute<{ value?: string; label?: string }>(async ({ db, body, params }) => {
  const value = body.value?.trim();
  if (!value) throw invalid('List Item value is required.');
  const row = { id: crypto.randomUUID(), listId: params.listId ?? '', value, label: body.label?.trim() ?? '', enabled: true };
  await db.insert(listItems).values(row).run();
  return created(row);
}));

listRoutes.patch('/organizations/:accountId/lists/:listId/items/:itemId', accountRoute<{ enabled?: boolean }>(async ({ db, body, params }) => {
  if (typeof body.enabled !== 'boolean') throw invalid('enabled must be a boolean.');
  const itemId = params.itemId ?? '';
  const updated = await db.update(listItems).set({ enabled: body.enabled })
    .where(and(eq(listItems.id, itemId), eq(listItems.listId, params.listId ?? ''))).returning({ id: listItems.id }).get();
  if (!updated) throw notFound('List Item was not found.');
  return { id: itemId, enabled: body.enabled };
}));

listRoutes.get('/organizations/:accountId/contact-lists', accountRoute(async ({ db }): Promise<ContactList[]> => {
  const rows = await db.select().from(contactLists).orderBy(asc(contactLists.name)).all();
  const memberships = rows.length
    ? await db.select().from(contactListMembers).where(inArray(contactListMembers.listId, rows.map(({ id }) => id))).all()
    : [];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    contactIds: memberships.flatMap((entry) => entry.listId === row.id ? [entry.contactId] : []),
  }));
}));

listRoutes.put('/organizations/:accountId/contact-lists/:listId', accountRoute<{ name?: string; description?: string; contactIds?: unknown }>(async ({ db, accountId, body, params }) => {
  const listId = params.listId ?? '';
  const name = body.name?.trim() ?? '';
  if (!name || name.length > 60) throw invalid('Contact List 名は 1〜60 文字で入力してください。');
  const contactIds = Array.isArray(body.contactIds) ? body.contactIds.filter((id): id is string => typeof id === 'string') : [];
  const description = body.description?.trim() ?? '';
  const timestamp = now();
  await db.insert(contactLists).values({ id: listId, accountId, name, description, createdAt: timestamp, updatedAt: timestamp })
    .onConflictDoUpdate({ target: contactLists.id, set: { name, description, updatedAt: timestamp } }).run();
  await db.delete(contactListMembers).where(eq(contactListMembers.listId, listId)).run();
  for (const contactId of contactIds) {
    await db.insert(contactListMembers).values({ listId, contactId }).onConflictDoNothing().run();
  }
  return { id: listId, name, contactIds };
}));

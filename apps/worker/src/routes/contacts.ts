import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { Contact, LineHandle } from '@mail/domain';
import { displayLineDestinationId } from '@mail/domain';

import { expiresIn, now } from '../clock';
import { randomToken } from '../encoding';
import { conflict, invalid, notFound } from '../refusal';
import { resource } from '../response';
import { exportContactCsv, previewContactCsv } from '../roster';
import {
  connections,
  contactLineDestinations,
  contactLinkTokens,
  contacts,
  eventRecipients,
  lineDestinations,
  portalInvitations,
  tasks,
} from '../storage/account-schema';
import type { AccountDatabase } from '../storage/database';
import { accountRoute, created, type Created, type RouteResult } from './account';

export const contactRoutes = resource();

const CONTACT_LINK_WINDOW_MS = 15 * 60 * 1_000;
export const LINE_DESTINATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

type LineKind = 'user' | 'group' | 'room';
const lineKindOf = (value: unknown): LineKind => value === 'group' || value === 'room' ? value : 'user';

const tagsOf = (value: unknown): string[] => {
  const tags = value === undefined ? [] : value;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !tag.trim())) throw invalid('Contact tags must be non-empty strings.');
  return tags.map((tag) => String(tag).trim());
};

const appUrl = (env: { APP_URL: string }): string => env.APP_URL.replace(/\/$/u, '');

/**
 * An email address belongs to at most one Contact (`members_email_unique`).
 * Said here, as a refusal the screen can show, rather than left for D1 to say
 * as a constraint failure nobody can read.
 */
const refuseEmailInUse = async (db: AccountDatabase, email: string, exceptContactId = ''): Promise<void> => {
  if (!email) return;
  const holder = await db.select({ id: contacts.id, name: contacts.name }).from(contacts)
    .where(and(eq(contacts.email, email), ne(contacts.id, exceptContactId))).get();
  if (holder) throw conflict(`このメールアドレスは既に「${holder.name}」に登録されています。`);
};

contactRoutes.get('/organizations/:accountId/members', accountRoute(async ({ db, accountId }): Promise<Contact[]> => {
  const rows = await db.select({
    id: contacts.id,
    name: contacts.name,
    email: contacts.email,
    state: contacts.state,
    description: contacts.description,
    tags: contacts.tags,
    createdAt: contacts.createdAt,
    updatedAt: contacts.updatedAt,
    lineDestinationRowId: lineDestinations.id,
    lineDestinationId: lineDestinations.destinationId,
    lineDisplayName: lineDestinations.displayName,
    lineKind: lineDestinations.kind,
    lineStatus: lineDestinations.status,
    lineSource: lineDestinations.source,
  }).from(contacts)
    .leftJoin(contactLineDestinations, eq(contactLineDestinations.contactId, contacts.id))
    .leftJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
    .orderBy(asc(contacts.name)).all();
  const roster = new Map<string, {
    id: string;
    accountId: string;
    name: string;
    email: string;
    state: 'active' | 'inactive';
    description: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    lineDestinations: Array<{
      id: string;
      destinationId: string;
      displayName: string;
      kind: LineKind;
      status: 'discovered' | 'disabled';
      source: 'webhook' | 'manual';
    }>;
  }>();
  for (const row of rows) {
    const contact = roster.get(row.id) ?? {
      id: row.id,
      accountId,
      name: row.name,
      email: row.email,
      state: row.state,
      description: row.description,
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lineDestinations: [],
    };
    if (row.lineDestinationRowId && row.lineDestinationId && row.lineKind && row.lineStatus) {
      contact.lineDestinations.push({
        id: row.lineDestinationRowId,
        destinationId: displayLineDestinationId(row.lineDestinationId),
        displayName: row.lineDisplayName ?? '',
        kind: row.lineKind,
        status: row.lineStatus,
        source: row.lineSource ?? 'webhook',
      });
    }
    roster.set(row.id, contact);
  }
  return [...roster.values()];
}));

contactRoutes.get('/organizations/:accountId/members/export', accountRoute(async ({ db }) => {
  const rows = await db.select({ name: contacts.name, email: contacts.email }).from(contacts)
    .where(eq(contacts.state, 'active')).orderBy(asc(contacts.name)).all();
  return new Response(exportContactCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="members.csv"' } });
}));

contactRoutes.post('/organizations/:accountId/members', accountRoute<{ name?: string; email?: string; description?: string; tags?: unknown; lineDestinationId?: string }>(async ({ db, accountId, body }): Promise<Created<Contact>> => {
  const name = body.name?.trim();
  const email = body.email?.trim().toLowerCase() ?? '';
  if (!name) throw invalid('Contact name is required.');
  if (email && !email.includes('@')) throw invalid('Contact email address must be valid when provided.');
  await refuseEmailInUse(db, email);
  const tags = tagsOf(body.tags);
  const requestedLineDestinationId = body.lineDestinationId?.trim();
  const lineDestination = requestedLineDestinationId
    ? await db.select({
      id: lineDestinations.id,
      destinationId: lineDestinations.destinationId,
      displayName: lineDestinations.displayName,
      kind: lineDestinations.kind,
      status: lineDestinations.status,
      source: lineDestinations.source,
    }).from(lineDestinations)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(
        eq(lineDestinations.id, requestedLineDestinationId),
        eq(lineDestinations.status, 'discovered'),
        isNull(contactLineDestinations.contactId),
      )).get()
    : null;
  if (requestedLineDestinationId && !lineDestination) throw conflict('The LINE Destination is unavailable or already assigned.');
  const id = crypto.randomUUID();
  const timestamp = now();
  const description = body.description?.trim() ?? '';
  const contactInsert = db.insert(contacts).values({
    id, accountId, name, email, state: 'active', description, tags: JSON.stringify(tags), createdAt: timestamp, updatedAt: timestamp,
  });
  if (lineDestination) {
    await db.batch([
      contactInsert,
      db.insert(contactLineDestinations).values({ contactId: id, lineDestinationId: lineDestination.id, createdAt: timestamp }),
    ]);
  } else {
    await contactInsert.run();
  }
  return created({
    id, accountId, name, email, state: 'active', description, tags, createdAt: timestamp, updatedAt: timestamp,
    lineDestinations: lineDestination ? [{ ...lineDestination, destinationId: displayLineDestinationId(lineDestination.destinationId) }] : [],
  });
}));

contactRoutes.patch('/organizations/:accountId/members/:contactId', accountRoute<{ name?: string; email?: string; description?: string; tags?: unknown; state?: string }>(async ({ db, body, params }) => {
  const updates: Partial<typeof contacts.$inferInsert> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw invalid('Contact name cannot be empty.');
    updates.name = name;
  }
  if (body.email !== undefined) {
    const email = body.email.trim().toLowerCase();
    if (email && !email.includes('@')) throw invalid('Contact email address must be valid when provided.');
    updates.email = email;
  }
  if (body.description !== undefined) updates.description = body.description.trim();
  const tags = body.tags === undefined ? undefined : tagsOf(body.tags);
  if (tags !== undefined) updates.tags = JSON.stringify(tags);
  if (body.state !== undefined) {
    if (!['active', 'inactive'].includes(body.state)) throw invalid('Unsupported Contact state.');
    updates.state = body.state as 'active' | 'inactive';
  }
  if (Object.keys(updates).length === 0) throw invalid('At least one Contact field is required.');
  const contactId = params.contactId ?? '';
  if (updates.email) await refuseEmailInUse(db, updates.email, contactId);
  const updated = await db.update(contacts).set({ ...updates, updatedAt: now() }).where(eq(contacts.id, contactId)).returning({ id: contacts.id }).get();
  if (!updated) throw notFound('Contact was not found.');
  return {
    id: contactId,
    ...(updates.name === undefined ? {} : { name: updates.name }),
    ...(updates.email === undefined ? {} : { email: updates.email }),
    ...(updates.description === undefined ? {} : { description: updates.description }),
    ...(tags === undefined ? {} : { tags }),
    ...(updates.state === undefined ? {} : { state: updates.state }),
  };
}));

/**
 * Removing a Contact. Its handles, tokens, attendance, and list memberships go
 * with it; a Task it held keeps the name it was created with (ADR 0161); a LINE
 * Destination the webhook discovered returns to the pool, and one entered by
 * hand goes, as when it is unlinked.
 */
contactRoutes.delete('/organizations/:accountId/members/:contactId', accountRoute(async ({ db, params }) => {
  const contactId = params.contactId ?? '';
  const contact = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).get();
  if (!contact) throw notFound('Contact was not found.');
  const manualHandles = await db.select({ id: lineDestinations.id }).from(lineDestinations)
    .innerJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
    .where(and(eq(contactLineDestinations.contactId, contactId), eq(lineDestinations.source, 'manual'))).all();
  await db.batch([
    db.update(tasks).set({ assigneeContactId: null }).where(eq(tasks.assigneeContactId, contactId)),
    db.delete(eventRecipients).where(eq(eventRecipients.contactId, contactId)),
    ...manualHandles.map((handle) => db.delete(lineDestinations).where(eq(lineDestinations.id, handle.id))),
    db.delete(contacts).where(eq(contacts.id, contactId)),
  ]);
  return { id: contactId, removed: true };
}));

contactRoutes.post('/organizations/:accountId/members/:contactId/line-links', accountRoute(async ({ db, env, accountId, params }) => {
  const contactId = params.contactId ?? '';
  const token = randomToken(24);
  const timestamp = now();
  const expiresAt = expiresIn(CONTACT_LINK_WINDOW_MS);
  await db.batch([
    db.update(contactLinkTokens).set({ usedAt: timestamp }).where(and(eq(contactLinkTokens.contactId, contactId), isNull(contactLinkTokens.usedAt))),
    db.insert(contactLinkTokens).values({ token, contactId, expiresAt, usedAt: null, createdAt: timestamp }),
  ]);
  return created({
    contactId,
    token,
    expiresAt,
    linkUrl: `${appUrl(env)}/api/public/organizations/${encodeURIComponent(accountId)}/line-links/${encodeURIComponent(token)}`,
  });
}));

contactRoutes.post('/organizations/:accountId/members/:contactId/portal-invitations', accountRoute(async ({ db, env, accountId, params }) => {
  const contactId = params.contactId ?? '';
  // ADR 0119: the invitation is delivered to the Contact's LINE Destination,
  // and no alternative delivery is provided.
  const reachable = await db.select({ contactId: contactLineDestinations.contactId })
    .from(contactLineDestinations).where(eq(contactLineDestinations.contactId, contactId)).get();
  if (!reachable) throw conflict('LINE連携のないメンバーはContact Portalを利用できません。');
  const token = randomToken(24);
  const timestamp = now();
  const expiresAt = expiresIn(CONTACT_LINK_WINDOW_MS);
  await db.batch([
    db.update(portalInvitations).set({ usedAt: timestamp }).where(and(eq(portalInvitations.contactId, contactId), isNull(portalInvitations.usedAt))),
    db.insert(portalInvitations).values({ token, contactId, expiresAt, usedAt: null, createdAt: timestamp }),
  ]);
  return created({
    contactId,
    expiresAt,
    portalUrl: `${appUrl(env)}/portal/join/${encodeURIComponent(accountId)}/${encodeURIComponent(token)}`,
  });
}));

contactRoutes.put('/organizations/:accountId/members/:contactId/line-destination', accountRoute<{ destinationId?: string; kind?: string; displayName?: string }>(async ({ db, body, params }): Promise<RouteResult<LineHandle>> => {
  const destinationId = body.destinationId?.trim() ?? '';
  if (!LINE_DESTINATION_ID_PATTERN.test(destinationId)) throw invalid('A valid LINE ID is required.');
  const kind = lineKindOf(body.kind);
  const displayName = body.displayName?.trim() ?? '';
  const contactId = params.contactId ?? '';
  const contact = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).get();
  if (!contact) throw notFound('Contact was not found.');
  const connection = await db.select({ id: connections.id }).from(connections)
    .where(and(eq(connections.kind, 'line'), eq(connections.status, 'active'))).limit(1).get();
  if (!connection) throw conflict('A LINE Connection must be configured before a LINE Destination can be entered manually.');
  const existing = await db.select({
    id: lineDestinations.id,
    source: lineDestinations.source,
    contactId: contactLineDestinations.contactId,
  }).from(lineDestinations)
    .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
    .where(and(eq(lineDestinations.connectionId, connection.id), eq(lineDestinations.destinationId, destinationId)))
    .get();
  if (existing?.contactId && existing.contactId !== contactId) throw conflict('This LINE ID is already linked to another member.');
  const previousManual = await db.select({ id: lineDestinations.id }).from(lineDestinations)
    .innerJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
    .where(and(
      eq(contactLineDestinations.contactId, contactId),
      eq(lineDestinations.source, 'manual'),
      ne(lineDestinations.id, existing?.id ?? ''),
    )).get();
  if (previousManual) await db.delete(lineDestinations).where(eq(lineDestinations.id, previousManual.id)).run();
  const timestamp = now();
  const lineDestinationId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await db.update(lineDestinations).set({ kind, ...(displayName ? { displayName } : {}), status: 'discovered', updatedAt: timestamp })
      .where(eq(lineDestinations.id, existing.id)).run();
  } else {
    await db.insert(lineDestinations).values({
      id: lineDestinationId, connectionId: connection.id, destinationId, displayName, kind,
      status: 'discovered', source: 'manual', discoveredAt: timestamp, updatedAt: timestamp,
    }).run();
  }
  if (!existing?.contactId) {
    await db.insert(contactLineDestinations).values({ contactId, lineDestinationId, createdAt: timestamp }).run();
  }
  const view = {
    id: lineDestinationId,
    destinationId: displayLineDestinationId(destinationId),
    displayName,
    kind,
    status: 'discovered' as const,
    source: existing?.source ?? 'manual',
  };
  return existing ? view : created(view);
}));

contactRoutes.delete('/organizations/:accountId/members/:contactId/line-destination/:lineDestinationId', accountRoute(async ({ db, params }) => {
  const contactId = params.contactId ?? '';
  const lineDestinationId = params.lineDestinationId ?? '';
  const link = await db.select({
    lineDestinationId: contactLineDestinations.lineDestinationId,
    source: lineDestinations.source,
  }).from(contactLineDestinations)
    .innerJoin(lineDestinations, eq(lineDestinations.id, contactLineDestinations.lineDestinationId))
    .where(and(eq(contactLineDestinations.contactId, contactId), eq(contactLineDestinations.lineDestinationId, lineDestinationId))).get();
  if (!link) throw notFound('LINE Destination link was not found.');
  if (link.source === 'manual') {
    await db.delete(lineDestinations).where(eq(lineDestinations.id, lineDestinationId)).run();
  } else {
    await db.delete(contactLineDestinations).where(and(
      eq(contactLineDestinations.contactId, contactId),
      eq(contactLineDestinations.lineDestinationId, lineDestinationId),
    )).run();
  }
  return { id: lineDestinationId, unlinked: true };
}));

contactRoutes.post('/organizations/:accountId/members/import/preview', accountRoute<{ csv?: string }>(async ({ body }) => {
  if (typeof body.csv !== 'string') throw invalid('CSV content is required.');
  return previewContactCsv(body.csv);
}));

contactRoutes.post('/organizations/:accountId/members/import', accountRoute<{ csv?: string }>(async ({ db, accountId, body }) => {
  if (typeof body.csv !== 'string') throw invalid('CSV content is required.');
  const preview = previewContactCsv(body.csv);
  const timestamp = now();
  const writes = await Promise.all(preview.accepted.map((contact) => db.insert(contacts).values({
    id: crypto.randomUUID(),
    accountId,
    name: contact.name,
    email: contact.email,
    state: 'active',
    tags: '[]',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoNothing().returning({ id: contacts.id }).get()));
  return created({ imported: writes.filter(Boolean).length, duplicates: preview.duplicates, invalid: preview.invalid });
}));

import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { LineHandleRecord } from '@mail/domain';
import { discoveredLineDestinations, displayLineDestinationId, verifyLineWebhookSignature } from '@mail/domain';

import { now } from '../clock';
import { activeConnection, readConnection, type ConnectionCredential } from '../connections';
import type { Providers } from '../providers';
import { conflict, gone, invalid, notFound, Refusal } from '../refusal';
import { resource } from '../response';
import { contactLineDestinations, contactLinkTokens, lineDestinations } from '../storage/account-schema';
import { accountRoute, created, publicAccount, type RouteResult } from './account';
import { LINE_DESTINATION_ID_PATTERN } from './contacts';

interface LineWebhookPayload {
  events?: Array<{
    source?: {
      type?: string;
      userId?: string;
      groupId?: string;
      roomId?: string;
    };
  }>;
}

interface LineProfileResponse {
  displayName?: string;
}

type LineKind = 'user' | 'group' | 'room';

const lineDestinationDisplayName = async (
  fetch: Providers['fetch'],
  credential: ConnectionCredential,
  destination: { destinationId: string; kind: LineKind },
  payload: LineWebhookPayload,
): Promise<string> => {
  if (destination.kind !== 'user' || !credential.channelAccessToken) return '';
  try {
    const source = payload.events?.find((event) => event.source?.userId === destination.destinationId)?.source;
    const profilePath = source?.type === 'group' && source.groupId
      ? `group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(destination.destinationId)}`
      : source?.type === 'room' && source.roomId
        ? `room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(destination.destinationId)}`
        : `profile/${encodeURIComponent(destination.destinationId)}`;
    const response = await fetch(`https://api.line.me/v2/bot/${profilePath}`, { headers: { Authorization: `Bearer ${credential.channelAccessToken}` } });
    if (!response.ok) return '';
    const profile = await response.json() as LineProfileResponse;
    return profile.displayName?.trim() ?? '';
  } catch {
    return '';
  }
};

/** LINE Destinations: discovered by the webhook, entered by hand, or claimed through a Contact Link. */
export const lineRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/line-destinations', accountRoute(async ({ db }): Promise<LineHandleRecord[]> => {
    const rows = await db.select({
      id: lineDestinations.id,
      destinationId: lineDestinations.destinationId,
      displayName: lineDestinations.displayName,
      kind: lineDestinations.kind,
      status: lineDestinations.status,
      source: lineDestinations.source,
      discoveredAt: lineDestinations.discoveredAt,
      contactId: contactLineDestinations.contactId,
    }).from(lineDestinations)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .orderBy(desc(lineDestinations.discoveredAt)).all();
    return rows.map((row) => ({ ...row, destinationId: displayLineDestinationId(row.destinationId) }));
  }));

  routes.post('/organizations/:accountId/line-destinations', accountRoute<{ destinationId?: string; kind?: string; displayName?: string }>(async ({ db, body }): Promise<RouteResult<LineHandleRecord>> => {
    const destinationId = body.destinationId?.trim() ?? '';
    if (!LINE_DESTINATION_ID_PATTERN.test(destinationId)) throw invalid('A valid LINE ID is required.');
    const kind: LineKind = body.kind === 'group' || body.kind === 'room' ? body.kind : 'user';
    const displayName = body.displayName?.trim() ?? '';
    const connection = await activeConnection(db, 'line');
    if (!connection) throw conflict('A LINE Connection must be configured before a LINE Destination can be entered manually.');
    const existing = await db.select({ id: lineDestinations.id, contactId: contactLineDestinations.contactId }).from(lineDestinations)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .where(and(eq(lineDestinations.connectionId, connection.id), eq(lineDestinations.destinationId, destinationId)))
      .get();
    if (existing?.contactId) throw conflict('This LINE ID is already linked to a member.');
    const timestamp = now();
    const view = {
      destinationId: displayLineDestinationId(destinationId),
      displayName,
      kind,
      status: 'discovered' as const,
      source: 'manual' as const,
      discoveredAt: timestamp,
      contactId: null,
    };
    if (existing) {
      await db.update(lineDestinations).set({ kind, ...(displayName ? { displayName } : {}), status: 'discovered', updatedAt: timestamp })
        .where(eq(lineDestinations.id, existing.id)).run();
      return { id: existing.id, ...view };
    }
    const id = crypto.randomUUID();
    await db.insert(lineDestinations).values({
      id, connectionId: connection.id, destinationId, displayName, kind,
      status: 'discovered', source: 'manual', discoveredAt: timestamp, updatedAt: timestamp,
    }).run();
    return created({ id, ...view });
  }));

  routes.delete('/organizations/:accountId/line-destinations/:lineDestinationId', accountRoute(async ({ db, params }) => {
    const lineDestinationId = params.lineDestinationId ?? '';
    const existing = await db.select({ id: lineDestinations.id, contactId: contactLineDestinations.contactId }).from(lineDestinations)
      .leftJoin(contactLineDestinations, eq(contactLineDestinations.lineDestinationId, lineDestinations.id))
      .where(eq(lineDestinations.id, lineDestinationId)).get();
    if (!existing) throw notFound('LINE Destination was not found.');
    if (existing.contactId) throw conflict('Unlink this LINE Destination from its member before removing it.');
    await db.delete(lineDestinations).where(eq(lineDestinations.id, lineDestinationId)).run();
    return { id: lineDestinationId, removed: true };
  }));

  routes.post('/public/organizations/:accountId/line/webhook', async (context) => {
    const account = await publicAccount(context.env, context.req.param('accountId'), 'LINE webhook');
    const connection = await activeConnection(account.db, 'line');
    if (!connection) throw notFound('LINE webhook was not found.');
    const credential = await readConnection({ db: account.db, key: await account.key(), accountId: account.accountId, kind: 'line' });
    const rawBody = await context.req.text();
    const signature = context.req.header('x-line-signature') ?? '';
    if (!credential.channelSecret || !await verifyLineWebhookSignature(credential.channelSecret, rawBody, signature)) {
      throw new Refusal('unauthenticated', 'Invalid LINE webhook signature.');
    }
    const payload = JSON.parse(rawBody) as LineWebhookPayload;
    const destinations = discoveredLineDestinations(payload);
    const timestamp = now();
    const persistence = Promise.all(destinations.map(async (destination) => {
      const displayName = await lineDestinationDisplayName(providers.fetch, credential, destination, payload);
      await account.db.insert(lineDestinations).values({
        id: crypto.randomUUID(),
        connectionId: connection.id,
        destinationId: destination.destinationId,
        displayName,
        kind: destination.kind,
        status: 'discovered',
        discoveredAt: timestamp,
        updatedAt: timestamp,
      }).onConflictDoUpdate({
        target: [lineDestinations.connectionId, lineDestinations.destinationId],
        set: { ...(displayName ? { displayName } : {}), status: 'discovered', updatedAt: timestamp },
      }).run();
    }));
    context.executionCtx.waitUntil(persistence);
    return context.json({ data: { discovered: destinations.length } });
  });

  routes.post('/public/organizations/:accountId/line-links/:token', async (context) => {
    const account = await publicAccount(context.env, context.req.param('accountId'), 'Contact Link');
    const input = await context.req.json<{ destinationId?: string }>();
    const destinationId = input.destinationId?.trim() ?? '';
    if (!destinationId) throw invalid('A discovered LINE Destination is required.');
    const token = context.req.param('token');
    const link = await account.db.select({ contactId: contactLinkTokens.contactId }).from(contactLinkTokens).where(and(
      eq(contactLinkTokens.token, token),
      isNull(contactLinkTokens.usedAt),
      gt(contactLinkTokens.expiresAt, now()),
    )).get();
    if (!link) throw gone('Contact Link has expired or was already used.');
    const destination = await account.db.select({ id: lineDestinations.id }).from(lineDestinations).where(and(
      eq(lineDestinations.destinationId, destinationId),
      eq(lineDestinations.status, 'discovered'),
    )).limit(1).get();
    if (!destination) throw notFound('LINE Destination was not found.');
    const timestamp = now();
    await account.db.insert(contactLineDestinations).values({ contactId: link.contactId, lineDestinationId: destination.id, createdAt: timestamp })
      .onConflictDoNothing().run();
    const consumed = await account.db.update(contactLinkTokens).set({ usedAt: timestamp })
      .where(and(eq(contactLinkTokens.token, token), isNull(contactLinkTokens.usedAt)))
      .returning({ token: contactLinkTokens.token }).get();
    if (!consumed) throw gone('Contact Link was already used.');
    return context.json({ data: { contactId: link.contactId, destinationId: displayLineDestinationId(destinationId) } });
  });

  return routes;
};

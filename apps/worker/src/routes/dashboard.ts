import { and, asc, count, eq, gte, inArray, max } from 'drizzle-orm';

import { now } from '../clock';
import { affiliationCounts } from '../guests';
import { resource } from '../response';
import {
  agentRules,
  events,
  exceptions,
  googleConnections,
  guestRegistrations,
  jobs,
  rules,
} from '../storage/account-schema';
import { accountRoute } from './account';

export const dashboardRoutes = resource();

dashboardRoutes.get('/organizations/:accountId/dashboard', accountRoute(async ({ db }) => {
  const [schemaRules, activeAgentRules, upcoming, pending, open, connection] = await Promise.all([
    db.select({ value: count() }).from(rules).where(eq(rules.status, 'active')).get(),
    db.select({ value: count() }).from(agentRules).where(eq(agentRules.status, 'active')).get(),
    db.select({ value: count() }).from(events).where(and(eq(events.status, 'scheduled'), gte(events.startsAt, now()))).get(),
    db.select({ value: count() }).from(jobs).where(inArray(jobs.state, ['pending', 'running'])).get(),
    db.select({ value: count() }).from(exceptions).where(eq(exceptions.state, 'open')).get(),
    db.select({ value: max(googleConnections.updatedAt) }).from(googleConnections).where(eq(googleConnections.kind, 'automation_inbox')).get(),
  ]);
  return {
    activeRules: (schemaRules?.value ?? 0) + (activeAgentRules?.value ?? 0),
    upcomingEvents: upcoming?.value ?? 0,
    pendingJobs: pending?.value ?? 0,
    exceptions: open?.value ?? 0,
    lastSyncedAt: connection?.value ?? null,
  };
}));

/**
 * The Guest Registrations on each Scheduled Event still ahead. This is the one
 * place the guests' names are shown: the Calendar description an invited Contact
 * reads carries the counts alone.
 */
dashboardRoutes.get('/organizations/:accountId/guest-registrations', accountRoute(async ({ db }) => {
  const rows = await db.select({
    eventId: events.id,
    title: events.title,
    startsAt: events.startsAt,
    name: guestRegistrations.name,
    affiliation: guestRegistrations.affiliation,
    attending: guestRegistrations.attending,
  }).from(guestRegistrations)
    .innerJoin(events, eq(events.id, guestRegistrations.eventId))
    .where(gte(events.endsAt, now()))
    .orderBy(asc(events.startsAt), asc(guestRegistrations.name)).all();
  const byEvent = new Map<string, {
    eventId: string;
    title: string;
    startsAt: string;
    guests: Array<{ name: string; affiliation: string; attending: boolean }>;
  }>();
  for (const row of rows) {
    const entry = byEvent.get(row.eventId) ?? { eventId: row.eventId, title: row.title, startsAt: row.startsAt, guests: [] };
    entry.guests.push({ name: row.name, affiliation: row.affiliation, attending: row.attending });
    byEvent.set(row.eventId, entry);
  }
  return [...byEvent.values()].map((entry) => ({
    ...entry,
    attendingCount: entry.guests.filter((guest) => guest.attending).length,
    affiliations: affiliationCounts(entry.guests),
  }));
}));

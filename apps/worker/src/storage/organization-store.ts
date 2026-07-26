import { and, count, eq } from 'drizzle-orm';

import type { OrganizationDatabase } from './database';
import { events, googleConnections, sourceMessages } from './organization-schema';

export interface AutomationStatus {
  email: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  created: number;
  skipped: number;
  exceptions: number;
}

export interface OrganizationStore {
  currentAutomation: () => Promise<AutomationStatus | null>;
  setAutomationEnabled: (enabled: boolean, updatedAt: string) => Promise<boolean>;
}

/**
 * Owns every Automation Inbox read/write. Its schema contains no Control D1
 * table, so identity-scoped legacy automation queries cannot be expressed.
 */
export const createOrganizationStore = (database: OrganizationDatabase): OrganizationStore => ({
  currentAutomation: async () => {
    const inbox = await database.select({
      email: googleConnections.inboxAddress,
      enabled: googleConnections.enabled,
      lastSyncedAt: googleConnections.lastSyncedAt,
      lastError: googleConnections.lastError,
    }).from(googleConnections)
      .where(and(
        eq(googleConnections.kind, 'automation_inbox'),
        eq(googleConnections.status, 'active'),
      ))
      .limit(1)
      .get();
    if (!inbox) return null;

    const [created, skipped, exceptions] = await Promise.all([
      database.select({ value: count() }).from(events).where(eq(events.status, 'scheduled')).get(),
      database.select({ value: count() }).from(sourceMessages).where(eq(sourceMessages.state, 'skipped')).get(),
      database.select({ value: count() }).from(sourceMessages).where(eq(sourceMessages.state, 'exception')).get(),
    ]);
    return {
      ...inbox,
      created: created?.value ?? 0,
      skipped: skipped?.value ?? 0,
      exceptions: exceptions?.value ?? 0,
    };
  },
  setAutomationEnabled: async (enabled, updatedAt) => {
    const result = await database.update(googleConnections)
      .set({ enabled, updatedAt })
      .where(eq(googleConnections.kind, 'automation_inbox'))
      .run();
    return result.meta.changes > 0;
  },
});

/**
 * Whether an Account sends reminders at all (ADR 0163).
 *
 * This is deliberately separate from the milestones an Account chose. An empty
 * list and a switch that is off both send nothing, but they answer different
 * questions: one says "not on these days", the other says "not yet". Folding
 * them together would mean turning reminders off had to destroy the cadence,
 * and turning them back on had to reinvent it.
 */

import { DEFAULT_REMINDERS_ENABLED, readRemindersEnabled, writeRemindersEnabled } from '@mail/domain';
import { eq } from 'drizzle-orm';

import { settings } from './storage/account-schema';
import type { AccountDatabase } from './storage/database';

export const TASK_REMINDERS_ENABLED_SETTING = 'task_reminders_enabled';
export const ATTENDANCE_REMINDERS_ENABLED_SETTING = 'attendance_reminders_enabled';

/** Off until an Account says otherwise, and off again if the stored value stops being a switch. */
export const accountRemindersEnabled = async (database: AccountDatabase, key: string): Promise<boolean> => {
  const stored = await database.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, key)).get();
  if (stored === undefined) return DEFAULT_REMINDERS_ENABLED;
  return readRemindersEnabled(stored.value) ?? DEFAULT_REMINDERS_ENABLED;
};

export const saveAccountRemindersEnabled = async (
  database: AccountDatabase,
  key: string,
  enabled: boolean,
  updatedAt: string,
): Promise<void> => {
  const value = writeRemindersEnabled(enabled);
  await database.insert(settings).values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
};

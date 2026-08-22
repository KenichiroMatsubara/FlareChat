/**
 * The reminder settings an Account keeps, for Tasks and for Event Responses
 * alike: whether reminders are sent at all (ADR 0163), and the milestones they
 * are sent on (ADR 0163 for Tasks, ADR 0164 for attendance).
 *
 * The switch is deliberately separate from the milestones an Account chose. An empty
 * list and a switch that is off both send nothing, but they answer different
 * questions: one says "not on these days", the other says "not yet". Folding
 * them together would mean turning reminders off had to destroy the cadence,
 * and turning them back on had to reinvent it.
 */

import { DEFAULT_REMINDERS_ENABLED, readReminderDays, readRemindersEnabled, writeReminderDays, writeRemindersEnabled } from '@mail/domain';
import { eq } from 'drizzle-orm';

import { settings } from './storage/account-schema';
import type { AccountDatabase } from './storage/database';

export const TASK_REMINDERS_ENABLED_SETTING = 'task_reminders_enabled';
export const ATTENDANCE_REMINDERS_ENABLED_SETTING = 'attendance_reminders_enabled';
export const TASK_REMINDER_DAYS_SETTING = 'task_reminder_days';
export const ATTENDANCE_REMINDER_DAYS_SETTING = 'attendance_reminder_days';

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

/**
 * The milestones this Account reminds on, falling back to the product default.
 * A stored value that no longer reads as a milestone list is treated as absent
 * rather than as "remind never", because silence is the one outcome an operator
 * would not be able to tell apart from the feature working.
 */
export const accountReminderDays = async (
  database: AccountDatabase,
  key: string,
  fallback: readonly number[],
): Promise<readonly number[]> => {
  const stored = await database.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, key)).get();
  if (stored === undefined) return fallback;
  const read = readReminderDays(stored.value);
  return read.accepted ? read.days : fallback;
};

export const saveAccountReminderDays = async (
  database: AccountDatabase,
  key: string,
  days: readonly number[],
  updatedAt: string,
): Promise<void> => {
  const value = writeReminderDays(days);
  await database.insert(settings).values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } }).run();
};

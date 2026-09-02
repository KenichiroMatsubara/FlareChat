import { createAutomation } from '../automation';
import { createDatabaseAccess } from '../database-access';
import { retryProvisioning } from '../onboarding';
import { dispatchDueAccountJobs } from '../job-dispatch';
import { runDueAccountAutomations } from '../automation-schedule';
import { productionProviders, type Providers } from '../providers';
import { REMINDER_JOB_KIND, enqueueDueAccountReminders, reminderJobHandler } from '../reminders';
import type { Bindings } from '../types';

/** The frequent tick: work that is late the moment its stated time passes. */
export const DUE_WORK_CRON = '*/30 * * * *';

/**
 * The wider tick: reading each Automation Inbox for new Source Messages. Mail
 * that arrived an hour ago is not late in the way a reminder due at 09:00 is, and
 * every poll costs a Gmail history request per Account whether or not anything
 * arrived, so it wakes on its own slower cadence.
 */
export const MAIL_POLL_CRON = '0 */3 * * *';

/**
 * Deployment-facing background capability. Individual Job, attendance, Task
 * reminder, and Automation implementations stay behind this one
 * scheduled-use-case seam.
 *
 * Which cron woke the Worker decides what runs. A wake-up that names neither
 * cadence — a local trigger, or a test — stands for both, so nothing is silently
 * skipped by a caller that does not know the schedule.
 */
export const runBackgroundWork = async (env: Bindings, cron?: string, providers: Providers = productionProviders()): Promise<void> => {
  await createDatabaseAccess(env).open({ kind: 'control' });
  const dueAt = new Date().toISOString();
  if (cron !== MAIL_POLL_CRON) {
    await retryProvisioning(env);
    await enqueueDueAccountReminders(env, dueAt);
    await dispatchDueAccountJobs(env, dueAt, { [REMINDER_JOB_KIND]: reminderJobHandler(env, providers) });
    await runDueAccountAutomations(env, new Date(dueAt));
  }
  if (cron !== DUE_WORK_CRON) await createAutomation(env, providers).runEnabledAccounts();
};

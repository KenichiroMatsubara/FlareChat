import { createAutomation } from '../automation';
import { createDatabaseAccess } from '../database-access';
import { retryProvisioning } from '../onboarding';
import { dispatchDueAccountJobs } from '../job-dispatch';
import { runDueAccountAutomations } from '../automation-schedule';
import { productionProviders, type Providers } from '../providers';
import { REMINDER_JOB_KIND, reminderJobHandler } from '../reminders';
import type { Bindings } from '../types';

/**
 * The one tick (ADR 0176). It runs the work that is late the moment its stated
 * time passes, and it is how the Morning is noticed: the first tick at or after
 * 05:00 Asia/Tokyo finds every Automation Inbox owing its intake, and later
 * ticks carry on an intake the read budget or a failure left unfinished. One
 * cron means no two invocations ever read the same Inbox at once.
 */
export const DUE_WORK_CRON = '*/30 * * * *';

/**
 * Deployment-facing background capability. Individual Job, reminder, Morning
 * Notice, and Automation implementations stay behind this one scheduled-use-case
 * seam.
 */
export const runBackgroundWork = async (env: Bindings, providers: Providers = productionProviders()): Promise<void> => {
  await createDatabaseAccess(env).open({ kind: 'control' });
  const dueAt = new Date().toISOString();
  await retryProvisioning(env);
  await dispatchDueAccountJobs(env, dueAt, { [REMINDER_JOB_KIND]: reminderJobHandler(env, providers) });
  await runDueAccountAutomations(env, new Date(dueAt));
  await createAutomation(env, providers).runEnabledAccounts(dueAt);
};

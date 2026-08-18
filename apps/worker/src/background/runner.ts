import { enqueueDueAccountAttendanceReminders } from '../attendance-reminders';
import { enqueueDueAccountTaskReminders } from '../task-reminders';
import { createAutomation } from '../automation';
import { createDatabaseAccess } from '../database-access';
import { retryProvisioning } from '../onboarding';
import { recoverDueAccountJobs } from '../jobs';
import type { Bindings } from '../types';

/**
 * Deployment-facing background capability. Individual Job, attendance, Task
 * reminder, and Automation implementations stay behind this one
 * scheduled-use-case seam.
 */
export const runBackgroundWork = async (env: Bindings): Promise<void> => {
  await createDatabaseAccess(env).open({ kind: 'control' });
  const dueAt = new Date().toISOString();
  await retryProvisioning(env);
  await enqueueDueAccountAttendanceReminders(env, dueAt);
  await enqueueDueAccountTaskReminders(env, dueAt);
  await recoverDueAccountJobs(env, dueAt);
  await createAutomation(env).runEnabledAccounts();
};

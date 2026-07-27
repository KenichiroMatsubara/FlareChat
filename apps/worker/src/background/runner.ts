import { enqueueDueOrganizationAttendanceReminders } from '../attendance-reminders';
import { createAutomation } from '../automation';
import { retryProvisioning } from '../onboarding';
import { recoverDueOrganizationJobs } from '../jobs';
import type { Bindings } from '../types';

/**
 * Deployment-facing background capability. Individual Job, attendance, and
 * Automation implementations stay behind this one scheduled-use-case seam.
 */
export const runBackgroundWork = async (env: Bindings): Promise<void> => {
  const dueAt = new Date().toISOString();
  await retryProvisioning(env);
  await enqueueDueOrganizationAttendanceReminders(env, dueAt);
  await recoverDueOrganizationJobs(env, dueAt);
  await createAutomation(env).runEnabledOrganizations();
};

import { retryProvisioning } from './api';
import type { Bindings } from './types';

/** Until Organization databases are active, Cron is limited to safe setup recovery. */
export const runDueJobs = async (env: Bindings): Promise<void> => {
  await retryProvisioning(env);
};

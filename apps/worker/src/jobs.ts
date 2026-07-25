import { retryProvisioning } from './api';
import { runEnabledAutomations } from './automation';
import type { Bindings } from './types';

export const runDueJobs = async (env: Bindings): Promise<void> => {
  await retryProvisioning(env);
  await runEnabledAutomations(env);
};

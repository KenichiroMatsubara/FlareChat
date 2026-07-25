import { app } from './api';
import { runDueJobs } from './jobs';

import type { Bindings } from './types';

export default {
  fetch: app.fetch,
  scheduled: async (_controller: ScheduledController, env: Bindings, context: ExecutionContext) => {
    context.waitUntil(runDueJobs(env));
  },
} satisfies ExportedHandler<Bindings>;

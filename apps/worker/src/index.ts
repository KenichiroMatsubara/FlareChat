import { app } from './api';
import { runBackgroundWork } from './background/runner';

import type { Bindings } from './types';

export default {
  fetch: app.fetch,
  scheduled: async (_controller: ScheduledController, env: Bindings, context: ExecutionContext) => {
    context.waitUntil(runBackgroundWork(env));
  },
} satisfies ExportedHandler<Bindings>;

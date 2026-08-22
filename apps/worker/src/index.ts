import { app } from './api';
import { runBackgroundWork } from './background/runner';

import type { Bindings } from './types';

export default {
  fetch: app.fetch,
  scheduled: async (controller: ScheduledController, env: Bindings, context: ExecutionContext) => {
    context.waitUntil(runBackgroundWork(env, controller.cron));
  },
} satisfies ExportedHandler<Bindings>;

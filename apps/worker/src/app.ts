import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { createDatabaseAccess } from './database-access';
import { productionProviders, type Providers } from './providers';
import { respondToError } from './response';
import type { Bindings } from './types';
import { agentRoutes } from './routes/agents';
import { automationRoutes } from './routes/automations';
import { channelRoutes } from './routes/channels';
import { chatRoutes } from './routes/chat';
import { connectionRoutes } from './routes/connections';
import { contactRoutes } from './routes/contacts';
import { dashboardRoutes } from './routes/dashboard';
import { discordRoutes } from './routes/discord';
import { entryRoutes, oauthRoutes } from './routes/entry';
import { eventRoutes } from './routes/events';
import { inboxRoutes } from './routes/inbox';
import { lineRoutes } from './routes/line';
import { listRoutes } from './routes/lists';
import { mailboxRoutes } from './routes/mailbox';
import { operationRoutes } from './routes/operations';
import { portalRoutes } from './routes/portal';
import { presetRoutes } from './routes/presets';
import { promptRoutes } from './routes/prompts';
import { ruleRoutes } from './routes/rules';
import { serverRoutes } from './routes/servers';
import { taskRoutes } from './routes/tasks';
import { tokenRoutes } from './routes/tokens';
import { createRequestContext } from './routes/request-context';

/**
 * The HTTP surface (ADR 0169). Every resource is one module under `routes/`;
 * this file only mounts them and is the one place a refusal becomes a response.
 */
export const createApp = (providers: Providers) => {
  const app = new Hono<{ Bindings: Bindings }>();

  app.onError(respondToError);

  app.use('/api/*', cors({ origin: (origin) => origin || 'http://localhost:5173', credentials: true }));
  app.use('*', async (context, next) => {
    await createDatabaseAccess(context.env).open({ kind: 'control' });
    await next();
  });

  app.route('/api', entryRoutes);
  app.route('/api', inboxRoutes(providers));
  app.route('/api', listRoutes);
  app.route('/api', portalRoutes);
  app.route('/', oauthRoutes);
  app.route('/api', presetRoutes);
  app.route('/api', connectionRoutes(providers));
  app.route('/api', mailboxRoutes(providers));
  app.route('/api', promptRoutes);
  app.route('/api', agentRoutes);
  app.route('/api', ruleRoutes(providers));
  app.route('/api', contactRoutes);
  app.route('/api', lineRoutes(providers));
  app.route('/api', dashboardRoutes);
  app.route('/api', taskRoutes);
  app.route('/api', operationRoutes);
  app.route('/api', eventRoutes);
  app.route('/api', serverRoutes(providers));
  app.route('/api', channelRoutes);
  app.route('/api', chatRoutes(providers));
  app.route('/api', discordRoutes);
  app.route('/api', tokenRoutes);
  app.route('/api', automationRoutes);

  app.all('/api/*', async (context) => {
    await createRequestContext(context.req.raw, context.env).requiredSession();
    return context.json({ error: { code: 'gone', message: 'The previous shared-ORG_DB management API has been retired. Account-scoped operations are introduced in the next implementation unit.' } }, 410);
  });

  return app;
};

export const app = createApp(productionProviders());

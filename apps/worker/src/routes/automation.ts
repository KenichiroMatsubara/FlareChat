import { Hono } from 'hono';

import { runOrganizationAutomation } from '../automation';
import { failure, json } from '../response';
import { createRequestContext } from './request-context';
import type { Bindings } from '../types';
import { organizationDatabase } from '../storage/database';
import { createOrganizationStore } from '../storage/organization-store';

export const automationRoutes = new Hono<{ Bindings: Bindings }>();

const now = (): string => new Date().toISOString();

automationRoutes.get('/organizations/:organizationId/automation', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).organization(context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const automation = await createOrganizationStore(organizationDatabase(access.database)).currentAutomation();
    return json(context, automation ? { ...automation, displayName: access.session.display_name } : null);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation Inbox could not be loaded.', 403);
  }
});

automationRoutes.post('/organizations/:organizationId/automation/run', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).organization(context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    return json(context, await runOrganizationAutomation(context.env, access.organization.id, access.database));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : '自動化を実行できませんでした。', 409);
  }
});

automationRoutes.post('/organizations/:organizationId/automation/enabled', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).organization(context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    if (!['owner', 'admin', 'operator'].includes(access.role)) return failure(context, 'Automation can only be changed by an Owner, Admin, or Operator.', 403);
    const input = await context.req.json<{ enabled?: boolean }>();
    if (typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const updated = await createOrganizationStore(organizationDatabase(access.database)).setAutomationEnabled(input.enabled, now());
    if (!updated) return failure(context, 'Automation Inbox が見つかりません。', 404);
    return json(context, { enabled: input.enabled });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : '自動化を更新できませんでした。', 409);
  }
});

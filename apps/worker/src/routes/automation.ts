import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { readAttachmentFolderPath } from '@mail/domain';

import { beginGoogleEntry, entryConfigurationError } from '../entry';
import { createAutomation } from '../automation';
import { failure, json } from '../response';
import { createRequestContext } from './request-context';
import type { Bindings } from '../types';
import { organizationDatabase } from '../storage/database';
import { createOrganizationStore } from '../storage/organization-store';
import { connections } from '../storage/organization-schema';
import { organizationAttachmentFolderPath, saveOrganizationAttachmentFolderPath } from '../attachment-folders';

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
    return json(context, await createAutomation(context.env).runOrganization({
      organizationId: access.organization.id,
      database: access.database,
    }));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : '自動化を実行できませんでした。', 409);
  }
});

automationRoutes.post('/organizations/:organizationId/automation/reauthorize', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).organization(context.req.param('organizationId'));
    const invalid = entryConfigurationError(context.env);
    if (invalid) return failure(context, invalid, 503);
    return json(context, {
      authorizationUrl: await beginGoogleEntry(context.env, context.req.raw, 'organization_setup', {
        recoveryOrganizationId: access.organization.id,
      }),
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation Inbox could not be reconnected.', 403);
  }
});

automationRoutes.post('/organizations/:organizationId/automation/enabled', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).organization(context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ enabled?: boolean }>();
    if (typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const database = organizationDatabase(access.database);
    if (input.enabled) {
      const ai = await database.select({ id: connections.id }).from(connections).where(and(
        eq(connections.kind, 'ai'),
        eq(connections.status, 'active'),
      )).limit(1).get();
      if (!ai) return failure(context, '自動化を有効にする前に OpenAI 互換 API を設定してください。', 409);
    }
    const updated = await createOrganizationStore(database).setAutomationEnabled(input.enabled, now());
    if (!updated) return failure(context, 'Automation Inbox が見つかりません。', 404);
    return json(context, { enabled: input.enabled });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : '自動化を更新できませんでした。', 409);
  }
});

const ATTACHMENT_FOLDER_PATH_REJECTIONS: Record<string, string> = {
  empty_path: '保存先を空にはできません。Driveのルートに保存されるためです。',
  control_character: '保存先に使用できない制御文字が含まれています。',
  segment_too_long: 'フォルダ名が1階層あたりの上限を超えています。',
  too_many_segments: '階層が深すぎます。',
};

automationRoutes.get('/organizations/:organizationId/attachment-folder', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).organization(context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    return json(context, { path: await organizationAttachmentFolderPath(organizationDatabase(access.database)) });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attachment Folder Path could not be loaded.', 403);
  }
});

automationRoutes.put('/organizations/:organizationId/attachment-folder', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).organization(context.req.param('organizationId'));
    if (!access.database) throw new Error('Organization database is not available.');
    const input = await context.req.json<{ path?: unknown }>();
    if (typeof input.path !== 'string') return failure(context, '保存先を入力してください。');
    const read = readAttachmentFolderPath(input.path);
    if (!read.accepted) return failure(context, ATTACHMENT_FOLDER_PATH_REJECTIONS[read.reason] ?? '保存先を保存できませんでした。');
    await saveOrganizationAttachmentFolderPath(organizationDatabase(access.database), read.path, now());
    return json(context, { path: read.path });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attachment Folder Path could not be saved.', 409);
  }
});

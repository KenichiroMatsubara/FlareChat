import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  MAX_RESPONSE_WINDOW_DAYS,
  MAX_REMINDER_DAY,
  MAX_REMINDER_DAYS,
  MIN_ATTENDANCE_REMINDER_DAY,
  MIN_RESPONSE_WINDOW_DAYS,
  MIN_REMINDER_DAY,
  readAttachmentFolderPath,
  readResponseWindowDays,
  readReminderDays,
} from '@mail/domain';

import { beginGoogleEntry, entryConfigurationError } from '../entry';
import { createAutomation } from '../automation';
import { failure, json } from '../response';
import { createRequestContext } from './request-context';
import type { Bindings } from '../types';
import { accountDatabase } from '../storage/database';
import { createAccountStore } from '../storage/account-store';
import { connections } from '../storage/account-schema';
import { accountAttachmentFolderPath, saveAccountAttachmentFolderPath } from '../attachment-folders';
import { accountResponseWindowDays, saveAccountResponseWindowDays } from '../event-merge';
import {
  accountTaskReminderDays,
  accountTaskRemindersEnabled,
  saveAccountTaskReminderDays,
  saveAccountTaskRemindersEnabled,
  upcomingTaskReminders,
} from '../task-reminders';
import {
  accountAttendanceReminderDays,
  accountAttendanceRemindersEnabled,
  saveAccountAttendanceReminderDays,
  saveAccountAttendanceRemindersEnabled,
  upcomingAttendanceReminders,
} from '../attendance-reminders';

export const automationRoutes = new Hono<{ Bindings: Bindings }>();

const now = (): string => new Date().toISOString();

automationRoutes.get('/organizations/:accountId/automation', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const automation = await createAccountStore(accountDatabase(access.database)).currentAutomation();
    return json(context, automation ? { ...automation, displayName: access.session.display_name } : null);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation Inbox could not be loaded.', 403);
  }
});

automationRoutes.post('/organizations/:accountId/automation/run', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    return json(context, await createAutomation(context.env).runAccount({
      accountId: access.account.id,
      database: access.database,
    }));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : '自動化を実行できませんでした。', 409);
  }
});

automationRoutes.post('/organizations/:accountId/automation/reauthorize', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    const invalid = entryConfigurationError(context.env);
    if (invalid) return failure(context, invalid, 503);
    return json(context, {
      authorizationUrl: await beginGoogleEntry(context.env, context.req.raw, 'organization_setup', {
        recoveryAccountId: access.account.id,
      }),
    }, 201);
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Automation Inbox could not be reconnected.', 403);
  }
});

automationRoutes.post('/organizations/:accountId/automation/enabled', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ enabled?: boolean }>();
    if (typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const database = accountDatabase(access.database);
    if (input.enabled) {
      const ai = await database.select({ id: connections.id }).from(connections).where(and(
        eq(connections.kind, 'ai'),
        eq(connections.status, 'active'),
      )).limit(1).get();
      if (!ai) return failure(context, '自動化を有効にする前に OpenAI 互換 API を設定してください。', 409);
    }
    const updated = await createAccountStore(database).setAutomationEnabled(input.enabled, now());
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

const RESPONSE_WINDOW_REJECTIONS: Record<string, string> = {
  not_a_number: '日数は整数で入力してください。',
  out_of_range: `日数は${MIN_RESPONSE_WINDOW_DAYS}〜${MAX_RESPONSE_WINDOW_DAYS}日の範囲で入力してください。`,
};

automationRoutes.get('/organizations/:accountId/response-window', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    return json(context, { days: await accountResponseWindowDays(accountDatabase(access.database)) });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Event Response window could not be loaded.', 403);
  }
});

automationRoutes.put('/organizations/:accountId/response-window', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ days?: unknown }>();
    const read = readResponseWindowDays(input.days);
    if (!read.accepted) return failure(context, RESPONSE_WINDOW_REJECTIONS[read.reason] ?? '日数を保存できませんでした。');
    await saveAccountResponseWindowDays(accountDatabase(access.database), read.days, now());
    return json(context, { days: read.days });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Event Response window could not be saved.', 409);
  }
});

/**
 * Why a cadence was refused, in the words of the page that sent it. The nearest
 * milestone differs by kind: attendance stops at the deadline day, because a
 * Registration answered after it is one the product will not accept.
 */
const reminderDayRejection = (reason: string, minimum: number): string => {
  if (reason === 'not_a_list') return 'リマインドする日をリストで指定してください。';
  if (reason === 'not_a_number') return 'リマインドする日は整数で入力してください。';
  if (reason === 'too_many') return `リマインドする日は${MAX_REMINDER_DAYS}件までです。`;
  if (reason === 'out_of_range') {
    const nearest = minimum >= 0 ? '当日' : `${Math.abs(minimum)}日後`;
    return `リマインドする日は締め切りの${MAX_REMINDER_DAY}日前から${nearest}までの範囲で入力してください。`;
  }
  return 'リマインドする日を保存できませんでした。';
};

automationRoutes.get('/organizations/:accountId/task-reminders', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const database = accountDatabase(access.database);
    return json(context, {
      enabled: await accountTaskRemindersEnabled(database),
      days: await accountTaskReminderDays(database),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Task reminder milestones could not be loaded.', 403);
  }
});

/**
 * The switch and the milestones are saved together, but either may be left out:
 * turning reminders off must not have to restate the cadence it is turning off.
 */
automationRoutes.put('/organizations/:accountId/task-reminders', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ days?: unknown; enabled?: unknown }>();
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const database = accountDatabase(access.database);
    if (input.days !== undefined) {
      const read = readReminderDays(input.days);
      if (!read.accepted) return failure(context, reminderDayRejection(read.reason, MIN_REMINDER_DAY));
      await saveAccountTaskReminderDays(database, read.days, now());
    }
    if (typeof input.enabled === 'boolean') await saveAccountTaskRemindersEnabled(database, input.enabled, now());
    return json(context, {
      enabled: await accountTaskRemindersEnabled(database),
      days: await accountTaskReminderDays(database),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Task reminder milestones could not be saved.', 409);
  }
});

automationRoutes.get('/organizations/:accountId/attendance-reminders', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const database = accountDatabase(access.database);
    return json(context, {
      enabled: await accountAttendanceRemindersEnabled(database),
      days: await accountAttendanceReminderDays(database),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attendance reminders could not be loaded.', 403);
  }
});

/** The attendance switch and cadence are saved exactly as the Task ones are (ADR 0164). */
automationRoutes.put('/organizations/:accountId/attendance-reminders', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ days?: unknown; enabled?: unknown }>();
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return failure(context, 'enabled must be a boolean.');
    const database = accountDatabase(access.database);
    if (input.days !== undefined) {
      const read = readReminderDays(input.days, MIN_ATTENDANCE_REMINDER_DAY);
      if (!read.accepted) return failure(context, reminderDayRejection(read.reason, MIN_ATTENDANCE_REMINDER_DAY));
      await saveAccountAttendanceReminderDays(database, read.days, now());
    }
    if (typeof input.enabled === 'boolean') await saveAccountAttendanceRemindersEnabled(database, input.enabled, now());
    return json(context, {
      enabled: await accountAttendanceRemindersEnabled(database),
      days: await accountAttendanceReminderDays(database),
    });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attendance reminders could not be saved.', 409);
  }
});

automationRoutes.get('/organizations/:accountId/attendance-reminders/schedule', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    return json(context, await upcomingAttendanceReminders(access.database, now()));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Scheduled attendance reminders could not be loaded.', 403);
  }
});

automationRoutes.get('/organizations/:accountId/task-reminders/schedule', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    return json(context, await upcomingTaskReminders(access.database, now()));
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Scheduled Task reminders could not be loaded.', 403);
  }
});

automationRoutes.get('/organizations/:accountId/attachment-folder', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    return json(context, { path: await accountAttachmentFolderPath(accountDatabase(access.database)) });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attachment Folder Path could not be loaded.', 403);
  }
});

automationRoutes.put('/organizations/:accountId/attachment-folder', async (context) => {
  try {
    const access = await createRequestContext(context.req.raw, context.env).account(context.req.param('accountId'));
    if (!access.database) throw new Error('Account database is not available.');
    const input = await context.req.json<{ path?: unknown }>();
    if (typeof input.path !== 'string') return failure(context, '保存先を入力してください。');
    const read = readAttachmentFolderPath(input.path);
    if (!read.accepted) return failure(context, ATTACHMENT_FOLDER_PATH_REJECTIONS[read.reason] ?? '保存先を保存できませんでした。');
    await saveAccountAttachmentFolderPath(accountDatabase(access.database), read.path, now());
    return json(context, { path: read.path });
  } catch (error) {
    return failure(context, error instanceof Error ? error.message : 'Attachment Folder Path could not be saved.', 409);
  }
});

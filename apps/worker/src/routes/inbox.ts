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
import type { AutomationStatus, AutomationSummary, ScheduledReminder } from '@mail/domain';

import { accountAttachmentFolderPath, saveAccountAttachmentFolderPath } from '../attachment-folders';
import { createAutomation } from '../automation';
import { now } from '../clock';
import { activeConnection } from '../connections';
import { beginGoogleEntry, entryConfigurationError } from '../entry';
import { accountResponseWindowDays, saveAccountResponseWindowDays } from '../event-merge';
import type { Providers } from '../providers';
import { conflict, invalid, notFound, upstream } from '../refusal';
import { reminderSettings, upcomingReminders } from '../reminders';
import { resource } from '../response';
import { createAccountStore } from '../storage/account-store';
import { accountRoute, created } from './account';

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

const reminderSettingsView = async (settings: ReturnType<typeof reminderSettings>) => ({
  enabled: await settings.enabled(),
  days: await settings.days(),
});

/** The Automation Inbox and the Account-wide settings its intake runs under. */
export const inboxRoutes = (providers: Providers) => {
  const routes = resource();

  routes.get('/organizations/:accountId/automation', accountRoute(async ({ db, session }): Promise<AutomationStatus | null> => {
    const automation = await createAccountStore(db).currentAutomation();
    return automation ? { ...automation, displayName: session.display_name } : null;
  }));

  routes.post('/organizations/:accountId/automation/run', accountRoute(async ({ env, accountId, database }): Promise<AutomationSummary> =>
    createAutomation(env, providers).runAccount({ accountId, database })));

  routes.post('/organizations/:accountId/automation/reauthorize', accountRoute(async (request) => {
    const misconfigured = entryConfigurationError(request.env);
    if (misconfigured) throw upstream(misconfigured);
    return created({
      authorizationUrl: await beginGoogleEntry(request.env, request.raw, 'organization_setup', { recoveryAccountId: request.accountId }),
    });
  }));

  routes.post('/organizations/:accountId/automation/enabled', accountRoute<{ enabled?: boolean }>(async ({ db, body }) => {
    if (typeof body.enabled !== 'boolean') throw invalid('enabled must be a boolean.');
    if (body.enabled && !await activeConnection(db, 'ai')) throw conflict('自動化を有効にする前に OpenAI 互換 API を設定してください。');
    const updated = await createAccountStore(db).setAutomationEnabled(body.enabled, now());
    if (!updated) throw notFound('Automation Inbox が見つかりません。');
    return { enabled: body.enabled };
  }));

  routes.get('/organizations/:accountId/response-window', accountRoute(async ({ db }) => ({ days: await accountResponseWindowDays(db) })));

  routes.put('/organizations/:accountId/response-window', accountRoute<{ days?: unknown }>(async ({ db, body }) => {
    const read = readResponseWindowDays(body.days);
    if (!read.accepted) throw invalid(RESPONSE_WINDOW_REJECTIONS[read.reason] ?? '日数を保存できませんでした。');
    await saveAccountResponseWindowDays(db, read.days, now());
    return { days: read.days };
  }));

  for (const [path, subject, minimum] of [
    ['task-reminders', 'task', MIN_REMINDER_DAY],
    ['attendance-reminders', 'registration', MIN_ATTENDANCE_REMINDER_DAY],
  ] as const) {
    routes.get(`/organizations/:accountId/${path}`, accountRoute(async ({ db }) => reminderSettingsView(reminderSettings(db, subject))));

    /**
     * The switch and the milestones are saved together, but either may be left out:
     * turning reminders off must not have to restate the cadence it is turning off.
     */
    routes.put(`/organizations/:accountId/${path}`, accountRoute<{ days?: unknown; enabled?: unknown }>(async ({ db, body }) => {
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw invalid('enabled must be a boolean.');
      const settings = reminderSettings(db, subject);
      if (body.days !== undefined) {
        const read = readReminderDays(body.days, minimum);
        if (!read.accepted) throw invalid(reminderDayRejection(read.reason, minimum));
        await settings.saveDays(read.days, now());
      }
      if (typeof body.enabled === 'boolean') await settings.saveEnabled(body.enabled, now());
      return reminderSettingsView(settings);
    }));
  }

  /** The Reminder Schedule: every reminder still ahead, whichever subject it is about. */
  routes.get('/organizations/:accountId/reminders/schedule', accountRoute(async ({ database }): Promise<ScheduledReminder[]> => upcomingReminders(database, now())));

  routes.get('/organizations/:accountId/attachment-folder', accountRoute(async ({ db }) => ({ path: await accountAttachmentFolderPath(db) })));

  routes.put('/organizations/:accountId/attachment-folder', accountRoute<{ path?: unknown }>(async ({ db, body }) => {
    if (typeof body.path !== 'string') throw invalid('保存先を入力してください。');
    const read = readAttachmentFolderPath(body.path);
    if (!read.accepted) throw invalid(ATTACHMENT_FOLDER_PATH_REJECTIONS[read.reason] ?? '保存先を保存できませんでした。');
    await saveAccountAttachmentFolderPath(db, read.path, now());
    return { path: read.path };
  }));

  return routes;
};

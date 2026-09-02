import { and, eq } from 'drizzle-orm';

import { GoogleGrantRejectedError } from './google';
import { accountIdentities, identities } from './storage/control-schema';
import { controlDatabase } from './storage/database';
import type { GoogleProvider } from './providers';
import type { Bindings } from './types';

/**
 * A run stopped by Account configuration rather than by the Google grant.
 * The Automation Inbox stays connected and the next scheduled run retries.
 */
export class AutomationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationConfigurationError';
  }
}

/**
 * Why one Automation run failed, which decides whether the Automation Inbox
 * keeps retrying on its own or has to wait for a human.
 *
 * - `configuration`: the Account has to change a setting.
 * - `transient`: a provider, network, or model fault that the next run retries.
 * - `credential`: Google rejected the grant, so only reauthorization restores it.
 */
export type AutomationFailureKind = 'configuration' | 'credential' | 'transient';

/**
 * Treats every failure as retryable unless Google itself rejected the grant.
 * Latching an Automation Inbox on a provider hiccup would stop unattended
 * operation for as long as nobody signs in, which is the failure this
 * classification exists to prevent.
 */
export const classifyAutomationFailure = (error: unknown): AutomationFailureKind => {
  if (error instanceof AutomationConfigurationError) return 'configuration';
  if (error instanceof GoogleGrantRejectedError) return 'credential';
  return 'transient';
};

/** Scheduled Automation runs every thirty minutes, so a day of silence is roughly forty-eight retries. */
export const ADMINISTRATOR_ALERT_DELAY_MS = 24 * 60 * 60 * 1_000;

/** While one failure persists the Administrators hear about it again at most once a week. */
export const ADMINISTRATOR_ALERT_REPEAT_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * A revoked grant is reported at once because no retry can clear it. Everything
 * else is reported only after a full day of failed retries, so a short provider
 * outage never reaches an Administrator's mailbox.
 */
export const shouldAlertAdministrators = (input: {
  kind: AutomationFailureKind;
  failingSince: string;
  alertedAt: string | null;
  at: string;
}): boolean => {
  const at = Date.parse(input.at);
  if (input.alertedAt) return at - Date.parse(input.alertedAt) >= ADMINISTRATOR_ALERT_REPEAT_MS;
  if (input.kind === 'credential') return true;
  return at - Date.parse(input.failingSince) >= ADMINISTRATOR_ALERT_DELAY_MS;
};

const KIND_CAUSE: Record<AutomationFailureKind, string> = {
  credential: 'Google の認可が失効しました。Automation Inbox を Google に再接続するまで自動処理は再開しません。',
  configuration: '設定が不足しているため自動処理を実行できません。管理画面で設定を確認してください。',
  transient: '外部サービスの応答に繰り返し失敗しています。復旧すると自動的に再開します。',
};

/** Writes the one notice an Administrator needs to act on without opening the GUI first. */
export const automationAlertMessage = (input: {
  kind: AutomationFailureKind;
  inboxAddress: string;
  failingSince: string;
  lastError: string;
  appUrl: string;
}): { subject: string; body: string } => ({
  subject: input.kind === 'credential'
    ? `[FlareChat] 自動処理が停止しました (${input.inboxAddress})`
    : `[FlareChat] 自動処理が継続して失敗しています (${input.inboxAddress})`,
  body: [
    `Automation Inbox: ${input.inboxAddress}`,
    `最初の失敗: ${input.failingSince}`,
    '',
    KIND_CAUSE[input.kind],
    '',
    `直近のエラー: ${input.lastError}`,
    '',
    `管理画面: ${input.appUrl}`,
  ].join('\n'),
});

/** Every active Administrator of one Account, read from the Control database. */
export const administratorEmails = async (env: Bindings, accountId: string): Promise<string[]> => {
  const rows = await controlDatabase(env.CONTROL_DB)
    .select({ email: identities.email })
    .from(accountIdentities)
    .innerJoin(identities, eq(identities.id, accountIdentities.identityId))
    .where(and(eq(accountIdentities.accountId, accountId), eq(accountIdentities.state, 'active')))
    .all();
  return [...new Set(rows.map((row) => row.email).filter(Boolean))];
};

/**
 * Sends the notice through the Automation Inbox itself and reports whether any
 * Administrator received it. A rejected grant usually leaves the stored access
 * token alive for the rest of its hour, which is exactly the window this send
 * uses; when nothing gets through, the caller leaves the alert unrecorded so a
 * later run tries again.
 */
export const alertAdministrators = async (input: {
  google: GoogleProvider;
  accessToken: string;
  destinations: string[];
  subject: string;
  body: string;
}): Promise<boolean> => {
  const results = await Promise.all(input.destinations.map(async (destination) => {
    try {
      await input.google.gmail.sendMail(input.accessToken, { destination, subject: input.subject, body: input.body });
      return true;
    } catch {
      return false;
    }
  }));
  return results.some(Boolean);
};

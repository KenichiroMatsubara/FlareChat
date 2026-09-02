import { describe, expect, it } from 'vitest';

import {
  ADMINISTRATOR_ALERT_DELAY_MS,
  ADMINISTRATOR_ALERT_REPEAT_MS,
  AutomationConfigurationError,
  automationAlertMessage,
  classifyAutomationFailure,
  shouldAlertAdministrators,
} from './health';
import { GoogleApiError } from './providers';
import { GoogleGrantRejectedError } from './google';

const FAILING_SINCE = '2026-08-01T00:00:00.000Z';
const after = (milliseconds: number): string =>
  new Date(Date.parse(FAILING_SINCE) + milliseconds).toISOString();

describe('Automation Inbox health', () => {
  it('treats every failure but a rejected Google grant as retryable', () => {
    expect(classifyAutomationFailure(new GoogleGrantRejectedError('invalid_grant', 'Token has been expired or revoked.')))
      .toBe('credential');
    expect(classifyAutomationFailure(new AutomationConfigurationError('先に OpenAI 互換 API を設定してください。')))
      .toBe('configuration');
    expect(classifyAutomationFailure(new GoogleApiError('Backend error', 503, 'https://gmail.googleapis.com/')))
      .toBe('transient');
    expect(classifyAutomationFailure(new Error('Google token refresh failed.'))).toBe('transient');
    expect(classifyAutomationFailure('network down')).toBe('transient');
  });

  it('tells the Administrators about a rejected grant immediately', () => {
    expect(shouldAlertAdministrators({
      kind: 'credential',
      failingSince: FAILING_SINCE,
      alertedAt: null,
      at: FAILING_SINCE,
    })).toBe(true);
  });

  it('rides out a day of retryable failures before mailing anyone', () => {
    const unattended = { failingSince: FAILING_SINCE, alertedAt: null } as const;
    expect(shouldAlertAdministrators({ kind: 'transient', ...unattended, at: after(23 * 60 * 60 * 1_000) }))
      .toBe(false);
    expect(shouldAlertAdministrators({ kind: 'transient', ...unattended, at: after(ADMINISTRATOR_ALERT_DELAY_MS) }))
      .toBe(true);
    expect(shouldAlertAdministrators({ kind: 'configuration', ...unattended, at: after(ADMINISTRATOR_ALERT_DELAY_MS) }))
      .toBe(true);
  });

  it('repeats an unresolved notice no more than once a week', () => {
    const alerted = { failingSince: FAILING_SINCE, alertedAt: FAILING_SINCE } as const;
    expect(shouldAlertAdministrators({ kind: 'credential', ...alerted, at: after(6 * 24 * 60 * 60 * 1_000) }))
      .toBe(false);
    expect(shouldAlertAdministrators({ kind: 'credential', ...alerted, at: after(ADMINISTRATOR_ALERT_REPEAT_MS) }))
      .toBe(true);
  });

  it('names the Automation Inbox, the cause, and the recovery destination in the notice', () => {
    const notice = automationAlertMessage({
      kind: 'credential',
      inboxAddress: 'automation@example.com',
      failingSince: FAILING_SINCE,
      lastError: 'Token has been expired or revoked.',
      appUrl: 'https://flarechat.pinara.workers.dev',
    });

    expect(notice.subject).toContain('automation@example.com');
    expect(notice.body).toContain('Google の認可が失効しました');
    expect(notice.body).toContain('Token has been expired or revoked.');
    expect(notice.body).toContain('https://flarechat.pinara.workers.dev');
  });
});

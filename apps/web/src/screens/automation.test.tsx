import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, automationStatus } from './fixtures';
import { deferred, renderScreen } from './render';
import * as automation from './automation';

vi.mock('../api');

describe('Automation screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus());
    vi.mocked(api.guestRegistrations).mockResolvedValue([]);
  });

  it('loads only the Automation Inbox and the guest roster', async () => {
    renderScreen('automation', automation);

    expect(await screen.findByText('自動化は有効です')).toBeTruthy();
    expect(api.currentAutomation).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(api.guestRegistrations).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(api.rules).not.toHaveBeenCalled();
    expect(api.deliveries).not.toHaveBeenCalled();
  });

  it('reports a running mailbox scan on its own control, then what the run did', async () => {
    const run = deferred<{ scanned: number; created: number; skipped: number; exceptions: number }>();
    vi.mocked(api.runAutomation).mockReturnValue(run.promise);
    const user = userEvent.setup();
    renderScreen('automation', automation);

    await user.click(await screen.findByRole('button', { name: '今すぐ確認' }));

    expect(await screen.findByText(/メールを確認中…/u)).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '自動化を切り替える' })).toHaveProperty('disabled', false);
    run.resolve({ scanned: 3, created: 1, skipped: 2, exceptions: 0 });
    expect(await screen.findByText(/今回: 3件をAI判定、1件を予定化/u)).toBeTruthy();
    await waitFor(() => expect(api.currentAutomation).toHaveBeenCalledTimes(2));
  });

  it('offers to reconnect the Inbox when its grant has been revoked', async () => {
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus({ status: 'reauthentication_required' }));
    renderScreen('automation', automation);

    expect(await screen.findByRole('button', { name: 'Automation Inbox を再接続する' })).toBeTruthy();
  });

  it('reports a still-connected Inbox whose scheduled runs keep failing without asking for reauthentication', async () => {
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus({ failingSince: '2026-08-18T09:00:00.000Z', lastError: 'Gmail timed out' }));
    renderScreen('automation', automation);

    expect(await screen.findByText(/から自動処理に失敗しています/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Automation Inbox を再接続する' })).toBeNull();
  });
});

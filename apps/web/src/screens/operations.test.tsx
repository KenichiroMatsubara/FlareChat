import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, automationStatus, connections, contact, delivery, exception } from './fixtures';
import { renderScreen } from './render';
import * as operations from './operations';

vi.mock('../api');

describe('Operations screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.exceptions).mockResolvedValue([exception()]);
    vi.mocked(api.warnings).mockResolvedValue([]);
    vi.mocked(api.stuckJobs).mockResolvedValue([{ id: 'job-1', kind: 'deliver', state: 'failed', attempts: 5, availableAt: '', lastError: 'LINE 500', updatedAt: '2026-08-18T09:00:00.000Z' }]);
    vi.mocked(api.deliveries).mockResolvedValue([delivery()]);
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus());
    vi.mocked(api.connections).mockResolvedValue(connections());
    vi.mocked(api.contacts).mockResolvedValue([contact()]);
  });

  it('gathers what went wrong: exceptions, stuck Jobs, and the delivery audit', async () => {
    renderScreen('operations', operations);

    expect(await screen.findByText('AI 接続が未設定')).toBeTruthy();
    expect(screen.getByText(/再試行を使い切りました/u)).toBeTruthy();
    expect(screen.getByText('送信履歴').nextElementSibling?.textContent).toBe('1件');
    expect(api.rules).not.toHaveBeenCalled();
  });

  it('resolves an exception and re-reads the list', async () => {
    vi.mocked(api.resolveException).mockResolvedValue({ id: 'exception-1' });
    vi.mocked(api.exceptions).mockResolvedValueOnce([exception()]).mockResolvedValue([]);
    const user = userEvent.setup();
    renderScreen('operations', operations);

    await user.click(await screen.findByRole('button', { name: '解決済みにする' }));

    expect(await screen.findByText(/未解決の例外はありません/u)).toBeTruthy();
    expect(api.resolveException).toHaveBeenCalledWith(ACCOUNT_ID, 'exception-1');
  });

  it('finds the message for an Event Refresh on its own, without another screen', async () => {
    vi.mocked(api.searchMailbox).mockResolvedValue({ messages: [{ id: 'message-1', subject: '総会案内', sender: 'sender@example.org' }] });
    const user = userEvent.setup();
    renderScreen('operations', operations);

    await user.click(await screen.findByRole('button', { name: 'Gmailを検索' }));

    expect(await screen.findByRole('button', { name: /総会案内/u })).toBeTruthy();
    expect(api.searchMailbox).toHaveBeenCalledWith(ACCOUNT_ID, '名古屋名城RAC30周年記念式典のご案内');
  });

  it('reports the suspension being changed on its own control', async () => {
    vi.mocked(api.setSuspension).mockResolvedValue({ accountId: ACCOUNT_ID, status: 'suspended' });
    const user = userEvent.setup();
    renderScreen('operations', operations);

    await user.click(await screen.findByRole('button', { name: 'Account を停止する' }));

    await waitFor(() => expect(api.setSuspension).toHaveBeenCalledWith(ACCOUNT_ID, true));
  });
});

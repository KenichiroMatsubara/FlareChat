import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, connections as connectionsView, contact, contactList } from './fixtures';
import { renderScreen } from './render';
import * as connections from './connections';

vi.mock('../api');

describe('Connections screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.connections).mockResolvedValue(connectionsView({ ai: { apiKeyConfigured: false, model: '', baseUrl: '' } }));
    vi.mocked(api.attachmentFolder).mockResolvedValue({ path: 'Mail Automation/添付ファイル' });
    vi.mocked(api.responseWindow).mockResolvedValue({ days: 60 });
    vi.mocked(api.contacts).mockResolvedValue([contact()]);
    vi.mocked(api.contactLists).mockResolvedValue([contactList()]);
    vi.mocked(api.accessTokens).mockResolvedValue([]);
    vi.mocked(api.mcpServers).mockResolvedValue([{ id: 'server-1', name: 'notion', url: 'https://example.com/mcp', revision: null, authenticated: true, updatedAt: '2026-08-18T09:00:00.000Z' }]);
  });

  it('holds what the whole Account shares: credentials, Access Tokens, and MCP Servers', async () => {
    renderScreen('connections', connections);

    expect(await screen.findByText('OpenAI 互換 API')).toBeTruthy();
    expect(screen.getByText('外部 AI からの利用')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'notion' })).toBeTruthy();
    expect(screen.getByDisplayValue('Mail Automation/添付ファイル')).toBeTruthy();
    expect(screen.getByText('現在: 前後60日')).toBeTruthy();
    expect(api.rules).not.toHaveBeenCalled();
  });

  it('saves the AI Connection once every field is present, and says it saved', async () => {
    vi.mocked(api.saveAiConnection).mockResolvedValue({ apiKeyConfigured: true, model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' });
    const user = userEvent.setup();
    renderScreen('connections', connections);
    const save = await screen.findByRole('button', { name: 'AI設定を保存' });
    expect(save).toHaveProperty('disabled', true);

    await user.type(screen.getByLabelText('Base URL'), 'https://api.openai.com/v1');
    await user.type(screen.getByLabelText('model'), 'gpt-4.1-mini');
    await user.type(screen.getByLabelText('OpenAI 互換 API キー'), 'sk-test');
    await waitFor(() => expect(save).toHaveProperty('disabled', false));
    await user.click(save);

    expect(await screen.findByText('保存しました')).toBeTruthy();
    expect(api.saveAiConnection).toHaveBeenCalledWith(ACCOUNT_ID, { apiKey: 'sk-test', model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' });
    await waitFor(() => expect(api.connections).toHaveBeenCalledTimes(2));
  });

  it('refuses a response window outside one day to a year', async () => {
    const user = userEvent.setup();
    renderScreen('connections', connections);
    const days = await screen.findByLabelText('前後の日数');

    await user.clear(days);
    await user.type(days, '400');

    expect(screen.getByRole('button', { name: '日数を保存' })).toHaveProperty('disabled', true);
  });
});

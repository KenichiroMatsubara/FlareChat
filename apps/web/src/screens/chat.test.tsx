import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, chatTurn } from './fixtures';
import { renderScreen } from './render';
import * as chat from './chat';

vi.mock('../api');

describe('Operator Chat transcript', () => {
  it('shows both sides of a completed exchange', () => {
    const markup = renderToStaticMarkup(<chat.ChatTranscript turns={[chatTurn()]} unreachable={[]} error="" />);

    expect(markup).toContain('来週の予定は?');
    expect(markup).toContain('2件です。');
  });

  it('keeps the question visible when the exchange failed', () => {
    const markup = renderToStaticMarkup(
      <chat.ChatTranscript turns={[chatTurn({ status: 'failed', response: null, error: 'model unavailable' })]} unreachable={[]} error="" />,
    );

    expect(markup).toContain('来週の予定は?');
    expect(markup).toContain('model unavailable');
  });

  it('says which server it could not reach rather than presenting the answer as complete', () => {
    const markup = renderToStaticMarkup(
      <chat.ChatTranscript turns={[chatTurn()]} unreachable={[{ server: 'notion', error: 'HTTP 502' }]} error="" />,
    );

    expect(markup).toContain('notion');
    expect(markup).toContain('到達できなかった MCP Server');
  });
});

describe('Chat screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.conversations).mockResolvedValue([{ id: 'conversation-1', title: '先週の確認', updatedAt: '2026-08-18T09:00:00.000Z' }]);
  });

  it('is conversation only: it loads the conversations and nothing about MCP Servers', async () => {
    renderScreen('chat', chat);

    expect(await screen.findByRole('button', { name: '先週の確認' })).toBeTruthy();
    expect(screen.getByText('まだやり取りがありません。')).toBeTruthy();
    expect(api.mcpServers).not.toHaveBeenCalled();
  });

  it('sends a message as one exchange and shows the reply', async () => {
    vi.mocked(api.sendChatMessage).mockResolvedValue({ conversationId: 'conversation-2', turnId: 'turn-1', ruleRunId: 'run-1', response: '2件です。', toolCallCount: 1, unreachableServers: [] });
    vi.mocked(api.chatTurns).mockResolvedValue([chatTurn()]);
    const user = userEvent.setup();
    renderScreen('chat', chat);
    await screen.findByRole('button', { name: '先週の確認' });

    await user.type(screen.getByLabelText('メッセージ'), '来週の予定は?');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(await screen.findByText('2件です。')).toBeTruthy();
    expect(api.sendChatMessage).toHaveBeenCalledWith(ACCOUNT_ID, { conversationId: null, message: '来週の予定は?' });
    expect(api.chatTurns).toHaveBeenCalledWith(ACCOUNT_ID, 'conversation-2');
  });

  it('opens an earlier conversation and continues it', async () => {
    vi.mocked(api.chatTurns).mockResolvedValue([chatTurn({ request: '先週は?', response: '3件でした。' })]);
    const user = userEvent.setup();
    renderScreen('chat', chat);

    await user.click(await screen.findByRole('button', { name: '先週の確認' }));

    expect(await screen.findByText('3件でした。')).toBeTruthy();
    expect(api.chatTurns).toHaveBeenCalledWith(ACCOUNT_ID, 'conversation-1');
  });
});

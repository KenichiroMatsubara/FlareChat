import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutomationRun } from '@mail/domain';

import { api } from '../api';
import { ACCOUNT_ID, automation, contactList, prompt } from './fixtures';
import { renderScreen } from './render';
import * as automations from './automations';

vi.mock('../api');

const run = (overrides: Partial<AutomationRun>): AutomationRun => ({
  id: 'run-1',
  startedAt: '2026-08-18T09:00:00.000Z',
  finishedAt: '2026-08-18T09:00:12.000Z',
  status: 'completed',
  output: '未回答は2名でした。',
  error: null,
  toolCalls: 3,
  ...overrides,
});

describe('Automation run history', () => {
  it('shows what a completed run reported', () => {
    const markup = renderToStaticMarkup(<automations.AutomationRunList runs={[run({})]} />);

    expect(markup).toContain('未回答は2名でした。');
    expect(markup).toContain('ツール 3 回');
  });

  it('shows why a run failed rather than hiding it', () => {
    const markup = renderToStaticMarkup(
      <automations.AutomationRunList runs={[run({ status: 'failed', output: null, error: 'model unavailable' })]} />,
    );

    expect(markup).toContain('model unavailable');
    expect(markup).toContain('automation-run-failed');
  });

  it('says nothing has run yet rather than rendering an empty list', () => {
    expect(renderToStaticMarkup(<automations.AutomationRunList runs={[]} />)).toContain('まだ実行されていません。');
  });
});

describe('Automations screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.automations).mockResolvedValue([automation()]);
    vi.mocked(api.prompts).mockResolvedValue([prompt()]);
    vi.mocked(api.contactLists).mockResolvedValue([contactList()]);
  });

  it('lists the Automations with their next run', async () => {
    renderScreen('automations', automations);

    expect(await screen.findByText('朝の確認')).toBeTruthy();
    expect(screen.getByText('次回 2026-09-03T00:00:00.000Z')).toBeTruthy();
  });

  it('saves a new Automation with the tools it was granted and re-reads the list', async () => {
    vi.mocked(api.saveAutomation).mockResolvedValue({ id: 'automation-2', nextRunAt: null });
    vi.mocked(api.automations).mockResolvedValueOnce([automation()]).mockResolvedValue([automation(), automation({ id: 'automation-2', name: '夕方の確認' })]);
    const user = userEvent.setup();
    renderScreen('automations', automations);
    await screen.findByText('朝の確認');

    await user.type(screen.getByLabelText('名前'), '夕方の確認');
    await user.click(screen.getByRole('checkbox', { name: 'channel.send' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('夕方の確認')).toBeTruthy();
    expect(api.saveAutomation).toHaveBeenCalledWith(ACCOUNT_ID, expect.any(String), expect.objectContaining({
      name: '夕方の確認',
      promptId: 'prompt-1',
      contactListId: 'list-1',
      tools: expect.arrayContaining(['channel.send']),
    }));
    await waitFor(() => expect(api.automations).toHaveBeenCalledTimes(2));
  });

  it('shows what a run did when its history is opened', async () => {
    vi.mocked(api.automationRuns).mockResolvedValue([run({})]);
    const user = userEvent.setup();
    renderScreen('automations', automations);

    await user.click(await screen.findByRole('button', { name: '実行履歴' }));

    expect(await screen.findByText('未回答は2名でした。')).toBeTruthy();
    expect(api.automationRuns).toHaveBeenCalledWith(ACCOUNT_ID, 'automation-1');
  });
});

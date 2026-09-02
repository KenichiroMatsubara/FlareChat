import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, prompt } from './fixtures';
import { deferred, renderScreen } from './render';
import * as prompts from './prompts';

vi.mock('../api');

describe('Prompts screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.prompts).mockResolvedValue([prompt(), prompt({ id: 'prompt-2', name: 'Evening check' })]);
  });

  it('creates a Prompt and re-reads the list', async () => {
    vi.mocked(api.createPrompt).mockResolvedValue(prompt({ id: 'prompt-3', name: 'Weekly digest' }));
    vi.mocked(api.prompts).mockResolvedValueOnce([prompt()]).mockResolvedValue([prompt(), prompt({ id: 'prompt-3', name: 'Weekly digest' })]);
    const user = userEvent.setup();
    const { container } = renderScreen('prompts', prompts);
    await screen.findByText('Morning check');
    const form = within(container.querySelector('form.rule-builder') as HTMLElement);

    await user.type(form.getByLabelText('Prompt名'), 'Weekly digest');
    await user.type(form.getByLabelText('Instructions'), 'Summarise the week.');
    await user.click(form.getByRole('button', { name: 'Promptを作成' }));

    expect(await screen.findByText('Weekly digest')).toBeTruthy();
    expect(api.createPrompt).toHaveBeenCalledWith(ACCOUNT_ID, { name: 'Weekly digest', instructions: 'Summarise the week.' });
  });

  it('never lends one Prompt\'s progress to another control', async () => {
    const removal = deferred<{ id: string; removed: boolean }>();
    vi.mocked(api.removePrompt).mockReturnValue(removal.promise);
    const user = userEvent.setup();
    renderScreen('prompts', prompts);
    const [first, second] = await screen.findAllByRole('button', { name: 'Promptを削除' });

    await user.click(first as HTMLElement);

    expect(await screen.findByText('削除中…')).toBeTruthy();
    expect(second).toHaveProperty('disabled', false);
    removal.resolve({ id: 'prompt-1', removed: true });
    await waitFor(() => expect(api.removePrompt).toHaveBeenCalledWith(ACCOUNT_ID, 'prompt-1'));
    await waitFor(() => expect(api.prompts).toHaveBeenCalledTimes(2));
  });
});

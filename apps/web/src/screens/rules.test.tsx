import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, agentRule, contactList, prompt, schemaRule } from './fixtures';
import { renderScreen } from './render';
import * as rules from './rules';

vi.mock('../api');

describe('Rules screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.rules).mockResolvedValue([schemaRule(), schemaRule({ id: 'rule-2', name: 'Invitations', noticeContactListId: 'list-1' })]);
    vi.mocked(api.agentRules).mockResolvedValue([agentRule()]);
    vi.mocked(api.prompts).mockResolvedValue([prompt()]);
    vi.mocked(api.contactLists).mockResolvedValue([contactList()]);
    vi.mocked(api.presets).mockResolvedValue([{ id: 'membership', name: 'Membership organization', description: 'Starting configuration.' }]);
  });

  it('indexes both rule types and says in the index when a summary would reach nobody', async () => {
    renderScreen('rules', rules);

    expect(await screen.findByText('Announcements')).toBeTruthy();
    expect(screen.getByText('Invitations')).toBeTruthy();
    expect(screen.getByText('Triage')).toBeTruthy();
    expect(screen.getAllByText('要約の送り先が未設定です')).toHaveLength(1);
    expect(screen.getByText('要約の送り先 1件')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'このルールを設定' })).toHaveLength(3);
    expect(api.ruleRuns).not.toHaveBeenCalled();
    expect(api.deliveries).not.toHaveBeenCalled();
  });

  it('creates a Schema Rule from its selection and re-reads the index', async () => {
    vi.mocked(api.createRule).mockResolvedValue(schemaRule({ id: 'rule-3', name: 'Newsletters' }));
    const user = userEvent.setup();
    renderScreen('rules', rules);
    await screen.findByText('Announcements');

    await user.type(screen.getByLabelText('ルール名'), 'Newsletters');
    await user.type(screen.getByLabelText('送信元ドメイン', { selector: 'form.rule-builder:nth-of-type(1) input' }), 'news.example.org');
    await user.click(screen.getByRole('button', { name: 'Schema Rule を作成' }));

    await waitFor(() => expect(api.createRule).toHaveBeenCalledWith(ACCOUNT_ID, expect.objectContaining({
      name: 'Newsletters',
      state: 'draft',
      executionMode: 'unattended',
      selectionPolicy: { domain: 'news.example.org' },
    })));
    await waitFor(() => expect(api.rules).toHaveBeenCalledTimes(2));
  });

  it('requires an explicit choice before adding a Preset beside existing configuration', async () => {
    vi.mocked(api.applyPreset).mockResolvedValue({ presetId: 'membership', typedLists: 1, prompts: 1, schemaRules: 1, agentRules: 0 });
    const user = userEvent.setup();
    renderScreen('rules', rules);
    const apply = await screen.findByRole('button', { name: 'Presetを適用' });
    expect(apply).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('checkbox', { name: '既存の構成に別のコピーを追加する' }));
    await user.click(apply);

    await waitFor(() => expect(api.applyPreset).toHaveBeenCalledWith(ACCOUNT_ID, 'membership', 'duplicate'));
  });
});

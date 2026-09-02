import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, agentRule, agentRun, prompt, ruleRun, transcript } from './fixtures';
import { renderScreen } from './render';
import * as screenModule from './agent-rule';

vi.mock('../api');

const path = 'rules/agent/:ruleId';
const url = `/organizations/${ACCOUNT_ID}/rules/agent/agent-1`;

describe('Agent Rule screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.agentRules).mockResolvedValue([agentRule()]);
    vi.mocked(api.prompts).mockResolvedValue([prompt()]);
    vi.mocked(api.lists).mockResolvedValue([]);
    vi.mocked(api.ruleRuns).mockResolvedValue([ruleRun({ rule: { type: 'agent', id: 'agent-1', revision: 1 }, status: 'completed' })]);
    vi.mocked(api.agentRuns).mockResolvedValue([agentRun()]);
  });

  it('shows the Rule with its Prompt, its runs, and its transcripts', async () => {
    renderScreen(path, screenModule, url);

    expect(await screen.findByRole('heading', { level: 1, name: 'Triage' })).toBeTruthy();
    expect(screen.getByText(/Prompt: Morning check/u)).toBeTruthy();
    expect(screen.getByText('Run Transcripts').nextElementSibling?.textContent).toBe('1件');
  });

  it('changes the Rule State and re-reads the Rule', async () => {
    vi.mocked(api.updateAgentRule).mockResolvedValue(agentRule({ state: 'active' }));
    vi.mocked(api.agentRules).mockResolvedValueOnce([agentRule()]).mockResolvedValue([agentRule({ state: 'active' })]);
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);
    await screen.findByRole('heading', { level: 1, name: 'Triage' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Triageの状態' }), 'active');

    await waitFor(() => expect(api.updateAgentRule).toHaveBeenCalledWith(ACCOUNT_ID, 'agent-1', { state: 'active' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Triageの状態' })).toHaveProperty('value', 'active'));
  });

  it('opens a Run Transcript beside the run', async () => {
    vi.mocked(api.runTranscript).mockResolvedValue(transcript());
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);

    await user.click(await screen.findByRole('button', { name: 'Run Transcriptを読む' }));

    expect(await screen.findByText('予定を1件作成しました。')).toBeTruthy();
    expect(api.runTranscript).toHaveBeenCalledWith(ACCOUNT_ID, 'agent-run-1');
  });

  it('says when the Prompt the Rule needs is gone', async () => {
    vi.mocked(api.prompts).mockResolvedValue([]);
    renderScreen(path, screenModule, url);

    expect(await screen.findByText(/Prompt が見つかりません/u)).toBeTruthy();
  });
});

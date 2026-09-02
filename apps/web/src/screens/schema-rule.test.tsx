import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, automationStatus, cadence, connections, contact, contactList, delivery, ruleRun, schemaRule } from './fixtures';
import { renderScreen } from './render';
import * as screenModule from './schema-rule';

vi.mock('../api');

const path = 'rules/schema/:ruleId';
const url = `/organizations/${ACCOUNT_ID}/rules/schema/rule-1`;

describe('Schema Rule screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.rules).mockResolvedValue([schemaRule()]);
    vi.mocked(api.connections).mockResolvedValue(connections({ ai: { apiKeyConfigured: false, model: '', baseUrl: '' } }));
    vi.mocked(api.currentAutomation).mockResolvedValue(automationStatus());
    vi.mocked(api.contacts).mockResolvedValue([contact(), contact({ id: 'contact-2', name: '全体グループ', email: '' }), contact({ id: 'contact-3', name: '届かない人', email: '' })]);
    vi.mocked(api.channelTestTargets).mockResolvedValue([{ id: 'contact-2', name: '全体グループ', email: '', state: 'active', channels: ['line'] }]);
    vi.mocked(api.contactLists).mockResolvedValue([contactList()]);
    vi.mocked(api.lists).mockResolvedValue([]);
    vi.mocked(api.taskReminders).mockResolvedValue(cadence());
    vi.mocked(api.ruleRuns).mockResolvedValue([ruleRun(), ruleRun({ id: 'run-2', rule: { type: 'schema', id: 'rule-9', revision: 1 } })]);
    vi.mocked(api.deliveries).mockResolvedValue([delivery()]);
  });

  it('shows the whole Rule and says what is missing', async () => {
    renderScreen(path, screenModule, url);

    expect(await screen.findByRole('heading', { level: 1, name: 'Announcements' })).toBeTruthy();
    expect(screen.getByText(/AI 接続が設定されていません/u)).toBeTruthy();
    expect(screen.getByText(/要約の送り先が選ばれていません/u)).toBeTruthy();
    expect(screen.getByText('7日前、3日前、1日前、当日に送ります')).toBeTruthy();
  });

  it('offers the Contacts a notice can reach, on the Channel each is reachable on, and leaves out those it cannot', async () => {
    renderScreen(path, screenModule, url);
    await screen.findByRole('heading', { level: 1, name: 'Announcements' });

    expect(screen.getByRole('checkbox', { name: /山田 太郎/u })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /全体グループ/u })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /届かない人/u })).toBeNull();
  });

  it('stores the chosen readers as the Rule\'s own Contact List and points the Rule at it', async () => {
    vi.mocked(api.saveContactList).mockResolvedValue({ id: 'new-list' });
    vi.mocked(api.updateRule).mockResolvedValue({ id: 'rule-1', noticeContactListId: 'new-list' });
    vi.mocked(api.rules).mockResolvedValueOnce([schemaRule()]).mockResolvedValue([schemaRule({ noticeContactListId: 'new-list' })]);
    vi.mocked(api.contactLists).mockResolvedValueOnce([contactList()]).mockResolvedValue([contactList(), contactList({ id: 'new-list', contactIds: ['contact-1'] })]);
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);
    await screen.findByRole('heading', { level: 1, name: 'Announcements' });

    await user.click(screen.getByRole('checkbox', { name: /山田 太郎/u }));
    await user.click(screen.getByRole('button', { name: '要約の送り先を保存' }));

    await waitFor(() => expect(api.saveContactList).toHaveBeenCalledWith(ACCOUNT_ID, expect.any(String), { name: 'Announcements の要約送り先', contactIds: ['contact-1'] }));
    const listId = vi.mocked(api.saveContactList).mock.calls[0]?.[1];
    expect(api.updateRule).toHaveBeenCalledWith(ACCOUNT_ID, 'rule-1', { noticeContactListId: listId });
    await waitFor(() => expect(screen.queryByText(/要約の送り先が選ばれていません/u)).toBeNull());
  });

  it('edits what the Rule matches for the life of the Rule', async () => {
    vi.mocked(api.updateRule).mockResolvedValue({ id: 'rule-1' });
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);
    await screen.findByRole('heading', { level: 1, name: 'Announcements' });

    await user.type(screen.getByLabelText('本文・件名のキーワード'), '招待');
    await user.click(screen.getByRole('button', { name: '拾うメールを保存' }));

    await waitFor(() => expect(api.updateRule).toHaveBeenCalledWith(ACCOUNT_ID, 'rule-1', {
      name: 'Announcements',
      selectionPolicy: { domain: 'example.org', keyword: '招待' },
      priority: 10,
    }));
  });

  it('shows only this Rule\'s runs and decides a pending one where it was planned', async () => {
    vi.mocked(api.decideRuleRun).mockResolvedValue(ruleRun({ status: 'completed' }));
    const user = userEvent.setup();
    renderScreen(path, screenModule, url);
    await screen.findByRole('heading', { level: 1, name: 'Announcements' });

    expect(screen.getByText('このルールの実行履歴').nextElementSibling?.textContent).toBe('1件');
    await user.click(screen.getByRole('button', { name: 'すべて承認して実行' }));

    await waitFor(() => expect(api.decideRuleRun).toHaveBeenCalledWith(ACCOUNT_ID, 'run-1', 'approve'));
  });

  it('says so inside the shell when the Rule does not exist', async () => {
    renderScreen(path, screenModule, `/organizations/${ACCOUNT_ID}/rules/schema/missing`);

    expect(await screen.findByText('この画面の対象が見つかりません。')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'メインナビゲーション' })).toBeTruthy();
  });
});

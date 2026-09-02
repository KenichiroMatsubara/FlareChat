import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, connections, contact, lineHandle, typedList } from './fixtures';
import { renderScreen } from './render';
import * as contacts from './contacts';

vi.mock('../api');

describe('Contacts screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.contacts).mockResolvedValue([contact(), contact({ id: 'contact-2', name: '届かない人', email: '' })]);
    vi.mocked(api.lineHandles).mockResolvedValue([lineHandle(), lineHandle({ id: 'handle-2', destinationId: 'Uabc2', displayName: '', source: 'manual' })]);
    vi.mocked(api.connections).mockResolvedValue(connections());
    vi.mocked(api.lists).mockResolvedValue([typedList()]);
    vi.mocked(api.channelTestTargets).mockResolvedValue([{ id: 'contact-1', name: '山田 太郎', email: 'taro@example.com', state: 'active', channels: ['line'] }]);
  });

  it('shows the roster, the pending LINE handles, and names the Contacts nothing can reach', async () => {
    renderScreen('contacts', contacts);

    expect(await screen.findByText('2件のLINEアカウントが登録待ちです')).toBeTruthy();
    expect(screen.getByText('・手動登録', { exact: false })).toBeTruthy();
    expect(screen.getByText(/届かない人にはメールアドレスも LINE もありません/u)).toBeTruthy();
    expect(screen.getByText('Board（recipient）')).toBeTruthy();
  });

  it('registers a Contact from a discovered LINE handle and re-reads the roster', async () => {
    vi.mocked(api.createContact).mockResolvedValue(contact({ id: 'contact-3', name: '花子' }));
    vi.mocked(api.contacts).mockResolvedValueOnce([contact()]).mockResolvedValue([contact(), contact({ id: 'contact-3', name: '花子' })]);
    const user = userEvent.setup();
    renderScreen('contacts', contacts);
    await screen.findByText('LINEアカウント');

    await user.selectOptions(screen.getByLabelText('LINEアカウント'), 'handle-1');
    expect(screen.getByLabelText('名称')).toHaveProperty('value', '花子');
    await user.type(screen.getByLabelText('説明'), '広報');
    await user.click(screen.getByRole('button', { name: '連絡先を追加' }));

    await waitFor(() => expect(api.createContact).toHaveBeenCalledWith(ACCOUNT_ID, { name: '花子', description: '広報', tags: [], lineDestinationId: 'handle-1' }));
    expect(await screen.findByRole('heading', { level: 3, name: '花子' })).toBeTruthy();
  });

  it('removes a Contact only after the Account confirms, and re-reads the roster', async () => {
    vi.mocked(api.deleteContact).mockResolvedValue({ id: 'contact-1', removed: true });
    vi.mocked(api.contacts).mockResolvedValueOnce([contact()]).mockResolvedValue([]);
    const user = userEvent.setup();
    renderScreen('contacts', contacts);
    const remove = await screen.findByRole('button', { name: '山田 太郎を削除' });

    await user.click(remove);
    expect(screen.getByText(/「山田 太郎」を削除しますか/u)).toBeTruthy();
    expect(api.deleteContact).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '削除する' }));

    await waitFor(() => expect(api.deleteContact).toHaveBeenCalledWith(ACCOUNT_ID, 'contact-1'));
    expect(await screen.findByText('連絡先はまだ登録されていません')).toBeTruthy();
  });

  it('shows the Worker\'s reason when a Contact cannot be added', async () => {
    vi.mocked(api.createContact).mockRejectedValue(new Error('このメールアドレスは既に「山田 太郎」に登録されています。'));
    const user = userEvent.setup();
    renderScreen('contacts', contacts);
    await screen.findByText('LINEアカウント');

    await user.type(screen.getByLabelText('名称'), '同じメールの人');
    await user.type(screen.getByLabelText('メールアドレス（任意）'), 'taro@example.com');
    await user.click(screen.getByRole('button', { name: '連絡先を追加' }));

    expect(await screen.findByText('このメールアドレスは既に「山田 太郎」に登録されています。')).toBeTruthy();
  });

  it('saves an edited Contact and reports the save on that card alone', async () => {
    vi.mocked(api.updateContact).mockResolvedValue({ id: 'contact-1' });
    const user = userEvent.setup();
    renderScreen('contacts', contacts);
    const [edit] = await screen.findAllByRole('button', { name: '編集' });

    await user.click(edit as HTMLElement);
    await user.selectOptions(screen.getByLabelText('状態'), 'inactive');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(api.updateContact).toHaveBeenCalledWith(ACCOUNT_ID, 'contact-1', expect.objectContaining({ name: '山田 太郎', state: 'inactive' })));
  });
});

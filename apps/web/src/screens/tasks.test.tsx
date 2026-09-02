import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { ACCOUNT_ID, cadence, contact, task } from './fixtures';
import { deferred, renderScreen } from './render';
import * as tasks from './tasks';

vi.mock('../api');

describe('Tasks screen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.tasks).mockResolvedValue([task(), task({ id: 'task-2', title: '会場を予約する', assigneeContactId: null, assigneeName: '' })]);
    vi.mocked(api.contacts).mockResolvedValue([contact(), contact({ id: 'contact-2', name: '退会者', state: 'inactive' })]);
    vi.mocked(api.taskReminders).mockResolvedValue(cadence());
    vi.mocked(api.attendanceReminders).mockResolvedValue(cadence({ enabled: false, days: [7] }));
    vi.mocked(api.reminderSchedule).mockResolvedValue([]);
  });

  it('names the Contact each Task was given to and offers only active Contacts to hand it on', async () => {
    renderScreen('tasks', tasks);

    const assignee = await screen.findByRole('combobox', { name: '参加費を振り込むの担当' });
    expect(assignee).toHaveProperty('value', 'contact-1');
    expect([...assignee.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['未割り当て', '山田 太郎']);
    expect(screen.getByText('タスクのリマインドは有効です')).toBeTruthy();
    expect(screen.getByText('出欠のリマインドは停止中です')).toBeTruthy();
  });

  it('reports the Task whose row is being written, not the whole table', async () => {
    const update = deferred<ReturnType<typeof task>>();
    vi.mocked(api.updateTask).mockReturnValue(update.promise);
    const user = userEvent.setup();
    renderScreen('tasks', tasks);

    await user.click(await screen.findByRole('checkbox', { name: '参加費を振り込むを完了' }));

    expect(screen.getByRole('checkbox', { name: '参加費を振り込むを完了' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: '会場を予約するを完了' })).toHaveProperty('disabled', false);
    update.resolve(task({ completed: true }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ACCOUNT_ID, 'task-1', { completed: true }));
    await waitFor(() => expect(api.tasks).toHaveBeenCalledTimes(2));
  });

  it('turns attendance reminders on from the same screen', async () => {
    vi.mocked(api.saveAttendanceReminders).mockResolvedValue(cadence({ days: [7] }));
    const user = userEvent.setup();
    renderScreen('tasks', tasks);

    await user.click(await screen.findByRole('checkbox', { name: '出欠のリマインドを切り替える' }));

    await waitFor(() => expect(api.saveAttendanceReminders).toHaveBeenCalledWith(ACCOUNT_ID, { enabled: true }));
  });
});

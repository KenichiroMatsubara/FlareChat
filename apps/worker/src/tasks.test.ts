import { afterEach, describe, expect, it } from 'vitest';

import { createMigratedTestD1, type TestD1Database } from '../test/d1';
import { organizationDatabase } from './storage/database';
import { members, sourceMessages } from './storage/organization-schema';
import { createTaskWorkflow } from './tasks';

const openDatabases: TestD1Database[] = [];

const seedMember = async (drizzle: ReturnType<typeof organizationDatabase>): Promise<void> => {
  await drizzle.insert(members).values({
    id: 'member-1', organizationId: 'organization-1', name: '会計担当', email: 'kaikei@example.com',
    state: 'active', tags: '[]', createdAt: '2026-08-01', updatedAt: '2026-08-01',
  }).run();
};

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Operational Task Role workflow', () => {
  it('keeps the role display name captured by a Task when its Organization role is renamed', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    const drizzle = organizationDatabase(database.binding);
    const workflow = createTaskWorkflow(drizzle);
    await seedMember(drizzle);
    await drizzle.insert(sourceMessages).values({
      id: 'source-1',
      gmailMessageId: 'gmail-1',
      gmailHistoryId: 'history-1',
      sender: 'sender@example.com',
      subject: '年次行事',
      receivedAt: '2026-08-02T00:00:00.000Z',
      state: 'processing',
    }).run();

    const role = await workflow.createRole({
      displayName: '参加登録担当',
      description: '参加登録と出欠期限を扱う',
    });
    await workflow.assignRole({ roleId: role.id, memberId: 'member-1', displayName: '会計担当' });
    await workflow.createFromSourceMessage({
      organizationId: 'organization-1',
      sourceMessageId: 'source-1',
      sourceMessageSubject: '年次行事',
      extractedTasks: [{
        title: '参加登録を確認する',
        deadline: '2026-08-20',
        assigneeRoleId: role.id,
        description: '登録状況を取りまとめる',
      }],
    });

    await workflow.updateRole(role.id, { displayName: '出欠管理担当' });

    await expect(workflow.list()).resolves.toEqual([
      expect.objectContaining({
        assigneeRoleId: role.id,
        assigneeRoleName: '参加登録担当',
        assigneeMemberId: 'member-1',
        assigneeName: '会計担当',
      }),
    ]);
  });

  it('removes an Organization role and its current assignment without deleting historical Tasks', async () => {
    const database = createMigratedTestD1('organization');
    openDatabases.push(database);
    const drizzle = organizationDatabase(database.binding);
    const workflow = createTaskWorkflow(drizzle);
    await seedMember(drizzle);
    await drizzle.insert(sourceMessages).values({
      id: 'source-2', gmailMessageId: 'gmail-2', gmailHistoryId: 'history-2',
      sender: 'sender@example.com', subject: '支払案内',
      receivedAt: '2026-08-02T00:00:00.000Z', state: 'processing',
    }).run();
    const role = await workflow.createRole({ displayName: '支払担当', description: '支払期限を扱う' });
    await workflow.assignRole({ roleId: role.id, memberId: 'member-1', displayName: '会計担当' });
    await workflow.createFromSourceMessage({
      organizationId: 'organization-1', sourceMessageId: 'source-2', sourceMessageSubject: '支払案内',
      extractedTasks: [{ title: '参加費を支払う', deadline: '2026-08-25', assigneeRoleId: role.id, description: '指定口座へ送金する' }],
    });

    await expect(workflow.deleteRole(role.id)).resolves.toBe(true);

    await expect(workflow.listRoles()).resolves.toEqual([]);
    await expect(workflow.list()).resolves.toEqual([
      expect.objectContaining({ assigneeRoleId: role.id, assigneeRoleName: '支払担当' }),
    ]);
  });
});

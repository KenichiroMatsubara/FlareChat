import { describe, expect, it, vi } from 'vitest';

import { createMigratedTestD1 } from '../test/d1';
import { accountDatabase } from './storage/database';
import {
  ATTACHMENT_FOLDER_PATH_SETTING,
  accountAttachmentFolderPath,
  resolveSourceMessageFolder,
  saveAccountAttachmentFolderPath,
} from './attachment-folders';

const seedSourceMessage = (database: ReturnType<typeof createMigratedTestD1>, id: string): void => {
  database.execute(
    `INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
     VALUES (?, ?, 'history-1', 'sender@example.com', '年次行事', '2026-08-01T09:00:00+09:00', 'processing')`,
    id,
    `gmail-${id}`,
  );
};

const drivePort = () => ({
  ensurePath: vi.fn(async () => 'attachment-folder-leaf'),
  createMessageFolder: vi.fn(async () => 'source-message-folder'),
});

describe('Attachment Folder Path setting', () => {
  it('falls back to the product default until an Account writes its own path', async () => {
    const test = createMigratedTestD1('organization');
    try {
      const database = accountDatabase(test.binding);
      await expect(accountAttachmentFolderPath(database)).resolves.toBe('Mail Automation');

      await saveAccountAttachmentFolderPath(database, '会計 2026/添付', '2026-08-01T00:00:00.000Z');

      await expect(accountAttachmentFolderPath(database)).resolves.toBe('会計 2026/添付');
      expect(test.rows<{ key: string }>('SELECT key FROM settings')).toEqual([{ key: ATTACHMENT_FOLDER_PATH_SETTING }]);
    } finally {
      test.close();
    }
  });
});

describe('Source Message attachment folder', () => {
  it('creates one folder under the configured path and records it on the Source Message', async () => {
    const test = createMigratedTestD1('organization');
    try {
      seedSourceMessage(test, 'source-1');
      const database = accountDatabase(test.binding);
      await saveAccountAttachmentFolderPath(database, '会計 2026/添付', '2026-08-01T00:00:00.000Z');
      const drive = drivePort();

      await expect(resolveSourceMessageFolder({
        database,
        drive,
        accessToken: 'token',
        subject: '年次行事',
        receivedAt: '2026-08-01T09:00:00+09:00',
        recordedFolderId: null,
        sourceMessageId: 'source-1',
      })).resolves.toBe('source-message-folder');

      expect(drive.ensurePath).toHaveBeenCalledWith({ accessToken: 'token', segments: ['会計 2026', '添付'] });
      expect(drive.createMessageFolder).toHaveBeenCalledWith({
        accessToken: 'token',
        parentId: 'attachment-folder-leaf',
        name: '2026-08-01 年次行事',
      });
      expect(test.rows<{ drive_folder_id: string }>('SELECT drive_folder_id FROM source_messages'))
        .toEqual([{ drive_folder_id: 'source-message-folder' }]);
    } finally {
      test.close();
    }
  });

  it('reuses the recorded folder so reprocessing one Source Message never creates a second', async () => {
    const test = createMigratedTestD1('organization');
    try {
      const drive = drivePort();

      await expect(resolveSourceMessageFolder({
        database: accountDatabase(test.binding),
        drive,
        accessToken: 'token',
        subject: '年次行事',
        receivedAt: '2026-08-01T09:00:00+09:00',
        recordedFolderId: 'already-created',
        sourceMessageId: 'source-1',
      })).resolves.toBe('already-created');

      expect(drive.ensurePath).not.toHaveBeenCalled();
      expect(drive.createMessageFolder).not.toHaveBeenCalled();
    } finally {
      test.close();
    }
  });

  it('refuses to publish into the Drive root when the stored path is unusable', async () => {
    const test = createMigratedTestD1('organization');
    try {
      const database = accountDatabase(test.binding);
      test.execute(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        ATTACHMENT_FOLDER_PATH_SETTING,
        '   ',
        '2026-08-01T00:00:00.000Z',
      );

      await expect(resolveSourceMessageFolder({
        database,
        drive: drivePort(),
        accessToken: 'token',
        subject: '年次行事',
        receivedAt: '2026-08-01T09:00:00+09:00',
      })).rejects.toThrow(/empty_path/u);
    } finally {
      test.close();
    }
  });
});

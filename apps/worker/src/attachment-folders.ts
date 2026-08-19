import { eq } from 'drizzle-orm';
import { DEFAULT_ATTACHMENT_FOLDER_PATH, readAttachmentFolderPath, sourceMessageFolderName } from '@mail/domain';

import { settings, sourceMessages } from './storage/account-schema';
import type { AccountDatabase } from './storage/database';
import type { createSourceMessageFolder, ensureAttachmentFolderPath } from './drive-attachments';

export const ATTACHMENT_FOLDER_PATH_SETTING = 'attachment_folder_path';

export interface DriveFolderPort {
  ensurePath: typeof ensureAttachmentFolderPath;
  createMessageFolder: typeof createSourceMessageFolder;
}

/** The Drive location this Account writes, falling back to the product default. */
export const accountAttachmentFolderPath = async (database: AccountDatabase): Promise<string> => {
  const stored = await database.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, ATTACHMENT_FOLDER_PATH_SETTING)).get();
  return stored?.value ?? DEFAULT_ATTACHMENT_FOLDER_PATH;
};

export const saveAccountAttachmentFolderPath = async (
  database: AccountDatabase,
  path: string,
  updatedAt: string,
): Promise<void> => {
  await database.insert(settings).values({ key: ATTACHMENT_FOLDER_PATH_SETTING, value: path, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value: path, updatedAt } }).run();
};

/**
 * Resolves the folder that holds one Source Message's Public Attachments,
 * creating the Attachment Folder Path if this application has not created it
 * yet. A folder already recorded for the Source Message is reused, so
 * reprocessing the same message never produces a second folder.
 */
export const resolveSourceMessageFolder = async (input: {
  database: AccountDatabase;
  drive: DriveFolderPort;
  accessToken: string;
  subject: string;
  receivedAt: string;
  recordedFolderId?: string | null | undefined;
  sourceMessageId?: string | undefined;
}): Promise<string> => {
  if (input.recordedFolderId) return input.recordedFolderId;
  const configured = readAttachmentFolderPath(await accountAttachmentFolderPath(input.database));
  if (!configured.accepted) throw new Error(`Attachment Folder Path is not usable (${configured.reason}).`);
  const parentId = await input.drive.ensurePath({ accessToken: input.accessToken, segments: configured.segments });
  const folderId = await input.drive.createMessageFolder({
    accessToken: input.accessToken,
    parentId,
    name: sourceMessageFolderName({ receivedAt: input.receivedAt, subject: input.subject }),
  });
  if (input.sourceMessageId) {
    await input.database.update(sourceMessages).set({ driveFolderId: folderId })
      .where(eq(sourceMessages.id, input.sourceMessageId)).run();
  }
  return folderId;
};

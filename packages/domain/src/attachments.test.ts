import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENT_FOLDER_PATH_SEGMENTS,
  MAX_ATTACHMENT_FOLDER_SEGMENT_CHARACTERS,
  MAX_SOURCE_MESSAGE_ATTACHMENTS,
  readAttachmentFolderPath,
  sourceMessageFolderName,
  validateAttachmentIntake,
} from './attachments';

describe('attachment intake limits', () => {
  it('withholds a Source Message when either its individual or aggregate attachment limit is exceeded', () => {
    expect(validateAttachmentIntake([20 * 1024 * 1024])).toEqual({ accepted: true });
    expect(validateAttachmentIntake([20 * 1024 * 1024 + 1])).toMatchObject({ accepted: false, reason: 'attachment_too_large' });
    expect(validateAttachmentIntake([15 * 1024 * 1024, 15 * 1024 * 1024, 11 * 1024 * 1024])).toMatchObject({ accepted: false, reason: 'source_message_too_large' });
  });

  it('withholds more attachments than one Calendar event can formally attach', () => {
    expect(validateAttachmentIntake(Array.from({ length: MAX_SOURCE_MESSAGE_ATTACHMENTS }, () => 1))).toEqual({ accepted: true });
    expect(validateAttachmentIntake(Array.from({ length: MAX_SOURCE_MESSAGE_ATTACHMENTS + 1 }, () => 1)))
      .toEqual({ accepted: false, reason: 'too_many_attachments' });
  });
});

describe('Attachment Folder Path', () => {
  it('keeps what the Account typed and treats a slash as the level separator', () => {
    expect(readAttachmentFolderPath('会計 2026/添付ファイル')).toEqual({
      accepted: true,
      segments: ['会計 2026', '添付ファイル'],
      path: '会計 2026/添付ファイル',
    });
  });

  it('drops empty segments so a leading, trailing, or doubled separator is not an error', () => {
    expect(readAttachmentFolderPath('/添付//ファイル/')).toMatchObject({ segments: ['添付', 'ファイル'] });
  });

  it('refuses an empty path, because an empty path is the Drive root', () => {
    expect(readAttachmentFolderPath('')).toEqual({ accepted: false, reason: 'empty_path' });
    expect(readAttachmentFolderPath('  /  ')).toEqual({ accepted: false, reason: 'empty_path' });
  });

  it('refuses control characters and paths beyond the product length bounds', () => {
    expect(readAttachmentFolderPath('添付ファイル')).toEqual({ accepted: false, reason: 'control_character' });
    expect(readAttachmentFolderPath('あ'.repeat(MAX_ATTACHMENT_FOLDER_SEGMENT_CHARACTERS + 1)))
      .toEqual({ accepted: false, reason: 'segment_too_long' });
    expect(readAttachmentFolderPath(Array.from({ length: MAX_ATTACHMENT_FOLDER_PATH_SEGMENTS + 1 }, () => 'a').join('/')))
      .toEqual({ accepted: false, reason: 'too_many_segments' });
  });
});

describe('Source Message folder name', () => {
  it('names the folder by the received date and subject', () => {
    expect(sourceMessageFolderName({ receivedAt: '2026-08-01T09:30:00+09:00', subject: '年次行事のご案内' }))
      .toBe('2026-08-01 年次行事のご案内');
  });

  it('falls back to the received date alone when the subject carries no visible text', () => {
    expect(sourceMessageFolderName({ receivedAt: '2026-08-01T09:30:00+09:00', subject: '   ' })).toBe('2026-08-01');
  });

  it('keeps the folder name within one segment bound', () => {
    const name = sourceMessageFolderName({ receivedAt: '2026-08-01T00:00:00Z', subject: 'あ'.repeat(200) });
    expect([...name]).toHaveLength(MAX_ATTACHMENT_FOLDER_SEGMENT_CHARACTERS);
  });
});

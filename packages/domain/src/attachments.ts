export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_SOURCE_MESSAGE_ATTACHMENT_BYTES = 40 * 1024 * 1024;
export const MAX_SOURCE_MESSAGE_ATTACHMENTS = 25;

export type AttachmentIntakeResult =
  | { accepted: true }
  | { accepted: false; reason: 'attachment_too_large' | 'source_message_too_large' | 'too_many_attachments' };

export const validateAttachmentIntake = (attachmentBytes: number[]): AttachmentIntakeResult => {
  if (attachmentBytes.length > MAX_SOURCE_MESSAGE_ATTACHMENTS) return { accepted: false, reason: 'too_many_attachments' };
  if (attachmentBytes.some((bytes) => bytes > MAX_ATTACHMENT_BYTES)) return { accepted: false, reason: 'attachment_too_large' };
  if (attachmentBytes.reduce((total, bytes) => total + bytes, 0) > MAX_SOURCE_MESSAGE_ATTACHMENT_BYTES) return { accepted: false, reason: 'source_message_too_large' };
  return { accepted: true };
};

export const DEFAULT_ATTACHMENT_FOLDER_PATH = 'Mail Automation';
export const MAX_ATTACHMENT_FOLDER_PATH_SEGMENTS = 8;
export const MAX_ATTACHMENT_FOLDER_SEGMENT_CHARACTERS = 100;

export type AttachmentFolderPathResult =
  | { accepted: true; segments: string[]; path: string }
  | { accepted: false; reason: 'empty_path' | 'control_character' | 'segment_too_long' | 'too_many_segments' };

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

/**
 * Reads the Drive location an Organization typed. `/` separates levels; empty
 * segments are dropped rather than rejected so that a leading, trailing, or
 * doubled separator is not an error. Surrounding whitespace is removed from
 * each segment because it is invisible in the GUI yet produces a different
 * Drive folder. Everything else is kept as typed.
 */
export const readAttachmentFolderPath = (value: string): AttachmentFolderPathResult => {
  if (CONTROL_CHARACTERS.test(value)) return { accepted: false, reason: 'control_character' };
  const segments = value.split('/').map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return { accepted: false, reason: 'empty_path' };
  if (segments.length > MAX_ATTACHMENT_FOLDER_PATH_SEGMENTS) return { accepted: false, reason: 'too_many_segments' };
  if (segments.some((segment) => [...segment].length > MAX_ATTACHMENT_FOLDER_SEGMENT_CHARACTERS)) {
    return { accepted: false, reason: 'segment_too_long' };
  }
  return { accepted: true, segments, path: segments.join('/') };
};

/**
 * Names one Source Message's folder by its received date and subject, so that
 * every element is known before the Scheduled Event it belongs to exists.
 */
export const sourceMessageFolderName = (input: { receivedAt: string; subject: string }): string => {
  const date = input.receivedAt.slice(0, 10);
  const subject = input.subject.replaceAll(/[\u0000-\u001F\u007F]/gu, ' ').replaceAll('/', ' ').trim().replace(/\s+/gu, ' ');
  if (!subject) return date;
  const room = MAX_ATTACHMENT_FOLDER_SEGMENT_CHARACTERS - date.length - 1;
  const characters = [...subject];
  return `${date} ${characters.length > room ? characters.slice(0, room).join('') : subject}`;
};

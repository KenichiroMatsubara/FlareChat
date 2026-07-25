export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_SOURCE_MESSAGE_ATTACHMENT_BYTES = 40 * 1024 * 1024;

export type AttachmentIntakeResult =
  | { accepted: true }
  | { accepted: false; reason: 'attachment_too_large' | 'source_message_too_large' };

export const validateAttachmentIntake = (attachmentBytes: number[]): AttachmentIntakeResult => {
  if (attachmentBytes.some((bytes) => bytes > MAX_ATTACHMENT_BYTES)) return { accepted: false, reason: 'attachment_too_large' };
  if (attachmentBytes.reduce((total, bytes) => total + bytes, 0) > MAX_SOURCE_MESSAGE_ATTACHMENT_BYTES) return { accepted: false, reason: 'source_message_too_large' };
  return { accepted: true };
};

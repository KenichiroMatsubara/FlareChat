import { describe, expect, it } from 'vitest';

import { MAX_SOURCE_MESSAGE_ATTACHMENTS, validateAttachmentIntake } from './attachments';

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

import { describe, expect, it } from 'vitest';

import { decideSourceMessageAdmission } from './source-message-admission';

describe('Source Message admission', () => {
  it.each([
    ['SENT', 'sent'],
    ['DRAFT', 'discarded_mailbox_state'],
    ['SPAM', 'discarded_mailbox_state'],
    ['TRASH', 'discarded_mailbox_state'],
  ] as const)('ignores the Gmail %s mailbox state before AI', (label, reason) => {
    expect(decideSourceMessageAdmission({ labelIds: [label] })).toEqual({ kind: 'ignore', reason });
  });

  it('ignores Gmail-classified promotions even when they advertise a dated event', () => {
    expect(decideSourceMessageAdmission({
      labelIds: ['CATEGORY_PROMOTIONS', 'INBOX'],
      payload: { headers: [{ name: 'Subject', value: '7月29日開催 特別ご招待' }] },
    })).toEqual({ kind: 'ignore', reason: 'promotion' });
  });

  it.each([
    { mimeType: 'text/calendar' },
    { mimeType: 'application/ics' },
    { filename: 'invite.ics', mimeType: 'application/octet-stream' },
    { headers: [{ name: 'Content-Type', value: 'text/calendar; charset="UTF-8"; method=REPLY' }] },
  ])('ignores iCalendar transport without reading its prose as a new event', (calendarPart) => {
    expect(decideSourceMessageAdmission({
      labelIds: ['CATEGORY_PERSONAL', 'INBOX'],
      payload: { mimeType: 'multipart/mixed', parts: [calendarPart] },
    })).toEqual({ kind: 'ignore', reason: 'calendar_transport' });
  });

  it('ignores a Google Calendar notification even when Gmail omits its calendar MIME part', () => {
    expect(decideSourceMessageAdmission({
      labelIds: ['INBOX'],
      payload: { headers: [{ name: 'Message-ID', value: '<calendar-run-1@google.com>' }] },
    })).toEqual({ kind: 'ignore', reason: 'calendar_transport' });
  });

  it('does not reject useful mail from a subject keyword or CATEGORY_UPDATES alone', () => {
    expect(decideSourceMessageAdmission({
      labelIds: ['CATEGORY_UPDATES', 'INBOX'],
      payload: { headers: [{ name: 'Subject', value: '学生向け説明会へのご招待' }] },
    })).toEqual({ kind: 'admit' });
  });

  it('admits an ordinary Source Message', () => {
    expect(decideSourceMessageAdmission({
      labelIds: ['CATEGORY_PERSONAL', 'INBOX'],
      payload: { headers: [{ name: 'Subject', value: '地区大会のご案内' }] },
    })).toEqual({ kind: 'admit' });
  });
});

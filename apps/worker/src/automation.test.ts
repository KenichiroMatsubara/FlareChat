import { describe, expect, it } from 'vitest';

import { extractEventCandidate } from './automation';

describe('mail event extraction', () => {
  it('extracts a Japanese date and time range from a mail', () => {
    expect(extractEventCandidate('例会のお知らせ', '日時: 2026年8月3日 19:00〜21:30')).toEqual({
      title: '例会のお知らせ',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:30:00+09:00',
    });
  });

  it('does not invent an event when the mail omits a date or an end time', () => {
    expect(extractEventCandidate('お知らせ', '来週の19時から集まりましょう')).toBeNull();
    expect(extractEventCandidate('お知らせ', '2026/08/03 に集まりましょう')).toBeNull();
  });
});

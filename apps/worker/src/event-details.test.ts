import { describe, expect, it } from 'vitest';

import { validatedEventDetails } from './event-details';

describe('Gemini Event Details validation', () => {
  it('accepts one complete, explicitly timed Event Candidate and rejects unsafe output', () => {
    expect(validatedEventDetails(JSON.stringify({
      title: '例会',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      location: '会館',
      description: '月例会',
    }))).toEqual({
      title: '例会',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      location: '会館',
      description: '月例会',
    });
    expect(validatedEventDetails('{"title":"日時未定"}')).toBeNull();
    expect(validatedEventDetails('not json')).toBeNull();
  });
});

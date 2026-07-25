import { describe, expect, it, vi } from 'vitest';

import { extractGeminiEventDetails, GEMINI_EXTRACTION_MAX_SOURCE_CHARS, validatedEventDetails } from './event-details';

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

  it('uses a bounded Gemini request and accepts only a validated JSON candidate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '月例会' }) }] } }] }), { status: 200 }));

    const result = await extractGeminiEventDetails({ apiKey: 'api-key', model: 'gemini-3.5-flash-lite', source: 'A'.repeat(GEMINI_EXTRACTION_MAX_SOURCE_CHARS + 10), fetch: fetchMock });

    expect(result).toMatchObject({ title: '例会' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('gemini-3.5-flash-lite:generateContent'), expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string) as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(body.contents[0]?.parts[0]?.text.length).toBeLessThanOrEqual(GEMINI_EXTRACTION_MAX_SOURCE_CHARS + 1_000);
  });
});

import { readFile } from 'node:fs/promises';

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
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: {
        responseSchema: {
          required: string[];
          properties: Record<string, { type: string }>;
        };
      };
    };
    expect(body.contents[0]?.parts[0]?.text.length).toBeLessThanOrEqual(GEMINI_EXTRACTION_MAX_SOURCE_CHARS + 1_000);
    expect(body.generationConfig.responseSchema.required).toEqual([
      'title',
      'startsAt',
      'endsAt',
      'timeZone',
      'location',
      'description',
    ]);
    expect(body.generationConfig.responseSchema.properties.location).toEqual({ type: 'STRING' });
  });

  it('reports the upstream Gemini error instead of disguising it as an invalid event', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Unsupported MIME type: text/calendar' },
    }), { status: 400 }));

    await expect(extractGeminiEventDetails({
      apiKey: 'api-key',
      model: 'gemini-3.5-flash-lite',
      source: '案内',
      fetch: fetchMock,
    })).rejects.toThrow('Gemini API: Unsupported MIME type: text/calendar');
  });

  it('passes one PDF attachment body to Gemini with its filename and MIME type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        title: '30周年記念式典',
        startsAt: '2026-09-12T14:00:00+09:00',
        endsAt: '2026-09-12T16:00:00+09:00',
        timeZone: 'Asia/Tokyo',
        location: '名古屋',
        description: '添付PDFから抽出',
      }) }] } }],
    }), { status: 200 }));

    await extractGeminiEventDetails({
      apiKey: 'api-key',
      model: 'gemini-3.5-flash-lite',
      source: '名古屋名城RAC30周年記念式典のご案内',
      attachments: [{
        attachmentId: 'attachment-pdf',
        filename: '式典案内.pdf',
        mimeType: 'application/pdf',
        size: 9,
        data: 'cGRmLWJ5dGVz',
      }],
      fetch: fetchMock,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string) as {
      contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
    };
    expect(body.contents[0]?.parts).toEqual([
      expect.objectContaining({ text: expect.stringContaining('名古屋名城RAC30周年記念式典のご案内') }),
      { text: 'Attachment filename: 式典案内.pdf' },
      { inlineData: { mimeType: 'application/pdf', data: 'cGRmLWJ5dGVz' } },
    ]);
  });

  it('extracts Event Details when the date and times exist only in an XLSX attachment', async () => {
    const workbook = await readFile(new URL('../../../fixtures/gemini-file-probe/event-invitation.xlsx', import.meta.url));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as {
        contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
      };
      const normalizedText = requestBody.contents[0]?.parts.map((part) => part.text ?? '').join('\n') ?? '';
      return normalizedText.includes('GEMINI-FILE-PROBE-001')
        && normalizedText.includes('2026-08-18')
        && normalizedText.includes('14:30')
        && normalizedText.includes('16:00')
        ? new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            title: 'Gemini ファイル解析テスト会議',
            startsAt: '2026-08-18T14:30:00+09:00',
            endsAt: '2026-08-18T16:00:00+09:00',
            timeZone: 'Asia/Tokyo',
            location: '名古屋イノベーションセンター 3階 会議室A',
            description: 'XLSXから抽出',
          }) }] } }],
        }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'Normalized XLSX content was not provided.' } }), { status: 400 });
    });

    const result = await extractGeminiEventDetails({
      apiKey: 'api-key',
      model: 'gemini-3.5-flash-lite',
      source: '日時は添付ファイルをご確認ください。',
      attachments: [{
        attachmentId: 'attachment-xlsx',
        filename: 'event-invitation.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: workbook.byteLength,
        data: workbook.toString('base64'),
      }],
      fetch: fetchMock,
    });

    expect(result).toMatchObject({
      title: 'Gemini ファイル解析テスト会議',
      startsAt: '2026-08-18T14:30:00+09:00',
      endsAt: '2026-08-18T16:00:00+09:00',
    });
  });
});

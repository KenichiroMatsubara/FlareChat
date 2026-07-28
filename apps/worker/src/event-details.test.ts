import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { extractGeminiEventDetails, validatedEventDetails, validatedMailExtraction } from './event-details';

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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '月例会' }) } }] }), { status: 200 }));

    const source = 'A'.repeat(20_010);
    const result = await extractGeminiEventDetails({ apiKey: 'api-key', model: 'gemini-3.5-flash-lite', source, fetch: fetchMock });

    expect(result).toMatchObject({ events: [{ title: '例会' }], tasks: [] });
    expect(fetchMock).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer api-key' }) }));
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: {
        json_schema: {
          schema: {
            required: string[];
            properties: Record<string, { type: string }>;
          };
        };
      };
    };
    expect(body.model).toBe('gemini-3.5-flash-lite');
    expect(body.messages[1]?.content).toContain(source);
    expect(body.response_format.json_schema.schema.required).toEqual(['events', 'tasks']);
    expect(body.response_format.json_schema.schema.properties.events).toMatchObject({ type: 'array' });
    expect(body.messages[0]?.content).toContain('ceremony and its banquet');
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

  it('passes converted PDF text, rather than its source bytes, to Gemini', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: '30周年記念式典',
        startsAt: '2026-09-12T14:00:00+09:00',
        endsAt: '2026-09-12T16:00:00+09:00',
        timeZone: 'Asia/Tokyo',
        location: '名古屋',
        description: '添付PDFから抽出',
      }) } }],
    }), { status: 200 }));

    const markdown = {
      toMarkdown: vi.fn().mockResolvedValue({
        format: 'markdown',
        name: '式典案内.pdf',
        mimetype: 'application/pdf',
        tokens: 24,
        data: '# 30周年記念式典\n日時: 2026-09-12 14:00-16:00\n会場: 名古屋',
      }),
    };

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
      markdown,
    } as Parameters<typeof extractGeminiEventDetails>[0]);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[1]?.content).toContain('名古屋名城RAC30周年記念式典のご案内');
    expect(body.messages[1]?.content).toContain('30周年記念式典');
    expect(JSON.stringify(body)).not.toContain('cGRmLWJ5dGVz');
    expect(markdown.toMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      name: '式典案内.pdf',
      blob: expect.any(Blob),
    }));
  });

  it('does not call Gemini with an attachment omitted after its conversion fails', async () => {
    const fetchMock = vi.fn();
    const markdown = {
      toMarkdown: vi.fn().mockResolvedValue({
        format: 'error' as const,
        name: 'scanned.pdf',
        mimetype: 'application/pdf',
        error: 'Workers AI free allocation exceeded',
      }),
    };

    await expect(extractGeminiEventDetails({
      apiKey: 'api-key',
      model: 'gemini-3.5-flash-lite',
      source: '添付をご確認ください。',
      attachments: [{
        attachmentId: 'scanned-pdf',
        filename: 'scanned.pdf',
        mimeType: 'application/pdf',
        size: 9,
        data: 'cGRmLWJ5dGVz',
      }],
      markdown,
      fetch: fetchMock,
    })).rejects.toThrow('Workers AI free allocation exceeded');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extracts Event Details when the date and times exist only in an XLSX attachment', async () => {
    const workbook = await readFile(new URL('../../../fixtures/gemini-file-probe/event-invitation.xlsx', import.meta.url));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const normalizedText = requestBody.messages[1]?.content ?? '';
      return normalizedText.includes('GEMINI-FILE-PROBE-001')
        && normalizedText.includes('2026-08-18')
        && normalizedText.includes('14:30')
        && normalizedText.includes('16:00')
        ? new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            title: 'Gemini ファイル解析テスト会議',
            startsAt: '2026-08-18T14:30:00+09:00',
            endsAt: '2026-08-18T16:00:00+09:00',
            timeZone: 'Asia/Tokyo',
            location: '名古屋イノベーションセンター 3階 会議室A',
            description: 'XLSXから抽出',
          }) } }],
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
      events: [{
        title: 'Gemini ファイル解析テスト会議',
        startsAt: '2026-08-18T14:30:00+09:00',
        endsAt: '2026-08-18T16:00:00+09:00',
      }],
      tasks: [],
    });
  });

  it('keeps separately scheduled programs apart and creates one deadline task per kind', () => {
    expect(validatedMailExtraction(JSON.stringify({
      events: [
        { title: '30周年記念式典', startsAt: '2026-05-30T13:00:00+09:00', endsAt: '2026-05-30T16:00:00+09:00', timeZone: 'Asia/Tokyo', location: 'ホテル名古屋ガーデンパレス', description: '記念式典' },
        { title: '30周年記念祝宴', startsAt: '2026-05-30T17:30:00+09:00', endsAt: '2026-05-30T19:30:00+09:00', timeZone: 'Asia/Tokyo', location: 'スノーピークカフェ', description: '祝宴' },
      ],
      tasks: [
        { title: '出席登録を完了する', deadline: '2026-05-10', assigneeRole: 'organizer', description: '登録用紙を返信する' },
        { title: '参加費を振り込む', deadline: '2026-05-15', assigneeRole: 'treasurer', description: '指定口座へ振込する' },
      ],
    }))).toMatchObject({
      events: [{ title: '30周年記念式典' }, { title: '30周年記念祝宴' }],
      tasks: [{ assigneeRole: 'organizer' }, { assigneeRole: 'treasurer' }],
    });
  });
});

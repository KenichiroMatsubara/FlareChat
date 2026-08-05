import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { buildAiEventDetailsRequest, extractAiEventDetails, validatedEventDetails, validatedMailExtraction } from './event-details';

describe('OpenAI-compatible Event Details validation', () => {
  it('builds the task role enum and semantic guidance from the roles allowed by the Organization Rule', async () => {
    const request = await buildAiEventDetailsRequest({
      source: '案内',
      taskRoles: [
        { id: 'role-registration', displayName: '参加登録担当', description: '出欠と申込期限を扱う' },
        { id: 'role-payment', displayName: '支払担当', description: '請求と支払期限を扱う' },
      ],
    });
    const taskSchema = request.response_format.json_schema.schema.properties?.tasks?.items;

    expect(taskSchema?.properties?.assigneeRoleId?.enum).toEqual([
      'role-registration',
      'role-payment',
      'unassigned',
    ]);
    expect(request.messages[0]?.content).toContain('role-registration: 参加登録担当 — 出欠と申込期限を扱う');
    expect(request.messages[0]?.content).toContain('role-payment: 支払担当 — 請求と支払期限を扱う');
    expect(request.messages[0]?.content).toContain('unassigned');
  });

  it('states the received date as a trusted system fact and authorizes only year completion', async () => {
    const request = await buildAiEventDetailsRequest({
      source: '登録締切は4月30日です。',
      receivedAt: '2026-04-07T09:12:00+09:00',
    });

    expect(request.messages[0]?.content).toContain('Verified delivery facts (trusted, provided by this system):');
    expect(request.messages[0]?.content).toContain('{"receivedAt":"2026-04-07T09:12:00+09:00","timeZone":"Asia/Tokyo"}');
    expect(request.messages[0]?.content).toContain('Completing an omitted year is the only permitted date completion.');
    expect(request.messages[0]?.content).toContain('When a month or a day is absent, omit the event or task instead');
    expect(request.messages[1]?.content).not.toContain('receivedAt');
  });

  it('withholds the year completion rule when no received date is known', async () => {
    const request = await buildAiEventDetailsRequest({ source: '登録締切は4月30日です。' });

    expect(request.messages[0]?.content).not.toContain('Verified delivery facts');
    expect(request.messages[0]?.content).not.toContain('receivedAt');
    expect(request.messages[0]?.content).toContain('Do not complete a date that omits its year');
  });

  it('keeps the extraction and falls back only an unknown task role to unassigned with a warning', () => {
    const extraction = validatedMailExtraction(JSON.stringify({
      summary: '年次行事と二つの期限の案内です。',
      events: [{
        title: '年次行事', startsAt: '2026-09-01T10:00:00+09:00', endsAt: '2026-09-01T12:00:00+09:00',
        timeZone: 'Asia/Tokyo', location: '会館', description: '年次行事',
      }],
      tasks: [
        { title: '登録する', deadline: '2026-08-20', assigneeRoleId: 'role-registration', description: '参加登録を行う' },
        { title: '資料を確認する', deadline: '2026-08-25', assigneeRoleId: 'role-removed', description: '資料を確認する' },
      ],
    }), [{ id: 'role-registration', displayName: '参加登録担当', description: '申込期限を扱う' }]);

    expect(extraction).toMatchObject({
      summary: '年次行事と二つの期限の案内です。',
      events: [{ title: '年次行事' }],
      tasks: [
        { title: '登録する', assigneeRoleId: 'role-registration' },
        { title: '資料を確認する', assigneeRoleId: 'unassigned' },
      ],
      warnings: [{ code: 'task_role_unmatched', requestedRoleId: 'role-removed' }],
    });
  });

  it('accepts one complete, explicitly timed Event Candidate and rejects unsafe output', () => {
    expect(validatedEventDetails(JSON.stringify({
      title: '例会',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      location: '会館',
      description: '月例会',
      summary: '毎月の例会です。会費は当日徴収します。',
    }))).toEqual({
      title: '例会',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      location: '会館',
      description: '月例会',
      summary: '毎月の例会です。会費は当日徴収します。',
    });
    expect(validatedEventDetails('{"title":"日時未定"}')).toBeNull();
    expect(validatedEventDetails('not json')).toBeNull();
  });

  it('falls back to the event description when an extraction omits the Event Summary', () => {
    expect(validatedEventDetails(JSON.stringify({
      title: '例会',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      location: '会館',
      description: '月例会',
    }))).toMatchObject({ summary: '月例会' });
    expect(validatedEventDetails(JSON.stringify({
      title: '例会',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      location: '会館',
      description: '',
      summary: '   ',
    }))).toMatchObject({ summary: '例会' });
    expect(validatedEventDetails(JSON.stringify({
      title: '例会',
      startsAt: '2026-08-03T19:00:00+09:00',
      endsAt: '2026-08-03T21:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      location: '会館',
      description: '月例会',
      summary: 42,
    }))).toBeNull();
  });

  it('requires an Event Summary for every event in the extraction schema', async () => {
    const request = await buildAiEventDetailsRequest({ source: '例会のご案内' });
    const eventSchema = request.response_format.json_schema.schema.properties?.events?.items;

    expect(eventSchema?.required).toEqual(['title', 'startsAt', 'endsAt', 'timeZone', 'location', 'description', 'summary']);
    expect(eventSchema?.properties?.summary).toMatchObject({ type: 'string', maxLength: 1000 });
    expect(request.messages[0]?.content).toContain("Write each event's summary");
  });

  it('reads an Event Response and the guests its registration named', () => {
    expect(validatedMailExtraction(JSON.stringify({
      kind: 'response',
      summary: '北クラブから2名の参加申込がありました。',
      events: [{
        title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00',
        timeZone: 'Asia/Tokyo', location: '本部会館', description: '例会です。', summary: '毎月の例会です。',
      }],
      tasks: [],
      guests: [
        { name: '山田太郎', affiliation: '北クラブ', attending: true },
        { name: '鈴木花子', affiliation: '北クラブ', attending: false },
      ],
    }))).toMatchObject({
      kind: 'response',
      guests: [
        { name: '山田太郎', affiliation: '北クラブ', attending: true },
        { name: '鈴木花子', affiliation: '北クラブ', attending: false },
      ],
    });
  });

  it('rejects a guest that names nobody rather than counting a blank', () => {
    expect(validatedMailExtraction(JSON.stringify({
      kind: 'response', summary: '参加申込です。', events: [], tasks: [],
      guests: [{ name: '  ', affiliation: '北クラブ', attending: true }],
    }))).toBeNull();
  });

  it('reads an extraction written before the kind existed as an invitation', () => {
    expect(validatedMailExtraction(JSON.stringify({
      summary: 'お知らせです。', events: [], tasks: [],
    }))).toMatchObject({ kind: 'invitation', guests: [] });
  });

  it('tells the extraction to judge the sender rather than the quoted text', async () => {
    const request = await buildAiEventDetailsRequest({ source: '件名: Re: 例会のご案内\nOKです' });

    expect(request.messages[0]?.content).toContain('First decide kind');
    expect(request.messages[0]?.content).toContain('Quoted text from an earlier email never makes the reply an invitation');
    expect(request.response_format.json_schema.schema.properties?.kind)
      .toMatchObject({ type: 'string', enum: ['invitation', 'response'] });
  });

  it('retains a Message Summary when extraction produces no Event Candidate', () => {
    expect(validatedMailExtraction(JSON.stringify({
      summary: '次年度の活動方針を共有するお知らせです。',
      events: [],
      tasks: [],
    }))).toEqual({
      kind: 'invitation',
      summary: '次年度の活動方針を共有するお知らせです。',
      events: [],
      tasks: [],
      guests: [],
      warnings: [],
    });
  });

  it('uses a bounded OpenAI-compatible request and accepts only a validated JSON candidate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00', timeZone: 'Asia/Tokyo', location: '', description: '月例会' }) } }] }), { status: 200 }));

    const source = 'A'.repeat(20_010);
    const result = await extractAiEventDetails({ baseUrl: 'https://ai.example.com/v1', apiKey: 'api-key', model: 'test-model', source, fetch: fetchMock });

    expect(result).toMatchObject({ summary: '月例会', events: [{ title: '例会' }], tasks: [] });
    expect(fetchMock).toHaveBeenCalledWith('https://ai.example.com/v1/chat/completions', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer api-key' }) }));
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: {
        json_schema: {
          schema: {
            required: string[];
            additionalProperties: boolean;
            properties: Record<string, { type: string }>;
          };
        };
      };
    };
    expect(body.model).toBe('test-model');
    expect(body.messages[1]?.content).toContain(source);
    expect(body.response_format.json_schema.schema.required).toEqual(['kind', 'summary', 'guests', 'events', 'tasks']);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.response_format.json_schema.schema.properties.summary).toMatchObject({ type: 'string' });
    expect(body.response_format.json_schema.schema.properties.events).toMatchObject({ type: 'array' });
    expect(body.messages[0]?.content).toContain('concise Japanese plain-text summary');
    expect(body.messages[0]?.content).toContain('ceremony and its banquet');
  });

  it('reports the upstream AI API error instead of disguising it as an invalid event', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Unsupported MIME type: text/calendar' },
    }), { status: 400 }));

    await expect(extractAiEventDetails({
      baseUrl: 'https://ai.example.com/v1', apiKey: 'api-key',
      model: 'test-model',
      source: '案内',
      fetch: fetchMock,
    })).rejects.toThrow('OpenAI 互換 API: Unsupported MIME type: text/calendar');
  });

  it('passes converted PDF text, rather than its source bytes, to the AI API', async () => {
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

    await extractAiEventDetails({
      baseUrl: 'https://ai.example.com/v1', apiKey: 'api-key',
      model: 'test-model',
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
    } as Parameters<typeof extractAiEventDetails>[0]);

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[1]?.content).toContain('名古屋名城RAC30周年記念式典のご案内');
    expect(body.messages[1]?.content).toContain('30周年記念式典');
    expect(JSON.stringify(body)).not.toContain('cGRmLWJ5dGVz');
    expect(markdown.toMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      name: '式典案内.pdf',
      blob: expect.any(Blob),
    }), { conversionOptions: { pdf: { metadata: false } } });
  });

  it('does not call the AI API with an attachment omitted after its conversion fails', async () => {
    const fetchMock = vi.fn();
    const markdown = {
      toMarkdown: vi.fn().mockResolvedValue({
        format: 'error' as const,
        name: 'scanned.pdf',
        mimetype: 'application/pdf',
        error: 'Workers AI free allocation exceeded',
      }),
    };

    await expect(extractAiEventDetails({
      baseUrl: 'https://ai.example.com/v1', apiKey: 'api-key',
      model: 'test-model',
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
    const workbook = await readFile(new URL('../../../fixtures/ai-file-probe/event-invitation.xlsx', import.meta.url));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const normalizedText = requestBody.messages[1]?.content ?? '';
      return normalizedText.includes('FILE-PROBE-001')
        && normalizedText.includes('2026-08-18')
        && normalizedText.includes('14:30')
        && normalizedText.includes('16:00')
        ? new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            title: 'AI ファイル解析テスト会議',
            startsAt: '2026-08-18T14:30:00+09:00',
            endsAt: '2026-08-18T16:00:00+09:00',
            timeZone: 'Asia/Tokyo',
            location: '名古屋イノベーションセンター 3階 会議室A',
            description: 'XLSXから抽出',
          }) } }],
        }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'Normalized XLSX content was not provided.' } }), { status: 400 });
    });

    const result = await extractAiEventDetails({
      baseUrl: 'https://ai.example.com/v1', apiKey: 'api-key',
      model: 'test-model',
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
        title: 'AI ファイル解析テスト会議',
        startsAt: '2026-08-18T14:30:00+09:00',
        endsAt: '2026-08-18T16:00:00+09:00',
      }],
      tasks: [],
    });
  });

  it('keeps separately scheduled programs apart and creates one deadline task per kind', () => {
    expect(validatedMailExtraction(JSON.stringify({
      summary: '30周年記念式典と祝宴の案内です。出席登録と参加費振込が必要です。',
      events: [
        { title: '30周年記念式典', startsAt: '2026-05-30T13:00:00+09:00', endsAt: '2026-05-30T16:00:00+09:00', timeZone: 'Asia/Tokyo', location: 'ホテル名古屋ガーデンパレス', description: '記念式典' },
        { title: '30周年記念祝宴', startsAt: '2026-05-30T17:30:00+09:00', endsAt: '2026-05-30T19:30:00+09:00', timeZone: 'Asia/Tokyo', location: 'スノーピークカフェ', description: '祝宴' },
      ],
      tasks: [
        { title: '出席登録を完了する', deadline: '2026-05-10', assigneeRoleId: 'role-registration', description: '登録用紙を返信する' },
        { title: '参加費を振り込む', deadline: '2026-05-15', assigneeRoleId: 'role-payment', description: '指定口座へ振込する' },
      ],
    }), [
      { id: 'role-registration', displayName: '参加登録担当', description: '参加登録を扱う' },
      { id: 'role-payment', displayName: '支払担当', description: '支払を扱う' },
    ])).toMatchObject({
      summary: '30周年記念式典と祝宴の案内です。出席登録と参加費振込が必要です。',
      events: [{ title: '30周年記念式典' }, { title: '30周年記念祝宴' }],
      tasks: [{ assigneeRoleId: 'role-registration' }, { assigneeRoleId: 'role-payment' }],
    });
  });
});

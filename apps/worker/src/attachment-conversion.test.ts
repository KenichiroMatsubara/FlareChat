import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  convertAttachmentsForEventExtraction,
} from './attachment-conversion';

describe('attachment conversion for Event Details', () => {
  it('preserves Workers AI Markdown even when it contains no event-looking words', async () => {
    const workbook = await readFile(new URL('../../../fixtures/ai-file-probe/event-invitation.xlsx', import.meta.url));
    const markdown = {
      toMarkdown: vi.fn().mockResolvedValue({
        format: 'markdown',
        name: 'event-invitation.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        tokens: 4,
        data: '# Workbook summary\n\nRows: 16',
      }),
    };

    const [converted] = await convertAttachmentsForEventExtraction([{
      attachmentId: 'attachment-xlsx',
      filename: 'event-invitation.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: workbook.byteLength,
      data: workbook.toString('base64'),
    }], markdown);

    expect(converted).toMatchObject({ converter: 'workers_ai', text: '# Workbook summary\n\nRows: 16' });
  });

  it('compacts Workers AI XLSX tables to TSV before the mail flow uses them', async () => {
    const source = [
      '# FILE-PROBE-001',
      '',
      '| __EMPTY_1 | Event date  | Time        | Venue                    | __EMPTY_2 |',
      '| ----------- | ----------- | ----------- | ------------------------ | --------- |',
      '|             | 2026-08-18  | 14:30-16:00 | 名古屋\\|イノベーションセンター |           |',
      '|             |             |             |                          |           |',
    ].join('\n');
    const [converted] = await convertAttachmentsForEventExtraction([{
      attachmentId: 'attachment-xlsx',
      filename: 'event-invitation.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 3,
      data: 'eGxzeA==',
    }], { toMarkdown: vi.fn().mockResolvedValue({
      format: 'markdown', name: 'event-invitation.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', tokens: 200, data: source,
    }) });

    expect(converted).toMatchObject({
      converter: 'workers_ai',
      tokens: 200,
      text: '# FILE-PROBE-001\n\nEvent date\tTime\tVenue\n2026-08-18\t14:30-16:00\t名古屋\\|イノベーションセンター',
    });
    expect(converted?.selectedTokens).toBeLessThan(200);
  });

  it('passes all Workers AI Markdown without a shared token budget or truncation', async () => {
    const markdown = {
      toMarkdown: vi.fn(async (document: { name: string }) => ({
        format: 'markdown' as const,
        name: document.name,
        mimetype: 'application/pdf',
        tokens: 3_000,
        data: `# ${document.name}\n日時: 2026-08-18 14:30\n${'詳細 '.repeat(5_000)}`,
      })),
    };

    const converted = await convertAttachmentsForEventExtraction([
      { attachmentId: 'first', filename: 'first.pdf', mimeType: 'application/pdf', size: 3, data: 'cGRm' },
      { attachmentId: 'second', filename: 'second.pdf', mimeType: 'application/pdf', size: 3, data: 'cGRm' },
    ], markdown);

    expect(converted.reduce((total, attachment) => total + attachment.selectedTokens, 0)).toBe(6_000);
    expect(converted.map((attachment) => attachment.text)).toEqual([
      expect.stringContaining('詳細 詳細 詳細'),
      expect.stringContaining('詳細 詳細 詳細'),
    ]);
  });

  it('retains registration and payment deadlines that are separated from event details', async () => {
    const source = [
      '日時: 2026年5月30日 13:00-16:00',
      '会場: ホテル名古屋ガーデンパレス',
      '祝宴は別紙をご確認ください。',
      '振込先: 三菱UFJ銀行 名古屋駅前支店',
      '振込期限: 2026年5月15日（金）まで',
      '登録締切: 2026年4月30日（木）',
    ].join('\n\n');
    const [converted] = await convertAttachmentsForEventExtraction([{
      attachmentId: 'deadline-pdf', filename: '案内.pdf', mimeType: 'application/pdf', size: 3, data: 'cGRm',
    }], { toMarkdown: vi.fn().mockResolvedValue({ format: 'markdown', name: '案内.pdf', mimetype: 'application/pdf', tokens: 100, data: source }) });

    expect(converted?.text).toContain('振込期限: 2026年5月15日（金）まで');
    expect(converted?.text).toContain('登録締切: 2026年4月30日（木）');
  });
});

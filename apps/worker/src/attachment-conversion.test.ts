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

    const contents = `日時: 2026-08-18 14:30\n${'詳細 '.repeat(5_000)}`.trim();
    expect(converted.map((attachment) => attachment.text)).toEqual([contents, contents]);
    expect(converted.map((attachment) => attachment.tokens)).toEqual([3_000, 3_000]);
    expect(converted.map((attachment) => attachment.selectedTokens)).toEqual([
      Math.ceil(contents.length / 4),
      Math.ceil(contents.length / 4),
    ]);
  });

  it('asks Workers AI to omit PDF metadata and drops it when the option is ignored', async () => {
    const source = [
      '# 案内.pdf',
      '## Metadata',
      '- PDFFormatVersion=1.7',
      '- Author=example author',
      "- CreationDate=D:20260406221551+09'00'",
      '- xmpmm:documentid=uuid:00000000-0000-4000-8000-000000000001',
      '',
      '',
      '## Contents',
      '### Page 1',
      '',
      '',
      '日時: 2026年5月30日 13:00-16:00',
    ].join('\n');
    const toMarkdown = vi.fn().mockResolvedValue({
      format: 'markdown', name: '案内.pdf', mimetype: 'application/pdf', tokens: 300, data: source,
    });

    const [converted] = await convertAttachmentsForEventExtraction([{
      attachmentId: 'metadata-pdf', filename: '案内.pdf', mimeType: 'application/pdf', size: 3, data: 'cGRm',
    }], { toMarkdown });

    expect(toMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ name: '案内.pdf' }),
      { conversionOptions: { pdf: { metadata: false } } },
    );
    expect(converted?.text).toBe('### Page 1\n\n日時: 2026年5月30日 13:00-16:00');
    expect(converted?.text).not.toContain('CreationDate');
    expect(converted?.text).not.toContain('uuid:');
    expect(converted?.tokens).toBe(300);
    expect(converted?.selectedTokens).toBe(Math.ceil((converted?.text.length ?? 0) / 4));
  });

  it('removes the same conversion by-products from the local Office fallback', async () => {
    const workbook = await readFile(new URL('../../../fixtures/ai-file-probe/event-invitation.xlsx', import.meta.url));

    const [converted] = await convertAttachmentsForEventExtraction([{
      attachmentId: 'attachment-xlsx',
      filename: 'event-invitation.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: workbook.byteLength,
      data: workbook.toString('base64'),
    }], { toMarkdown: vi.fn().mockResolvedValue({ format: 'error', name: 'event-invitation.xlsx', mimetype: '', error: 'unavailable' }) });

    expect(converted?.converter).toBe('local_office');
    expect(converted?.text.startsWith('# event-invitation.xlsx')).toBe(false);
    expect(converted?.text).not.toMatch(/\n{3}/u);
    expect(converted?.selectedTokens).toBe(Math.ceil((converted?.text.length ?? 0) / 4));
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

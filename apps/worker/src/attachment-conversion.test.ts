import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  convertAttachmentsForEventExtraction,
  MAX_EVENT_EXTRACTION_ATTACHMENT_TOKENS,
} from './attachment-conversion';

describe('attachment conversion for Event Details', () => {
  it('falls back to local XLSX normalization when Markdown omits event-bearing content', async () => {
    const workbook = await readFile(new URL('../../../fixtures/gemini-file-probe/event-invitation.xlsx', import.meta.url));
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

    expect(converted).toMatchObject({ converter: 'local_office' });
    expect(converted?.text).toContain('B7 [date] value=2026-08-18');
    expect(converted?.text).toContain('B11 [string] value=名古屋イノベーションセンター 3階 会議室A');
  });

  it('keeps all converted attachments within one Gemini input-token budget', async () => {
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

    expect(converted.reduce((total, attachment) => total + attachment.selectedTokens, 0))
      .toBeLessThanOrEqual(MAX_EVENT_EXTRACTION_ATTACHMENT_TOKENS);
    expect(converted.map((attachment) => attachment.text)).toEqual([
      expect.stringContaining('日時: 2026-08-18'),
      expect.stringContaining('日時: 2026-08-18'),
    ]);
  });
});

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import * as XLSX from 'xlsx';

import {
  MAX_NORMALIZED_ATTACHMENT_TEXT_CHARS,
  MAX_OFFICE_ARCHIVE_EXPANDED_BYTES,
  MAX_SPREADSHEET_CELLS,
  MAX_SPREADSHEET_SHEETS,
  normalizeAttachments,
} from './normalization';

describe('attachment normalization', () => {
  it('preserves XLSX sheet names, cell references, typed values, and formulas', async () => {
    const workbook = await readFile(new URL('../../../fixtures/ai-file-probe/event-invitation.xlsx', import.meta.url));

    const [normalized] = normalizeAttachments([{
      attachmentId: 'attachment-xlsx',
      filename: 'event-invitation.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: workbook.byteLength,
      data: workbook.toString('base64'),
    }]);

    expect(normalized).toMatchObject({
      kind: 'text',
      filename: 'event-invitation.xlsx',
      originalMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(normalized?.kind === 'text' ? normalized.text : '').toEqual(expect.stringContaining(
      'Sheet: Event',
    ));
    expect(normalized?.kind === 'text' ? normalized.text : '').toEqual(expect.stringContaining(
      'B16 [number] formula=(B9-B8)*1440 value=90',
    ));
  });

  it('reports a damaged Office attachment as an actionable normalization error', () => {
    expect(() => normalizeAttachments([{
      attachmentId: 'attachment-docx',
      filename: 'broken.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 7,
      data: btoa('not zip'),
    }])).toThrow(
      '添付ファイル「broken.docx」を読み取れませんでした。ファイルが破損しているか、対応していない形式です。',
    );
  });

  it('preserves DOCX body, table, header, and footer text', async () => {
    const document = await readFile(new URL('../../../fixtures/ai-file-probe/event-invitation.docx', import.meta.url));

    const [normalized] = normalizeAttachments([{
      attachmentId: 'attachment-docx',
      filename: 'event-invitation.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: document.byteLength,
      data: document.toString('base64'),
    }]);
    const text = normalized?.kind === 'text' ? normalized.text : '';

    expect(text).toContain('word/document.xml');
    expect(text).toContain('FILE-PROBE-001');
    expect(text).toContain('word/header1.xml');
    expect(text).toContain('FILE ANALYSIS PROBE');
    expect(text).toContain('word/footer1.xml');
    expect(text).toContain('Synthetic test document - no personal data');
  });

  it('keeps PDF and image bytes as provider-neutral inline inputs', () => {
    expect(normalizeAttachments([
      {
        attachmentId: 'attachment-pdf',
        filename: 'event.pdf',
        mimeType: 'application/pdf',
        size: 3,
        data: 'cGRm',
      },
      {
        attachmentId: 'attachment-image',
        filename: 'event.png',
        mimeType: 'image/png',
        size: 3,
        data: 'cG5n',
      },
    ])).toEqual([
      {
        kind: 'inline',
        filename: 'event.pdf',
        originalMimeType: 'application/pdf',
        data: 'cGRm',
      },
      {
        kind: 'inline',
        filename: 'event.png',
        originalMimeType: 'image/png',
        data: 'cG5n',
      },
    ]);
  });

  it('rejects a workbook that exceeds the worksheet normalization limit', () => {
    const workbook = XLSX.utils.book_new();
    for (let index = 0; index <= MAX_SPREADSHEET_SHEETS; index += 1) {
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([['value']]),
        `Sheet ${index + 1}`,
      );
    }
    const data = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' }) as string;

    expect(() => normalizeAttachments([{
      attachmentId: 'attachment-xlsx',
      filename: 'many-sheets.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: Math.ceil(data.length * 0.75),
      data,
    }])).toThrow(
      `many-sheets.xlsx のシート数が上限（${MAX_SPREADSHEET_SHEETS}）を超えています。`,
    );
  });

  it('rejects a workbook that exceeds the cell normalization limit', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(Array.from(
        { length: MAX_SPREADSHEET_CELLS + 1 },
        (_, index) => [index],
      )),
      'Event',
    );
    const data = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' }) as string;

    expect(() => normalizeAttachments([{
      attachmentId: 'attachment-xlsx',
      filename: 'many-cells.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: Math.ceil(data.length * 0.75),
      data,
    }])).toThrow(
      `many-cells.xlsx のセル数が上限（${MAX_SPREADSHEET_CELLS}）を超えています。`,
    );
  });

  it('bounds the combined normalized text across Office attachments', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['A'.repeat(26_000)]]),
      'Event',
    );
    const data = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' }) as string;
    const attachment = {
      attachmentId: 'attachment-xlsx',
      filename: 'large.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: Math.ceil(data.length * 0.75),
      data,
    };

    expect(() => normalizeAttachments([
      attachment,
      { ...attachment, attachmentId: 'attachment-xlsx-2', filename: 'large-2.xlsx' },
    ])).toThrow(
      `添付ファイルの正規化結果の合計が上限（${MAX_NORMALIZED_ATTACHMENT_TEXT_CHARS}文字）を超えています。`,
    );
  });

  it('rejects an Office archive before an unsafe amount of data is expanded', () => {
    const archive = zipSync({
      'word/document.xml': strToU8('A'.repeat(MAX_OFFICE_ARCHIVE_EXPANDED_BYTES + 1)),
    });

    expect(() => normalizeAttachments([{
      attachmentId: 'attachment-docx',
      filename: 'expanded.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: archive.byteLength,
      data: Buffer.from(archive).toString('base64'),
    }])).toThrow(
      `expanded.docx の展開後サイズが上限（${MAX_OFFICE_ARCHIVE_EXPANDED_BYTES}バイト）を超えています。`,
    );
  });
});

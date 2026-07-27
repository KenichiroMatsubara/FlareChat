import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import * as XLSX from 'xlsx';

export const MAX_NORMALIZED_ATTACHMENT_TEXT_CHARS = 50_000;
export const MAX_OFFICE_ARCHIVE_EXPANDED_BYTES = 2 * 1024 * 1024;
export const MAX_SPREADSHEET_CELLS = 10_000;
export const MAX_SPREADSHEET_SHEETS = 20;

export interface AttachmentContent {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  data: string;
}

export type NormalizedAttachment =
  | {
    kind: 'inline';
    filename: string;
    originalMimeType: string;
    data: string;
  }
  | {
    kind: 'text';
    filename: string;
    originalMimeType: string;
    text: string;
  };

const spreadsheetMimeTypes = new Set([
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const archivedSpreadsheetMimeTypes = new Set([
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const wordMimeTypes = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const base64Bytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error('Attachment data is not valid base64.');
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
};

const assertBoundedArchive = (
  bytes: Uint8Array,
  filename: string,
  relevant: (name: string) => boolean,
): void => {
  let expandedBytes = 0;
  unzipSync(bytes, {
    filter: ({ name, originalSize }) => {
      if (!relevant(name)) return false;
      expandedBytes += originalSize;
      if (expandedBytes > MAX_OFFICE_ARCHIVE_EXPANDED_BYTES) {
        throw new Error(
          `${filename} の展開後サイズが上限（${MAX_OFFICE_ARCHIVE_EXPANDED_BYTES}バイト）を超えています。`,
        );
      }
      return false;
    },
  });
};

type XmlNode = Record<string, unknown>;

const renderedXml = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(renderedXml).join('');
  if (!node || typeof node !== 'object') return '';
  const xmlNode = node as XmlNode;
  if (typeof xmlNode['#text'] === 'string') return xmlNode['#text'];

  return Object.entries(xmlNode)
    .filter(([name]) => name !== ':@')
    .map(([name, children]) => {
      const text = renderedXml(children);
      switch (name.split(':').at(-1)) {
        case 'tab':
          return '\t';
        case 'br':
        case 'cr':
          return '\n';
        case 'p':
          return `${text.trim()}\n`;
        case 'tc':
          return `${text.replace(/\s+/gu, ' ').trim()}\t`;
        case 'tr':
          return `${text.trimEnd()}\n`;
        case 'tbl':
          return `${text.trim()}\n`;
        default:
          return text;
      }
    })
    .join('');
};

const normalizeWordDocument = (attachment: AttachmentContent): NormalizedAttachment => {
  const bytes = base64Bytes(attachment.data);
  const relevant = (name: string): boolean =>
    /^word\/(?:document|header\d+|footer\d+)\.xml$/u.test(name);
  assertBoundedArchive(bytes, attachment.filename, relevant);
  const files = unzipSync(bytes, {
    filter: ({ name }) => relevant(name),
  });
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false });
  const sectionOrder = (name: string): number =>
    name.includes('/header') ? 0 : name.includes('/document') ? 1 : 2;
  const sections = Object.entries(files)
    .sort(([first], [second]) =>
      sectionOrder(first) - sectionOrder(second) || first.localeCompare(second))
    .map(([name, contents]) => {
      const text = renderedXml(parser.parse(strFromU8(contents))).trim();
      return text ? `${name}\n${text}` : '';
    })
    .filter(Boolean);
  const text = sections.join('\n\n');
  if (!text) throw new Error(`${attachment.filename} から文書内容を読み取れませんでした。`);
  if (text.length > MAX_NORMALIZED_ATTACHMENT_TEXT_CHARS) {
    throw new Error(`${attachment.filename} の正規化結果が上限を超えています。`);
  }
  return {
    kind: 'text',
    filename: attachment.filename,
    originalMimeType: attachment.mimeType,
    text,
  };
};

const normalizeSpreadsheet = (attachment: AttachmentContent): NormalizedAttachment => {
  const bytes = base64Bytes(attachment.data);
  if (archivedSpreadsheetMimeTypes.has(attachment.mimeType.toLowerCase())) {
    assertBoundedArchive(
      bytes,
      attachment.filename,
      (name) => /^(?:xl\/(?:workbook|sharedStrings|styles)\.xml|xl\/worksheets\/.+\.xml|content\.xml|styles\.xml)$/u.test(name),
    );
  }
  const workbook = XLSX.read(bytes, { cellDates: true, cellFormula: true });
  if (workbook.SheetNames.length > MAX_SPREADSHEET_SHEETS) {
    throw new Error(
      `${attachment.filename} のシート数が上限（${MAX_SPREADSHEET_SHEETS}）を超えています。`,
    );
  }
  let cellCount = 0;
  const text = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const cellEntries = Object.entries(sheet ?? {})
      .filter(([address]) => !address.startsWith('!'));
    cellCount += cellEntries.length;
    if (cellCount > MAX_SPREADSHEET_CELLS) {
      throw new Error(
        `${attachment.filename} のセル数が上限（${MAX_SPREADSHEET_CELLS}）を超えています。`,
      );
    }
    const cells = cellEntries
      .sort(([first], [second]) => {
        const firstCell = XLSX.utils.decode_cell(first);
        const secondCell = XLSX.utils.decode_cell(second);
        return firstCell.r - secondCell.r || firstCell.c - secondCell.c;
      })
      .map(([address, cellValue]) => {
        const cell = cellValue as XLSX.CellObject;
        const type = cell.t === 'n'
          ? 'number'
          : cell.t === 'd'
            ? 'date'
            : cell.t === 'b'
              ? 'boolean'
              : cell.t === 'e'
                ? 'error'
                : 'string';
        const formula = cell.f ? ` formula=${cell.f}` : '';
        const value = cell.w ?? String(cell.v ?? '');
        return `${address} [${type}]${formula} value=${value}`;
      });
    return `Sheet: ${sheetName}\n${cells.join('\n')}`;
  }).join('\n\n').trim();
  if (!text) throw new Error(`${attachment.filename} からセル内容を読み取れませんでした。`);
  if (text.length > MAX_NORMALIZED_ATTACHMENT_TEXT_CHARS) {
    throw new Error(`${attachment.filename} の正規化結果が上限を超えています。`);
  }
  return {
    kind: 'text',
    filename: attachment.filename,
    originalMimeType: attachment.mimeType,
    text,
  };
};

const safelyNormalizeOfficeAttachment = (
  attachment: AttachmentContent,
  normalize: (value: AttachmentContent) => NormalizedAttachment,
): NormalizedAttachment => {
  try {
    return normalize(attachment);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${attachment.filename} `)) throw error;
    throw new Error(
      `添付ファイル「${attachment.filename}」を読み取れませんでした。ファイルが破損しているか、対応していない形式です。`,
    );
  }
};

/** Converts accepted Source Message attachments into provider-neutral extraction representations. */
export const normalizeAttachments = (attachments: AttachmentContent[]): NormalizedAttachment[] => {
  const normalized = attachments.map<NormalizedAttachment>((attachment) => {
    const mimeType = attachment.mimeType.toLowerCase();
    if (spreadsheetMimeTypes.has(mimeType)) {
      return safelyNormalizeOfficeAttachment(attachment, normalizeSpreadsheet);
    }
    if (wordMimeTypes.has(mimeType)) {
      return safelyNormalizeOfficeAttachment(attachment, normalizeWordDocument);
    }
    return {
      kind: 'inline',
      filename: attachment.filename,
      originalMimeType: attachment.mimeType,
      data: attachment.data,
    };
  });
  const textChars = normalized.reduce(
    (total, attachment) => total + (attachment.kind === 'text' ? attachment.text.length : 0),
    0,
  );
  if (textChars > MAX_NORMALIZED_ATTACHMENT_TEXT_CHARS) {
    throw new Error(
      `添付ファイルの正規化結果の合計が上限（${MAX_NORMALIZED_ATTACHMENT_TEXT_CHARS}文字）を超えています。`,
    );
  }
  return normalized;
};
